import type { INestApplication } from '@nestjs/common';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ControlPlaneRegistryService,
  SHARED_DATABASE_SCHEMA_VERSION,
  type ExistingSpaceSeed,
} from '../../../src/modules/control-plane/control-plane.service';
import { UsersService } from '../../../src/modules/users/users.service';
import { createTestApp } from '../../support/identity-access-helpers';

/**
 * Ca tích hợp của CONTROL PLANE (issue #580): sổ đăng ký không gian,
 * registry phiên bản schema và tách quyền kết nối giữa hai database.
 *
 * Môi trường của ca tự cấp phát như đường triển khai thật: một
 * database control plane MỚI (`lms_test_cp_580`) trên cùng cụm với
 * database nghiệp vụ test, một role kết nối riêng chỉ có quyền trên
 * database đó, bộ migration riêng của control plane áp từ rỗng bằng
 * chính file SQL đã sinh, rồi mới khởi động ứng dụng với
 * `CONTROL_PLANE_DATABASE_URL` trỏ vào đó — để cả đường gieo dữ kiện
 * lúc bootstrap cũng được kiểm chứng trên cùng một lượt chạy.
 *
 * Shim `uuidv7()` chỉ áp khi server PostgreSQL dưới 18 (môi trường
 * chạy local bằng PG16): PG18 — bản ở CI và production — có sẵn hàm
 * này, shim sẽ che mất hàm gốc nên tuyệt đối không áp ở đó.
 */
const CP_DATABASE = 'lms_test_cp_580';
const CP_ROLE = 'lms_cp_test_580';
const CP_PASSWORD = 'cp-test-580';
const BIZ_ROLE = 'lms_biz_test_580';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database nghiệp vụ test. */
function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
    }
    for (const folder of folders) {
      const sql = readFileSync(join(outDir, folder, 'migration.sql'), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await client.query(trimmed);
      }
    }
  });
}

