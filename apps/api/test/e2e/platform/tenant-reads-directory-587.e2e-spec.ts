import { INestApplication } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceJoinCodeDirectory, spaceMembershipDirectory, spaceRegistry } from '@lms/db/control-plane';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emitSpaceRegistryChanged } from '../../../src/db/routing/space-routing-events';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { CAP_ALLOW } from '../../../src/modules/access/domain/permission';
import { ContextsService } from '../../../src/modules/access/contexts.service';
import { RolesService } from '../../../src/modules/access/roles.service';
import { TenantsService } from '../../../src/modules/tenants/tenants.service';
import { UsersService } from '../../../src/modules/users/users.service';
import { runSpaceDirectoryBackfill } from '../../../src/modules/tenants/space-directory-backfill';
import {
  STRONG_PASSWORD,
  createTestApp,
  createUserViaApi,
  http,
  login,
  uniqueName,
} from '../../support/identity-access-helpers';

/**
 * Ca đầu-cuối của HẠNG MỤC 3 — tiền điều kiện Phần B (issue #587):
 * các lượt đọc phía quản trị tenant, bộ chọn trung tâm và mã tham
 * gia lớp phải tới được dữ kiện của một trung tâm đã chuyển sang
 * kho riêng, theo thiết kế A1+B1+C1:
 * - A1: lượt đọc quản trị (thông tin tenant, danh sách thành
 *   viên, danh sách người dùng) phân giải tenant → slug qua sổ
 *   đăng ký rồi chạy tại kho đích của tenant đó;
 * - B1: bộ chọn trung tâm (`GET /auth/tenants`) hợp nhất THƯ MỤC
 *   THÀNH VIÊN ở control plane — thư mục chỉ là chỉ mục định
 *   tuyến, dữ kiện của từng trung tâm vẫn đọc tại kho của nó;
 * - C1: mã tham gia lớp phân giải qua THƯ MỤC MÃ ở control plane
 *   trước, toàn bộ bước ghi của luồng tham gia chạy trong kho
 *   của lớp.
 *
 * Bối cảnh dựng như các spec kho riêng trước (#584/#587 Phần A):
 * một trung tâm kiểm chứng ở kho riêng dựng riêng cho đợt này
 * (database + role riêng trên cụm test, baseline áp bằng role
 * chủ kho), sổ đăng ký ở database control plane riêng mà ứng
 * dụng đọc qua `CONTROL_PLANE_DATABASE_URL`. Trạng thái "đã di
 * trú" được dựng bằng cách tạo dữ kiện qua API ở kho chung rồi
 * sao dòng sang kho riêng và xoá khỏi kho chung — đúng ba ca
 * thí điểm từng trượt trước khi có hạng mục này:
 * (1) quản trị trung tâm mở danh sách thành viên/người dùng của
 *     trung tâm mình và nhận RỖNG GIẢ dù membership chỉ còn ở
 *     kho đích;
 * (2) bộ chọn trung tâm của một thành viên làm họ MẤT trung tâm
 *     đã di trú khỏi danh sách;
 * (3) học viên của trung tâm tham gia lớp bằng mã bị từ chối
 *     `class.join_code_invalid` vì mã chỉ tồn tại ở kho đích.
 * Kèm các khoá phụ: điểm ghi duy trì thư mục (tạo người dùng
 * trong kho riêng, thêm thành viên, đổi trạng thái) cập nhật
 * thư mục trong cùng thao tác; công cụ lấp thư mục chạy lại
 * không sinh trùng và báo cáo va chạm mã thay vì ghi đè; thư
 * mục trỏ tới kho đích không chuẩn bị được thì lỗi tường minh
 * chứ không trả rỗng giả.
 */
const CP_DATABASE = 'lms_test_cp_td3';
const CP_ROLE = 'lms_cp_test_td3';
const CP_PASSWORD = 'cp-test-td3';
const CENTRE_DATABASE = 'lms_test_centre_td3';
const CENTRE_ROLE = 'lms_centre_td3_app';
const CENTRE_PASSWORD = 'centre-test-td3';
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CENTRE_SLUG = `trung-tam-td3-${RUN_SUFFIX}`;
const HOST = `${CENTRE_SLUG}.test.local`;
const BROKEN_SLUG = `trung-tam-hong-td3-${RUN_SUFFIX}`;
const BROKEN_CODE = 'BRKN587X';

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

