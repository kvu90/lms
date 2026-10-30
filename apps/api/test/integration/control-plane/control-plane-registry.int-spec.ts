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
 * Cô lập kết nối được kiểm ở ĐÚNG bước mở kết nối, hai chiều: ca
 * cũng khoá CONNECT trên chính database nghiệp vụ test (thu hồi
 * PUBLIC, cấp lại cho role của đường dữ kiện và một role nghiệp vụ
 * thường `lms_biz_test_580`) như script cấp phát làm ở môi trường
 * triển khai, rồi khẳng định role control plane chết ngay tại
 * `connect()`. ACL của database nghiệp vụ được trả về mặc định ở
 * afterAll để không ảnh hưởng các ca khác dùng chung cụm test.
 * Giới hạn phạm vi của các ca kết nối: chúng chứng minh cô lập với
 * role KHÔNG phải superuser — role runtime của ứng dụng trong
 * compose hiện là superuser của cụm, mà superuser thì bỏ qua mọi
 * kiểm tra quyền kết nối; việc hạ role runtime xuống role thường
 * là việc hạ tầng riêng ngoài issue này.
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

/** Bọc một định danh Postgres trong dấu nháy kép cho các câu lệnh quản trị của ca test. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
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
  // Database nghiệp vụ test và role kết nối của đường dữ kiện, suy
  // từ chính DATABASE_URL của môi trường test (không gán cứng tên,
  // để ca chạy đúng trên mọi môi trường trỏ DB riêng).
  let businessDatabase: string;
  let businessRole: string;

  beforeAll(async () => {
    const businessUrl = new URL(process.env.DATABASE_URL!);
    businessDatabase = decodeURIComponent(businessUrl.pathname.replace(/^\//, ''));
    businessRole = decodeURIComponent(businessUrl.username);
    // Cấp phát database + role của control plane trên cụm test, đúng
    // các bước script control-plane-setup làm ở môi trường triển khai.
    await withClient(clusterUrl('postgres'), async (admin) => {
      // Dọn grant còn sót của một lượt chạy trước bị ngắt giữa chừng:
      // role nghiệp vụ mẫu còn giữ quyền CONNECT trên database
      // nghiệp vụ thì DROP ROLE ở dưới sẽ vấp phụ thuộc.
      const staleBizRole = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = '${BIZ_ROLE}'`);
      if ((staleBizRole.rowCount ?? 0) > 0) {
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(businessDatabase)} FROM ${BIZ_ROLE}`);
      }
      await admin.query(`DROP DATABASE IF EXISTS ${CP_DATABASE} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${CP_ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${BIZ_ROLE}`);
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${BIZ_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      // Khoá cả chiều ngược trên chính database nghiệp vụ, đúng
      // bước script cấp phát làm: thu hồi CONNECT của PUBLIC, chỉ
      // cấp lại cho role của đường dữ kiện và role nghiệp vụ thường
      // dùng làm mẫu kiểm chứng trong ca này.
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(businessDatabase)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(businessDatabase)} TO ${quoted(businessRole)}`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(businessDatabase)} TO ${BIZ_ROLE}`);
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
      // Trả ACL của database nghiệp vụ về mặc định (PUBLIC được kết
      // nối) trước khi dọn: các ca khác dùng chung cụm test không bị
      // ảnh hưởng bởi khoá của ca này. Grant riêng đã cấp cho role
      // nghiệp vụ mẫu phải thu hồi tường minh, nếu không DROP ROLE
      // sẽ vấp phụ thuộc trên ACL của database nghiệp vụ.
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(businessDatabase)} TO PUBLIC`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(businessDatabase)} FROM ${BIZ_ROLE}`);
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

  it('registry phiên bản schema: xoá phiên bản bằng null thì dòng đăng ký cũng đồng bộ về null', async () => {
    const cleared = await registry.updateSchemaRegistry(adminId, createdSpaceId, { currentVersion: null });
    expect(cleared.currentVersion).toBeNull();
    // Hai nơi lưu phiên bản (registry của kho và trường phiên bản
    // trên dòng đăng ký — đường đọc định tuyến) phải cùng đọc ra
    // null sau khi xoá, không nơi nào giữ giá trị cũ.
    const reread = await registry.getSchemaRegistry(adminId, createdSpaceId);
    expect(reread.currentVersion).toBeNull();
    expect((await registry.getBySlug(adminId, 'trung-tam-test-580')).schemaVersion).toBeNull();
  });

  it('hai lượt cập nhật registry chồng lấn vào hai trường độc lập không làm mất giá trị của nhau', async () => {
    // Dựng chồng lấn xác định bằng một transaction thô giữ khoá
    // dòng của registry: cả hai lượt ghi của service đều phải ĐỌC
    // trạng thái hiện tại trước khi lượt nào ghi được (lượt ghi bị
    // chặn ở bước upsert cho tới khi transaction thô commit). Với
    // cơ chế đọc-ngoài-transaction rồi ghi đè toàn dòng, lượt ghi
    // sau mang theo ảnh cũ và xoá mất trường lượt trước vừa ghi;
    // với cơ chế đọc-trong-transaction sau khoá dòng đăng ký, lượt
    // sau đọc lại trạng thái tươi và cả hai trường cùng tồn tại.
    const gate = new Client({ connectionString: clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD) });
    await gate.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT space_id FROM space_schema_registry WHERE space_id = $1 FOR UPDATE', [createdSpaceId]);
      const backupWrite = registry.updateSchemaRegistry(adminId, createdSpaceId, {
        lastBackupStatus: 'success',
        lastBackupAt: '2026-10-30T11:00:00+07:00',
      });
      const restoreWrite = registry.updateSchemaRegistry(adminId, createdSpaceId, {
        lastRestoreStatus: 'success',
        lastRestoreAt: '2026-10-30T11:05:00+07:00',
      });
      // Khoảng chờ dư dả để cả hai lượt đều tới bước ghi và bị chặn
      // ở khoá của transaction thô trước khi mở cổng.
      await new Promise((resolve) => setTimeout(resolve, 750));
      await gate.query('COMMIT');
      await Promise.all([backupWrite, restoreWrite]);
    } finally {
      await gate.end().catch(() => undefined);
    }
    const state = await registry.getSchemaRegistry(adminId, createdSpaceId);
    expect(state.lastBackupStatus).toBe('success');
    expect(state.lastBackupAt).toBe('2026-10-30T04:00:00.000Z');
    expect(state.lastRestoreStatus).toBe('success');
    expect(state.lastRestoreAt).toBe('2026-10-30T04:05:00.000Z');
  });

  it('role của control plane bị từ chối ngay ở bước mở kết nối vào kho nghiệp vụ', async () => {
    // Khẳng định tách riêng bước mở kết nối: dùng Client thô và chỉ
    // gọi connect() — lỗi phải sinh ra ngay tại đây với thông điệp
    // từ chối ở mức database, không phải lỗi quyền trên bảng sau
    // khi kết nối đã mở thành công.
    const client = new Client({ connectionString: clusterUrl(businessDatabase, CP_ROLE, CP_PASSWORD) });
    let connectError: unknown;
    try {
      await client.connect();
    } catch (err) {
      connectError = err;
    } finally {
      await client.end().catch(() => undefined);
    }
    expect(connectError).toBeInstanceOf(Error);
    expect((connectError as Error).message).toMatch(/permission denied for database/);
  });

  it('role nghiệp vụ thường vẫn mở được kết nối vào kho nghiệp vụ sau khi khoá PUBLIC', async () => {
    // Nửa còn lại của khoá: role nghiệp vụ hợp lệ (ở đây là role
    // thường đóng vai role của đường dữ kiện) không bị khoá nhầm —
    // kết nối mở được và truy vấn tối thiểu chạy được.
    const database = await withClient(clusterUrl(businessDatabase, BIZ_ROLE, CP_PASSWORD), async (client) => {
      const result = await client.query<{ current_database: string }>('SELECT current_database()');
      return result.rows[0]!.current_database;
    });
    expect(database).toBe(businessDatabase);
  });

  it('role nghiệp vụ không phải superuser bị từ chối ngay ở bước mở kết nối vào database control plane', async () => {
    // Ca này chứng minh cô lập chiều ngược với role nghiệp vụ
    // THƯỜNG (không phải superuser). Role runtime của ứng dụng
    // trong compose hiện là superuser của cụm nên không bị ACL kết
    // nối ràng buộc — giới hạn đó thuộc việc hạ role runtime ở
    // tầng hạ tầng, ngoài phạm vi ca này.
    const client = new Client({ connectionString: clusterUrl(CP_DATABASE, BIZ_ROLE, CP_PASSWORD) });
    let connectError: unknown;
    try {
      await client.connect();
    } catch (err) {
      connectError = err;
    } finally {
      await client.end().catch(() => undefined);
    }
    expect(connectError).toBeInstanceOf(Error);
    expect((connectError as Error).message).toMatch(/permission denied for database/);
  });

  it('nhiều thao tác ghi đồng thời trên cùng dòng đăng ký cho chuỗi lịch sử liên tục, không đứt', async () => {
    const space = await registry.createRegistration(adminId, {
      slug: 'trung-tam-song-song-589',
      name: 'Trung tâm kiểm đồng thời',
      kind: 'center',
      databaseName: 'lms_centre_parallel_589',
      storageMode: 'dedicated',
      connectionRoleRef: 'lms_centre_parallel_589_app',
    });
    // Bốn thao tác ghi chạy cùng lúc trên cùng một dòng (hai đổi
    // trạng thái qua lại, hai cập nhật tên): ảnh before của mỗi
    // dòng lịch sử phải đúng bằng ảnh after của dòng lịch sử ngay
    // trước nó theo thứ tự ghi thật — đọc dòng hiện tại ngoài
    // transaction sẽ làm các dòng cùng chụp một ảnh cũ và chuỗi
    // đứt ở điểm nối.
    await Promise.allSettled([
      registry.changeStatus(adminId, space.id, { status: 'active' }),
      registry.updateRegistration(adminId, space.id, { name: 'Tên đồng thời một' }),
      registry.changeStatus(adminId, space.id, { status: 'suspended' }),
      registry.updateRegistration(adminId, space.id, { name: 'Tên đồng thời hai' }),
    ]);
    const history = await registry.listHistory(adminId, space.id);
    // Ít nhất hai thao tác đổi trạng thái nối tiếp nhau thật sự
    // phải có mặt (một thao tác đổi về đúng trạng thái hiện tại là
    // thao tác rỗng, không ghi lịch sử — số dòng vì vậy dao động).
    expect(history.length).toBeGreaterThanOrEqual(3);
    const chronological = [...history].reverse();
    for (let i = 1; i < chronological.length; i += 1) {
      expect(chronological[i]!.before).toEqual(chronological[i - 1]!.after);
    }
    const finalRow = await registry.getBySlug(adminId, 'trung-tam-song-song-589');
    expect(['Tên đồng thời một', 'Tên đồng thời hai']).toContain(finalRow.name);
    expect(['active', 'suspended']).toContain(finalRow.status);
  });

  it('nhiều lượt tạo đồng thời cùng slug: đúng một lượt thành công, các lượt còn lại nhận lỗi xung đột', async () => {
    const dto = {
      slug: 'trung-tam-trung-dong-thoi-589',
      name: 'Trung tâm trùng đồng thời',
      kind: 'center' as const,
      databaseName: 'lms_centre_race_589',
      storageMode: 'dedicated' as const,
      connectionRoleRef: 'lms_centre_race_589_app',
    };
    const results = await Promise.allSettled([
      registry.createRegistration(adminId, dto),
      registry.createRegistration(adminId, dto),
      registry.createRegistration(adminId, dto),
      registry.createRegistration(adminId, dto),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    // Các lượt thua nhận lỗi xung đột nghiệp vụ (409), không phải
    // lỗi máy chủ do vấp ràng buộc unique ở tầng database.
    for (const result of rejected) {
      expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    }
    const count = await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*) FROM space_registry WHERE slug = 'trung-tam-trung-dong-thoi-589'`,
      );
      return Number(result.rows[0]!.count);
    });
    expect(count).toBe(1);
  });
});