describe('Control plane: sổ đăng ký không gian và registry phiên bản schema (integration)', () => {
  let app: INestApplication;
  let registry: ControlPlaneRegistryService;
  let adminId: string;
  let guestId: string;
  let createdSpaceId: string;

  beforeAll(async () => {
    // Cấp phát database + role của control plane trên cụm test, đúng
    // các bước script control-plane-setup làm ở môi trường triển khai.
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${CP_DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${CP_ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${BIZ_ROLE}`);
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${BIZ_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);

    app = await createTestApp();
    registry = app.get(ControlPlaneRegistryService);
    const users = app.get(UsersService);
    const admin = await users.getByUsername('admin');
    if (!admin) throw new Error('Seed chưa tạo tài khoản admin');
    adminId = admin.id;
    guestId = (await users.ensureGuestUser()).id;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.CONTROL_PLANE_DATABASE_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${CP_DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${CP_ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${BIZ_ROLE}`);
    });
  });

  it('bootstrap gieo đúng hai không gian hiện hữu vào sổ ở chế độ kho chung', async () => {
    const platform = await registry.getBySlug(adminId, 'trang-chinh');
    expect(platform.kind).toBe('platform');
    expect(platform.status).toBe('active');
    expect(platform.storageMode).toBe('shared');
    expect(platform.schemaVersion).toBe(SHARED_DATABASE_SCHEMA_VERSION);
    expect(platform.secretRef).toBe('env:DATABASE_URL');

    const school = await registry.getBySlug(adminId, 'truong-mac-dinh');
    expect(school.kind).toBe('center');
    expect(school.storageMode).toBe('shared');
    // Cả hai đang ở kho chung hiện tại: tên database đích là chính
    // database nghiệp vụ mà ứng dụng đang chạy.
    const businessDatabase = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, '');
    expect(platform.databaseName).toBe(businessDatabase);
    expect(school.databaseName).toBe(businessDatabase);
  });

  it('chạy lại đường gieo không tạo dòng trùng cho hai không gian hiện hữu', async () => {
    const businessUrl = new URL(process.env.DATABASE_URL!);
    const seeds: ExistingSpaceSeed[] = [
      {
        slug: 'trang-chinh', name: 'Trang chính', kind: 'platform', plan: null,
        databaseName: businessUrl.pathname.replace(/^\//, ''),
        connectionRoleRef: decodeURIComponent(businessUrl.username),
        secretRef: 'env:DATABASE_URL',
      },
      {
        slug: 'truong-mac-dinh', name: 'Trường mặc định', kind: 'center', plan: null,
        databaseName: businessUrl.pathname.replace(/^\//, ''),
        connectionRoleRef: decodeURIComponent(businessUrl.username),
        secretRef: 'env:DATABASE_URL',
      },
    ];
    await expect(registry.seedExistingSpaces(seeds)).resolves.toBe(0);
    const count = await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) FROM space_registry WHERE slug IN ('trang-chinh', 'truong-mac-dinh')`,
      );
      return Number(result.rows[0]!.count);
    });
    expect(count).toBe(2);
  });

  it('tạo dòng đăng ký mới ghi kèm một dòng lịch sử create với người thực hiện và ảnh chụp sau', async () => {
    const created = await registry.createRegistration(adminId, {
      slug: 'trung-tam-test-580',
      name: 'Trung tâm test 580',
      kind: 'center',
      databaseName: 'lms_centre_test_580',
      storageMode: 'dedicated',
      connectionRoleRef: 'lms_centre_test_580_app',
      secretRef: 'env:TEST_580_DATABASE_URL',
      plan: 'standard',
    });
    createdSpaceId = created.id;
    // Không truyền status thì vòng đời bắt đầu ở provisioning.
    expect(created.status).toBe('provisioning');

    const history = await registry.listHistory(adminId, created.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.action).toBe('create');
    expect(history[0]!.actorId).toBe(adminId);
    expect(history[0]!.before).toBeNull();
    expect(history[0]!.after.slug).toBe('trung-tam-test-580');
    expect(history[0]!.after.plan).toBe('standard');
  });

  it('tạo dòng đăng ký trùng slug bị từ chối bằng lỗi xung đột', async () => {
    await expect(
      registry.createRegistration(adminId, {
        slug: 'trung-tam-test-580',
        name: 'Trung tâm trùng slug',
        kind: 'center',
        databaseName: 'lms_centre_dup',
        storageMode: 'dedicated',
        connectionRoleRef: 'lms_centre_dup_app',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('cập nhật dòng đăng ký ghi lịch sử update với giá trị trước và sau', async () => {
    const updated = await registry.updateRegistration(adminId, createdSpaceId, { name: 'Trung tâm test 580 (đổi tên)', plan: 'premium' });
    expect(updated.name).toBe('Trung tâm test 580 (đổi tên)');
    expect(updated.plan).toBe('premium');

    const history = await registry.listHistory(adminId, createdSpaceId);
    const latest = history[0]!;
    expect(latest.action).toBe('update');
    expect(latest.before?.plan).toBe('standard');
    expect(latest.after.plan).toBe('premium');
    expect(latest.before?.name).toBe('Trung tâm test 580');
  });

  it('đổi trạng thái vòng đời ghi lịch sử status_change; đổi về chính trạng thái hiện tại không ghi thêm', async () => {
    const changed = await registry.changeStatus(adminId, createdSpaceId, { status: 'active' });
    expect(changed.status).toBe('active');

    let history = await registry.listHistory(adminId, createdSpaceId);
    expect(history[0]!.action).toBe('status_change');
    expect(history[0]!.before?.status).toBe('provisioning');
    expect(history[0]!.after.status).toBe('active');
    const countAfterChange = history.length;

    await registry.changeStatus(adminId, createdSpaceId, { status: 'active' });
    history = await registry.listHistory(adminId, createdSpaceId);
    expect(history).toHaveLength(countAfterChange);
  });

  it('tra cứu định tuyến theo slug trả đúng dòng đăng ký; slug lạ nhận lỗi không tìm thấy', async () => {
    const found = await registry.getBySlug(adminId, 'trung-tam-test-580');
    expect(found.id).toBe(createdSpaceId);
    expect(found.databaseName).toBe('lms_centre_test_580');
    await expect(registry.getBySlug(adminId, 'slug-khong-ton-tai')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('người không giữ capability quản trị platform bị từ chối ở mọi đường ghi', async () => {
    await expect(
      registry.createRegistration(guestId, {
        slug: 'trung-tam-cua-khach',
        name: 'Trung tâm của khách',
        kind: 'center',
        databaseName: 'lms_centre_guest',
        storageMode: 'dedicated',
        connectionRoleRef: 'guest_app',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(registry.changeStatus(guestId, createdSpaceId, { status: 'suspended' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(registry.getBySlug(guestId, 'trang-chinh')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('registry phiên bản schema: lượt migration thành công nâng phiên bản hiện tại, lượt hỏng thì không', async () => {
    const empty = await registry.getSchemaRegistry(adminId, createdSpaceId);
    expect(empty.currentVersion).toBeNull();

    await registry.recordMigrationRun(adminId, createdSpaceId, {
      runId: 'run-580-1',
      fromVersion: null,
      toVersion: 'v2',
      status: 'success',
      steps: [{ name: 'apply-baseline', status: 'success' }],
    });
    let state = await registry.getSchemaRegistry(adminId, createdSpaceId);
    expect(state.currentVersion).toBe('v2');
    // Phiên bản trên dòng đăng ký được đồng bộ cùng transaction.
    expect((await registry.getBySlug(adminId, 'trung-tam-test-580')).schemaVersion).toBe('v2');

    await registry.recordMigrationRun(adminId, createdSpaceId, {
      runId: 'run-580-2',
      fromVersion: 'v2',
      toVersion: 'v3',
      status: 'failed',
      steps: [{ name: 'apply-v3', status: 'failed', detail: 'syntax error' }],
    });
    state = await registry.getSchemaRegistry(adminId, createdSpaceId);
    expect(state.currentVersion).toBe('v2');

    const runs = await registry.listMigrationRuns(adminId, createdSpaceId);
    expect(runs.map((run) => run.runId)).toEqual(['run-580-1', 'run-580-2']);
    expect(runs[1]!.steps).toEqual([{ name: 'apply-v3', status: 'failed', detail: 'syntax error' }]);
  });

  it('registry phiên bản schema: ghi và đọc lại được trạng thái sao lưu gần nhất', async () => {
    const updated = await registry.updateSchemaRegistry(adminId, createdSpaceId, {
      lastBackupStatus: 'success',
      lastBackupAt: '2026-10-30T10:00:00+07:00',
    });
    expect(updated.lastBackupStatus).toBe('success');
    expect(updated.lastBackupAt).toBe('2026-10-30T03:00:00.000Z');
    // Ghi trạng thái sao lưu không đụng phiên bản hiện tại đã có.
    expect(updated.currentVersion).toBe('v2');
  });

  it('role của control plane bị từ chối khi đọc dữ liệu ở kho nghiệp vụ', async () => {
    await expect(
      withClient(clusterUrl('lms_test_api', CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query('SELECT * FROM tenants LIMIT 1');
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('role phía nghiệp vụ không kết nối được vào database control plane', async () => {
    await expect(withClient(clusterUrl(CP_DATABASE, BIZ_ROLE, CP_PASSWORD), async () => undefined)).rejects.toThrow(
      /permission denied/,
    );
  });
});