/** Áp một file migration SQL (tách theo dấu phân đoạn của Drizzle) lên một database qua kết nối cho trước. */
async function applySqlFile(connectionString: string, filePath: string, withUuidShim: boolean): Promise<void> {
  await withClient(connectionString, async (client) => {
    if (withUuidShim) {
      const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
      if (Number(version.rows[0]!.server_version_num) < 180000) {
        await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await client.query(UUIDV7_SHIM);
      }
    }
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo, gồm cả hai bảng thư mục mới). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'), true);
  }
}

/** Áp baseline nghiệp vụ vào kho riêng bằng kết nối của chính role chủ kho đó. */
async function applyBusinessBaseline(connectionString: string): Promise<void> {
  const baseline = join(__dirname, '..', '..', '..', 'drizzle', '20261025163710_baseline', 'migration.sql');
  await applySqlFile(connectionString, baseline, true);
}

/** Sao một dòng (đọc từ kho chung) vào cùng bảng ở kho đích với nguyên bộ cột — mô phỏng phần dữ kiện đã di trú của trung tâm. */
async function copyRow(
  sourceUrl: string,
  targetUrl: string,
  table: string,
  whereColumn: string,
  whereValue: string,
): Promise<void> {
  const row = await withClient(sourceUrl, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query(`SELECT * FROM ${quoted(table)} WHERE ${quoted(whereColumn)} = $1`, [whereValue]);
    return result.rows[0] as Record<string, unknown> | undefined;
  });
  if (!row) throw new Error(`Không tìm thấy dòng nguồn ${table}.${whereColumn}=${whereValue}`);
  const columns = Object.keys(row);
  await withClient(targetUrl, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
    await client.query(
      `INSERT INTO ${quoted(table)} (${columns.map(quoted).join(', ')}) VALUES (${placeholders})`,
      columns.map((column) => row[column]),
    );
  });
}

/** Đếm dòng theo một cột định danh trong một bảng ở một kho (nền platform tường minh). */
async function countRows(connectionString: string, table: string, column: string, value: string): Promise<number> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ count: string }>(
      `SELECT count(*) FROM ${quoted(table)} WHERE ${quoted(column)} = $1`,
      [value],
    );
    return Number(result.rows[0]!.count);
  });
}

describe('Đọc quản trị ở kho đích + thư mục định tuyến (đầu-cuối, issue #587 hạng mục 3)', () => {
  let app: INestApplication;
  let adminToken = '';
  let tenantId = '';
  let centreAdminToken = '';
  let memberId = '';
  let memberUsername = '';
  let spaceUserId = '';
  let classId = '';
  let classCohortId = '';
  let joinCode = '';
  let studentId = '';
  let studentToken = '';

  const centreUrl = () => clusterUrl(CENTRE_DATABASE, CENTRE_ROLE, CENTRE_PASSWORD);
  const cpUrl = () => clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as never;
  };
  /**
   * Chạy công cụ lấp thư mục cho trung tâm kiểm chứng: biến URL
   * của không gian trong môi trường của runner trỏ thẳng tới
   * database của trung tâm (đúng ngữ nghĩa production của biến
   * bí mật — URL đầy đủ của kho đích; biến SPACE_TEST_TD3_URL
   * của ứng dụng thì trỏ database `postgres` vì tầng định tuyến
   * tự đổi đích theo tên database trong sổ đăng ký).
   */
  const runBackfill = () =>
    runSpaceDirectoryBackfill({
      slug: CENTRE_SLUG,
      env: { ...process.env, SPACE_TEST_TD3_URL: centreUrl() },
      log: () => undefined,
    });
  const loginAt = async (host: string, username: string, password: string) => {
    const res = await http(app).post('/api/v1/auth/token').set('Host', host).send({ username, password });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`login at ${host} failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as { accessToken: string; refreshToken: string };
  };

  beforeAll(async () => {
    // Cấp phát control plane + kho riêng trên cụm test: role
    // riêng cho từng kho, CONNECT của PUBLIC bị thu hồi.
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${quoted(CP_ROLE)} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${quoted(CENTRE_ROLE)} LOGIN PASSWORD '${CENTRE_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${quoted(CP_DATABASE)} OWNER ${quoted(CP_ROLE)}`);
      await admin.query(`CREATE DATABASE ${quoted(CENTRE_DATABASE)} OWNER ${quoted(CENTRE_ROLE)}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(CP_DATABASE)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(CP_DATABASE)} TO ${quoted(CP_ROLE)}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(CENTRE_DATABASE)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(CENTRE_DATABASE)} TO ${quoted(CENTRE_ROLE)}`);
    });
    await applyControlPlaneMigrations(cpUrl());
    await applyBusinessBaseline(centreUrl());

    process.env.CONTROL_PLANE_DATABASE_URL = cpUrl();
    process.env.SPACE_TEST_TD3_URL = clusterUrl('postgres', CENTRE_ROLE, CENTRE_PASSWORD);

    // Dòng đăng ký kho riêng trong sổ, ghi trước khi ứng dụng
    // khởi động như spec Phần A.
    await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      await cpDb.insert(spaceRegistry).values([
        {
          slug: CENTRE_SLUG,
          name: 'Trung tâm TĐ3',
          kind: 'center',
          status: 'active',
          databaseName: CENTRE_DATABASE,
          storageMode: 'dedicated',
          connectionRoleRef: CENTRE_ROLE,
          secretRef: 'env:SPACE_TEST_TD3_URL',
          schemaVersion: 'v1',
        },
      ]);
    });

    app = await createTestApp();
    adminToken = (await login(app, 'admin', 'Admin123!')).accessToken;

    // Tenant tạo bằng API ở kho chung rồi sao dòng tenant vào
    // kho riêng — trạng thái sau di trú.
    const created = (await must(
      await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm TĐ3 (spec 587)',
        slug: CENTRE_SLUG,
        kind: 'school',
      }),
      'create tenant',
    )) as { id: string };
    tenantId = created.id;
    await copyRow(process.env.DATABASE_URL!, centreUrl(), 'tenants', 'id', tenantId);

    // Quản trị đầu tiên của trung tâm, tạo bằng chính service
    // của ứng dụng bên trong kho của trung tâm (khuôn spec #584).
    const spaceDb = app.get(SpaceDatabaseService, { strict: false });
    const users = app.get(UsersService, { strict: false });
    const tenants = app.get(TenantsService, { strict: false });
    const contexts = app.get(ContextsService, { strict: false });
    const roles = app.get(RolesService, { strict: false });
    const adminUsername = uniqueName('admintd3');
    await spaceDb.withSpaceDatabase(
      CENTRE_SLUG,
      async () => {
        const user = await users.createUser({
          username: adminUsername,
          email: `${adminUsername}@example.com`,
          password: STRONG_PASSWORD,
          firstName: 'QuanTri',
          lastName: 'Td3',
        });
        await tenants.ensureActiveMembership(tenantId, user.id);
        const ctx = await contexts.ensureTenantContext(tenantId);
        const role = await roles.createRole({ name: 'Quản trị trung tâm (spec TĐ3)', shortName: `spec-td3-admin-${RUN_SUFFIX}` });
        await roles.setCapabilityOverride(role.id, 'tenant:manage', ctx.id, CAP_ALLOW);
        // Cả quyền tạo/sửa lớp ở context tenant (chảy xuống context
        // lớp): kho riêng không có bộ vai mẫu archetype như kho
        // chung nên quản trị trung tâm phải được cấp tường minh —
        // các ca lớp của spec này đi qua đường API thật.
        await roles.setCapabilityOverride(role.id, 'class:create', ctx.id, CAP_ALLOW);
        await roles.setCapabilityOverride(role.id, 'class:update', ctx.id, CAP_ALLOW);
        await roles.assignRole(user.id, role.id, ctx.id);
        // Vai archetype `editingteacher` phải có trong kho của
        // trung tâm thì đường tạo lớp mới chạy được (ở kho chung
        // nó do seedDefaults gieo; ở một trung tâm đã di trú nó
        // nằm trong dữ kiện được sao sang — spec dựng thẳng vai
        // này để mô phỏng đúng trạng thái đó).
        await roles.createRole({ name: 'Editing teacher', shortName: 'editingteacher', archetype: 'teacher' });
        return user;
      },
      { tenantId },
    );
    centreAdminToken = (await loginAt(HOST, adminUsername, STRONG_PASSWORD)).accessToken;

    // Thành viên đã di trú: tạo ở kho chung, thêm membership
    // bằng API, sao user + membership vào kho riêng rồi XOÁ
    // khỏi kho chung — membership của họ chỉ còn ở kho đích.
    const member = await createUserViaApi(app, adminToken);
    memberId = member.id;
    memberUsername = member.username;
    await must(
      await http(app).post(`/api/v1/tenants/${tenantId}/members`).set(auth(adminToken)).send({ userId: memberId }),
      'add member',
    );
    await copyRow(process.env.DATABASE_URL!, centreUrl(), 'users', 'id', memberId);
    const membershipRow = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ id: string }>(
        'SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantId, memberId],
      );
      return result.rows[0];
    });
    if (!membershipRow) throw new Error('membership của thành viên ở kho chung không tồn tại');
    await copyRow(process.env.DATABASE_URL!, centreUrl(), 'tenant_memberships', 'id', membershipRow.id);
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [tenantId, memberId]);
      await client.query('DELETE FROM users WHERE id = $1', [memberId]);
    });
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    delete process.env.SPACE_TEST_TD3_URL;
    delete process.env.SPACE_TEST_BROKEN_TD3_URL;
  });

  it('danh sách thành viên và người dùng đọc tại kho đích: quản trị trung tâm thấy thành viên đã di trú, không rỗng giả', async () => {
    // Tại địa chỉ của trung tâm, bằng token của quản trị trung tâm.
    const members = (await must(
      await http(app).get(`/api/v1/tenants/${tenantId}/members`).set('Host', HOST).set(auth(centreAdminToken)),
      'list members at centre host',
    )) as Array<{ userId: string; status: string }>;
    expect(members.some((m) => m.userId === memberId && m.status === 'active')).toBe(true);

    const tenantUsers = (await must(
      await http(app).get(`/api/v1/tenants/${tenantId}/users`).set('Host', HOST).set(auth(centreAdminToken)),
      'list tenant users at centre host',
    )) as Array<{ id: string }>;
    expect(tenantUsers.some((u) => u.id === memberId)).toBe(true);

    const tenantView = (await must(
      await http(app).get(`/api/v1/tenants/${tenantId}`).set('Host', HOST).set(auth(centreAdminToken)),
      'get tenant at centre host',
    )) as { id: string; slug: string };
    expect(tenantView.slug).toBe(CENTRE_SLUG);

    // Cùng lượt đọc từ bề mặt platform (địa chỉ mặc định): A1
    // định tuyến theo TENANT, không theo địa chỉ của request.
    const membersFromPlatform = (await must(
      await http(app).get(`/api/v1/tenants/${tenantId}/members`).set(auth(adminToken)),
      'list members from platform surface',
    )) as Array<{ userId: string; status: string }>;
    expect(membersFromPlatform.some((m) => m.userId === memberId && m.status === 'active')).toBe(true);
  });

  it('điểm ghi duy trì thư mục: tạo người dùng trong kho riêng, thêm thành viên và đổi trạng thái đều cập nhật thư mục trong cùng thao tác', async () => {
    // Tạo người dùng qua API của tenant tại địa chỉ trung tâm:
    // tài khoản chỉ sinh ra trong kho riêng, mục thư mục phải có
    // ngay sau thao tác (không chờ lấp thư mục).
    const username = uniqueName('spaceuser');
    const createdUser = (await must(
      await http(app).post(`/api/v1/tenants/${tenantId}/users`).set('Host', HOST).set(auth(centreAdminToken)).send({
        username,
        email: `${username}@example.com`,
        password: STRONG_PASSWORD,
        firstName: 'NguoiDung',
        lastName: 'KhoRieng',
      }),
      'create tenant user in space',
    )) as { id: string };
    spaceUserId = createdUser.id;
    const directoryRows = await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      return cpDb.select().from(spaceMembershipDirectory);
    });
    const entry = directoryRows.find((row) => row.spaceSlug === CENTRE_SLUG && row.spaceUserId === spaceUserId);
    expect(entry).toBeDefined();
    expect(entry!.globalUserId).toBe(spaceUserId);
    expect(entry!.status).toBe('active');

    // Thêm thành viên (tài khoản toàn cục) cho tenant kho riêng
    // rồi đổi trạng thái: trạng thái trong thư mục đi theo từng
    // thao tác ghi.
    const globalUser = await createUserViaApi(app, adminToken);
    await must(
      await http(app).post(`/api/v1/tenants/${tenantId}/members`).set(auth(adminToken)).send({ userId: globalUser.id }),
      'add global member',
    );
    const afterAdd = await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      return cpDb.select().from(spaceMembershipDirectory);
    });
    const addedEntry = afterAdd.find((row) => row.spaceSlug === CENTRE_SLUG && row.globalUserId === globalUser.id);
    expect(addedEntry).toBeDefined();
    expect(addedEntry!.status).toBe('active');

    await must(
      await http(app)
        .patch(`/api/v1/tenants/${tenantId}/members/${globalUser.id}`)
        .set(auth(adminToken))
        .send({ status: 'suspended' }),
      'suspend member',
    );
    const afterSuspend = await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      return cpDb.select().from(spaceMembershipDirectory);
    });
    const suspendedEntry = afterSuspend.find((row) => row.spaceSlug === CENTRE_SLUG && row.globalUserId === globalUser.id);
    expect(suspendedEntry).toBeDefined();
    expect(suspendedEntry!.status).toBe('suspended');
  });

  it('bộ chọn trung tâm: thành viên đã di trú mất trung tâm khi chưa có thư mục và thấy lại trung tâm sau khi lấp thư mục', async () => {
    const memberToken = (await loginAt(HOST, memberUsername, STRONG_PASSWORD)).accessToken;

    // Mô phỏng đúng đối tượng của công cụ lấp thư mục: một
    // không gian đã di trú TRƯỚC khi thư mục tồn tại — membership
    // của thành viên chỉ nằm ở kho đích và thư mục chưa có mục
    // nào của họ (mục do điểm ghi addMember tạo ở beforeAll bị
    // gỡ để dựng lại trạng thái tiền-thư mục đó).
    await withClient(cpUrl(), async (client) => {
      await client.query('DELETE FROM space_membership_directory WHERE space_slug = $1 AND global_user_id = $2', [
        CENTRE_SLUG,
        memberId,
      ]);
    });

    // Trước khi lấp: bộ chọn không thấy trung tâm (đúng ca thí
    // điểm từng trượt).
    const before = (await must(
      await http(app).get('/api/v1/auth/tenants').set('Host', HOST).set(auth(memberToken)),
      'my tenants before backfill',
    )) as Array<{ slug: string }>;
    expect(before.some((row) => row.slug === CENTRE_SLUG)).toBe(false);

    const result = await runBackfill();
    expect(result.membershipsUpserted).toBeGreaterThanOrEqual(2);
    expect(result.joinCodeConflicts).toEqual([]);

    const after = (await must(
      await http(app).get('/api/v1/auth/tenants').set('Host', HOST).set(auth(memberToken)),
      'my tenants after backfill',
    )) as Array<{ slug: string; name: string; active: boolean }>;
    const row = after.find((r) => r.slug === CENTRE_SLUG);
    expect(row).toBeDefined();
    expect(row!.active).toBe(true);
  });

  it('học viên của trung tâm tham gia lớp bằng mã qua thư mục: xem trước và tham gia thành công, toàn bộ ghi rơi vào kho đích', async () => {
    // Lớp tạo tại địa chỉ trung tâm (chỉ tồn tại ở kho đích), mở
    // tự báo danh → mã được sinh và đăng ký vào thư mục ngay
    // trong thao tác cập nhật lớp.
    const createdClass = (await must(
      await http(app).post('/api/v1/classes').set('Host', HOST).set(auth(centreAdminToken)).send({ name: 'Lớp TĐ3' }),
      'create class in space',
    )) as { id: string };
    classId = createdClass.id;
    const updated = (await must(
      await http(app).patch(`/api/v1/classes/${classId}`).set('Host', HOST).set(auth(centreAdminToken)).send({ allowSelfReport: true }),
      'open self report',
    )) as { joinCode: string | null };
    expect(updated.joinCode).toBeTruthy();
    joinCode = updated.joinCode!;
    classCohortId = await withClient(centreUrl(), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ cohort_id: string }>('SELECT cohort_id FROM classes WHERE id = $1', [classId]);
      return result.rows[0]!.cohort_id;
    });
    const directoryCodes = await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      return cpDb.select().from(spaceJoinCodeDirectory);
    });
    expect(directoryCodes.some((row) => row.joinCode === joinCode && row.spaceSlug === CENTRE_SLUG)).toBe(true);
    // Mã và lớp không hề tồn tại ở kho chung.
    expect(await countRows(process.env.DATABASE_URL!, 'classes', 'id', classId)).toBe(0);

    // Học viên là tài khoản của chính trung tâm (tạo trong kho
    // riêng qua API của tenant).
    const studentUsername = uniqueName('studenttd3');
    const createdStudent = (await must(
      await http(app).post(`/api/v1/tenants/${tenantId}/users`).set('Host', HOST).set(auth(centreAdminToken)).send({
        username: studentUsername,
        email: `${studentUsername}@example.com`,
        password: STRONG_PASSWORD,
        firstName: 'HocVien',
        lastName: 'Td3',
      }),
      'create student in space',
    )) as { id: string };
    studentId = createdStudent.id;
    studentToken = (await loginAt(HOST, studentUsername, STRONG_PASSWORD)).accessToken;

    // Xem trước: tên lớp + tên chủ lớp đọc tại kho đích.
    const preview = (await must(
      await http(app).get('/api/v1/classes/join-preview').query({ code: joinCode }).set('Host', HOST).set(auth(studentToken)),
      'preview join',
    )) as { classId: string; name: string; ownerName: string };
    expect(preview.classId).toBe(classId);
    expect(preview.name).toBe('Lớp TĐ3');
    expect(preview.ownerName).toContain('QuanTri');

    // Tham gia: lớp đang trống → vào thẳng.
    const joined = (await must(
      await http(app).post('/api/v1/classes/join').set('Host', HOST).set(auth(studentToken)).send({ joinCode }),
      'join by code',
    )) as { outcome: string };
    expect(joined.outcome).toBe('joined');

    // Toàn bộ ghi của luồng nằm ở kho đích…
    expect(await countRows(centreUrl(), 'cohort_members', 'user_id', studentId)).toBe(1);
    const centreMembership = await withClient(centreUrl(), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ count: string }>(
        'SELECT count(*) FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2 AND status = $3',
        [tenantId, studentId, 'active'],
      );
      return Number(result.rows[0]!.count);
    });
    expect(centreMembership).toBe(1);
    // …và kho chung không nhận lượt ghi nào của luồng này.
    expect(await countRows(process.env.DATABASE_URL!, 'cohort_members', 'cohort_id', classCohortId)).toBe(0);
    expect(await countRows(process.env.DATABASE_URL!, 'tenant_memberships', 'user_id', studentId)).toBe(0);

    // Mã sai vẫn bị từ chối như trước.
    const bogus = await http(app).get('/api/v1/classes/join-preview').query({ code: 'ZZZZ9999' }).set('Host', HOST).set(auth(studentToken));
    expect(bogus.status).toBe(404);
    expect((bogus.body as { code?: string }).code).toBe('class.join_code_invalid');
  });

  it('lấp thư mục cho mã tham gia: gỡ mục thì mã mất hiệu lực, lấp lại khôi phục, chạy lại không trùng, va chạm được báo cáo chứ không ghi đè', async () => {
    // Gỡ mục thư mục của mã: đường phân giải rơi về kho chung và
    // mã mất hiệu lực — thư mục là điểm chịu lực của C1.
    await withClient(cpUrl(), async (client) => {
      await client.query('DELETE FROM space_join_code_directory WHERE join_code = $1', [joinCode]);
    });
    const orphaned = await http(app).get('/api/v1/classes/join-preview').query({ code: joinCode }).set('Host', HOST).set(auth(studentToken));
    expect(orphaned.status).toBe(404);
    expect((orphaned.body as { code?: string }).code).toBe('class.join_code_invalid');

    // Lấp lại: mã được đăng ký lại đúng một mục.
    const first = await runBackfill();
    expect(first.joinCodesClaimed).toBe(1);
    expect(first.joinCodeConflicts).toEqual([]);
    const restored = await http(app).get('/api/v1/classes/join-preview').query({ code: joinCode }).set('Host', HOST).set(auth(studentToken));
    expect(restored.status).toBe(200);

    // Chạy lại: không sinh mục trùng, mã được tính là đã có sẵn.
    const second = await runBackfill();
    expect(second.joinCodesClaimed).toBe(0);
    expect(second.joinCodesAlreadyPresent).toBe(1);
    const codeRows = await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      return cpDb.select().from(spaceJoinCodeDirectory);
    });
    expect(codeRows.filter((row) => row.joinCode === joinCode)).toHaveLength(1);

    // Va chạm: một lớp thứ hai trong kho đích mang mã mà thư
    // mục đang ghi cho một không gian khác → lấp thư mục BÁO
    // CÁO va chạm và giữ nguyên mục của không gian kia.
    const secondClass = (await must(
      await http(app).post('/api/v1/classes').set('Host', HOST).set(auth(centreAdminToken)).send({ name: 'Lớp TĐ3 thứ hai' }),
      'create second class',
    )) as { id: string };
    const secondUpdated = (await must(
      await http(app).patch(`/api/v1/classes/${secondClass.id}`).set('Host', HOST).set(auth(centreAdminToken)).send({ allowSelfReport: true }),
      'open self report for second class',
    )) as { joinCode: string | null };
    const secondCode = secondUpdated.joinCode!;
    await withClient(cpUrl(), async (client) => {
      await client.query('UPDATE space_join_code_directory SET space_slug = $1 WHERE join_code = $2', ['khong-gian-khac', secondCode]);
    });
    const third = await runBackfill();
    expect(third.joinCodeConflicts).toEqual([{ joinCode: secondCode, classId: secondClass.id, ownerSpaceSlug: 'khong-gian-khac' }]);
    const afterConflict = await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      return cpDb.select().from(spaceJoinCodeDirectory);
    });
    expect(afterConflict.find((row) => row.joinCode === secondCode)!.spaceSlug).toBe('khong-gian-khac');
  });

  it('thư mục trỏ tới kho đích không chuẩn bị được thì lỗi tường minh, không trả rỗng giả hay từ chối oan', async () => {
    // Không gian "hỏng": đăng ký kho riêng trỏ tới một database
    // không tồn tại trên cụm; thư mục có mục trỏ về nó.
    process.env.SPACE_TEST_BROKEN_TD3_URL = clusterUrl('lms_test_khong_ton_tai_td3', CENTRE_ROLE, CENTRE_PASSWORD);
    await withClient(cpUrl(), async (client) => {
      const cpDb = drizzle({ client });
      await cpDb.insert(spaceRegistry).values([
        {
          slug: BROKEN_SLUG,
          name: 'Trung tâm hỏng TĐ3',
          kind: 'center',
          status: 'active',
          databaseName: 'lms_test_khong_ton_tai_td3',
          storageMode: 'dedicated',
          connectionRoleRef: CENTRE_ROLE,
          secretRef: 'env:SPACE_TEST_BROKEN_TD3_URL',
          schemaVersion: 'v1',
        },
      ]);
      await cpDb.insert(spaceMembershipDirectory).values([
        { globalUserId: memberId, spaceSlug: BROKEN_SLUG, spaceUserId: memberId, status: 'active' },
      ]);
      await cpDb.insert(spaceJoinCodeDirectory).values([{ joinCode: BROKEN_CODE, spaceSlug: BROKEN_SLUG }]);
    });
    emitSpaceRegistryChanged(BROKEN_SLUG);

    // Bộ chọn: mục thư mục trỏ tới kho không chuẩn bị được →
    // lỗi máy chủ tường minh, không phải danh sách thiếu trung
    // tâm một cách lặng lẽ.
    const memberToken = (await loginAt(HOST, memberUsername, STRONG_PASSWORD)).accessToken;
    const picker = await http(app).get('/api/v1/auth/tenants').set('Host', HOST).set(auth(memberToken));
    expect(picker.status).toBeGreaterThanOrEqual(500);

    // Mã tham gia: thư mục có mục nhưng kho đích không đọc được
    // → lỗi máy chủ tường minh, không phải 404 từ chối oan.
    const preview = await http(app).get('/api/v1/classes/join-preview').query({ code: BROKEN_CODE }).set('Host', HOST).set(auth(studentToken));
    expect(preview.status).toBeGreaterThanOrEqual(500);
  });
});
