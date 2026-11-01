import { INestApplication } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate } from 'otplib';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceRegistry } from '@lms/db/control-plane';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emitSpaceRegistryChanged } from '../../../src/db/routing/space-routing-events';
import { SpaceDatabaseService } from '../../../src/db/routing/space-database.service';
import { CAP_ALLOW } from '../../../src/modules/access/domain/permission';
import { ContextsService } from '../../../src/modules/access/contexts.service';
import { RolesService } from '../../../src/modules/access/roles.service';
import { TotpService } from '../../../src/modules/auth/totp.service';
import { TenantsService } from '../../../src/modules/tenants/tenants.service';
import { UsersService } from '../../../src/modules/users/users.service';
import {
  STRONG_PASSWORD,
  createTestApp,
  createUserViaApi,
  http,
  login,
  uniqueName,
} from '../../support/identity-access-helpers';

/**
 * Ca đầu-cuối của HỒ SƠ THÀNH VIÊN THEO TRUNG TÂM + TÁCH SITE CHÍNH
 * (issue #584): ứng dụng thật (toàn bộ chuỗi guard) chạy với ba
 * không gian ở kho riêng dựng riêng cho đợt này trên cùng cụm test
 * — hai trung tâm (kind `center`) và site chính (slug `trang-chinh`,
 * kind `platform`, kho riêng của nó) — mỗi kho có role ứng dụng
 * riêng, CONNECT của PUBLIC bị thu hồi, baseline nghiệp vụ áp bằng
 * role chủ kho; sổ đăng ký nằm ở database control plane riêng mà
 * ứng dụng đọc qua biến `CONTROL_PLANE_DATABASE_URL` đặt trước khi
 * ứng dụng khởi động. Dòng tenant của mỗi không gian được sao từ kho
 * chung vào đúng kho của nó (trạng thái sau di trú mà đợt #587 sẽ
 * tạo); quản trị đầu tiên của mỗi không gian được tạo BẰNG CHÍNH
 * service của ứng dụng bên trong `withSpaceDatabase` của không gian
 * đó (tài khoản + membership nội bộ + vai trò mang `tenant:manage`
 * tại context của tenant) — không ghi tay dòng role/membership bằng
 * SQL. Tài khoản kiểm chứng trong các ca sau đó được tạo qua ĐƯỜNG
 * API tạo người dùng của tenant tại chính địa chỉ của không gian
 * (`POST /tenants/:tenantId/users`), đúng đường mà issue yêu cầu:
 * tài khoản mới chỉ tồn tại trong kho của trung tâm đó.
 *
 * Điểm khác biệt cốt lõi so với spec #582 (và là điều spec này phải
 * bắt được): tài khoản kiểm chứng ở đây KHÔNG có bản sao nào ở kho
 * chung — nếu code còn tra kho chung ở bất kỳ khâu nào (guard xác
 * thực, guard tenant, cấp token, làm mới token), ca đó thất bại
 * ngay thay vì âm thầm dùng bản sao kho chung như spec #582.
 *
 * Các ca khoá các tiêu chí nghiệm thu của issue:
 * (1) cùng email đăng ký ở hai trung tâm kho riêng thành hai tài
 *     khoản độc lập (id khác nhau, không có dòng nào ở kho chung),
 *     đình chỉ một bên không ảnh hưởng bên kia, đổi mật khẩu một
 *     bên không ảnh hưởng bên kia;
 * (2) phiên (token lẫn cookie) của trung tâm A bị từ chối ở trung
 *     tâm B và ở site chính;
 * (3) chuyển tenant không áp dụng ở trung tâm kho riêng;
 * (4) site chính hoạt động như một không gian độc lập trên kho
 *     riêng của nó (đăng ký, đăng nhập, dữ kiện ở kho của nó);
 * (5) token platform và token nghiệp vụ không dùng chéo bề mặt
 *     (platform không gọi được API nghiệp vụ, nghiệp vụ không gọi
 *     được control plane);
 * (6) challenge MFA gắn với không gian đã cấp nó (đổi địa chỉ thì
 *     bước hai thất bại);
 * (7) đăng nhập ở kho riêng chỉ tạo family refresh trong kho đó;
 * (8) đường kho chung giữ nguyên hành vi (hồi quy gọn).
 */
const CP_DATABASE = 'lms_test_cp_584';
const CP_ROLE = 'lms_cp_test_584';
const CP_PASSWORD = 'cp-test-584';
const CENTRE_A_DATABASE = 'lms_test_centre_a_584';
const CENTRE_A_ROLE = 'lms_centre_a_584_app';
const CENTRE_A_PASSWORD = 'centre-a-584';
const CENTRE_B_DATABASE = 'lms_test_centre_b_584';
const CENTRE_B_ROLE = 'lms_centre_b_584_app';
const CENTRE_B_PASSWORD = 'centre-b-584';
const MAIN_DATABASE = 'lms_test_main_584';
const MAIN_ROLE = 'lms_main_584_app';
const MAIN_PASSWORD = 'main-584';
// Slug của hai trung tâm mang hậu tố ngẫu nhiên theo lượt chạy:
// tenant tương ứng được tạo thật trong database nghiệp vụ test
// DÙNG CHUNG của tầng e2e, nên slug cố định sẽ va chạm khi chạy
// lại spec trên cùng một database; địa chỉ (tên miền con) và dòng
// đăng ký đều suy ra từ slug nên tính nhất quán không đổi. Site
// chính mang slug cố định `trang-chinh` vì tenant platform đã có
// sẵn đúng slug đó trong kho chung.
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CENTRE_A_SLUG = `trung-tam-a-${RUN_SUFFIX}`;
const CENTRE_B_SLUG = `trung-tam-b-${RUN_SUFFIX}`;
const MAIN_SLUG = 'trang-chinh';
const HOST_A = `${CENTRE_A_SLUG}.test.local`;
const HOST_B = `${CENTRE_B_SLUG}.test.local`;
const HOST_MAIN = `${MAIN_SLUG}.test.local`;
const SHARED_SLUG = 'truong-mac-dinh';
const HOST_SHARED = `${SHARED_SLUG}.test.local`;
/** Mật khẩu mới dùng cho ca đổi mật khẩu một bên không ảnh hưởng bên kia. */
const DUAL_NEW_PASSWORD = 'NewStrong123!';

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

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'), true);
  }
}

/** Áp baseline nghiệp vụ vào một kho riêng bằng kết nối của chính role chủ kho đó. */
async function applyBusinessBaseline(connectionString: string): Promise<void> {
  const baseline = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre', '20261025163710_baseline', 'migration.sql');
  await applySqlFile(connectionString, baseline, true);
}

/** Giải mã phần payload của một access token JWT (không kiểm chứng chữ ký — chỉ đọc claim cho khẳng định). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('access token không có phần payload');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Sao một dòng (đọc từ kho chung) vào cùng bảng ở kho đích với
 * nguyên bộ cột — mô phỏng phần dữ kiện đã di trú của trung tâm.
 */
async function copyRow(
  sourceUrl: string,
  targetUrl: string,
  table: string,
  whereColumn: string,
  whereValue: string,
): Promise<void> {
  const row = await withClient(sourceUrl, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query(`SELECT * FROM ${quoted(table)} WHERE ${quoted(whereColumn)} = $1`, [
      whereValue,
    ]);
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

/** Đếm family refresh của một user trong một kho bằng kết nối trực tiếp (nền platform tường minh). */
async function countFamilies(connectionString: string, userId: string): Promise<number> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ count: string }>(
      'SELECT count(*) FROM refresh_token_family WHERE user_id = $1',
      [userId],
    );
    return Number(result.rows[0]!.count);
  });
}

/** Đếm dòng trong một bảng của một kho theo điều kiện (nền platform tường minh). */
async function countRows(connectionString: string, table: string, where: string, value: string): Promise<number> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ count: string }>(
      `SELECT count(*) FROM ${quoted(table)} WHERE ${where} = $1`,
      [value],
    );
    return Number(result.rows[0]!.count);
  });
}

describe('Hồ sơ thành viên theo trung tâm và tách site chính (đầu-cuối)', () => {
  let app: INestApplication;
  let adminToken = '';
  let tenantAId = '';
  let tenantBId = '';
  let mainTenantId = '';
  let sharedTenantId = '';
  let registryAId = '';
  let registryMainId = '';
  let adminAToken = '';
  let adminBToken = '';
  let adminMainToken = '';
  let dualEmail = '';
  let dualAId = '';
  let dualBId = '';
  let dualAUsername = '';
  let dualBUsername = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as never;
  };
  const loginAt = async (host: string, username: string, password: string) => {
    const res = await http(app).post('/api/v1/auth/token').set('Host', host).send({ username, password });
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`login at ${host} failed for ${username}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as { accessToken: string; refreshToken: string };
  };

  beforeAll(async () => {
    // Cấp phát control plane + ba kho riêng trên cụm test, đúng
    // khuôn ca tích hợp của khung (issue #581): role riêng cho
    // từng kho, CONNECT của PUBLIC bị thu hồi.
    const databases = [CP_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE, MAIN_DATABASE];
    const roleNames = [CP_ROLE, CENTRE_A_ROLE, CENTRE_B_ROLE, MAIN_ROLE];
    const passwords: Record<string, string> = {
      [CP_ROLE]: CP_PASSWORD, [CENTRE_A_ROLE]: CENTRE_A_PASSWORD,
      [CENTRE_B_ROLE]: CENTRE_B_PASSWORD, [MAIN_ROLE]: MAIN_PASSWORD,
    };
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of databases) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of roleNames) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      for (const role of roleNames) {
        await admin.query(`CREATE ROLE ${quoted(role)} LOGIN PASSWORD '${passwords[role]}'`);
      }
      for (let i = 0; i < databases.length; i += 1) {
        await admin.query(`CREATE DATABASE ${quoted(databases[i]!)} OWNER ${quoted(roleNames[i]!)}`);
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(databases[i]!)} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(databases[i]!)} TO ${quoted(roleNames[i]!)}`);
      }
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD));
    await applyBusinessBaseline(clusterUrl(MAIN_DATABASE, MAIN_ROLE, MAIN_PASSWORD));

    // Ứng dụng phải thấy control plane và bí mật các kho riêng
    // ngay từ lúc khởi động.
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
    process.env.SPACE_TEST_A_584_URL = clusterUrl('postgres', CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    process.env.SPACE_TEST_B_584_URL = clusterUrl('postgres', CENTRE_B_ROLE, CENTRE_B_PASSWORD);
    process.env.SPACE_TEST_MAIN_584_URL = clusterUrl('postgres', MAIN_ROLE, MAIN_PASSWORD);

    app = await createTestApp();

    // Dòng đăng ký kho riêng cho hai trung tâm; site chính cập
    // nhật lên dòng đã có (nếu seed lúc boot đã ghi dòng kho chung
    // cho `trang-chinh`) hoặc chèn mới — hai trường hợp đều về
    // cùng trạng thái: site chính ở kho riêng của nó.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const cpDb = drizzle({ client });
      const inserted = await cpDb
        .insert(spaceRegistry)
        .values([
          {
            slug: CENTRE_A_SLUG, name: 'Trung tâm A 584', kind: 'center', status: 'active',
            databaseName: CENTRE_A_DATABASE, storageMode: 'dedicated', connectionRoleRef: CENTRE_A_ROLE,
            secretRef: 'env:SPACE_TEST_A_584_URL', schemaVersion: 'v1',
          },
          {
            slug: CENTRE_B_SLUG, name: 'Trung tâm B 584', kind: 'center', status: 'active',
            databaseName: CENTRE_B_DATABASE, storageMode: 'dedicated', connectionRoleRef: CENTRE_B_ROLE,
            secretRef: 'env:SPACE_TEST_B_584_URL', schemaVersion: 'v1',
          },
        ])
        .returning({ id: spaceRegistry.id, slug: spaceRegistry.slug });
      registryAId = inserted.find((row) => row.slug === CENTRE_A_SLUG)!.id;
      const main = await client.query(
        `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version)
         VALUES ('${MAIN_SLUG}', 'Trang chính (spec 584)', 'platform', 'active', $1, 'dedicated', $2, 'env:SPACE_TEST_MAIN_584_URL', 'v1')
         ON CONFLICT (slug) DO UPDATE SET status = 'active', database_name = EXCLUDED.database_name,
           storage_mode = 'dedicated', connection_role_ref = EXCLUDED.connection_role_ref, secret_ref = EXCLUDED.secret_ref
         RETURNING id`,
        [MAIN_DATABASE, MAIN_ROLE],
      );
      registryMainId = (main.rows[0] as { id: string }).id;
    });
    emitSpaceRegistryChanged(MAIN_SLUG);

    adminToken = (await login(app, 'admin', 'Admin123!')).accessToken;

    // Hai tenant của hai trung tâm tạo bằng API công khai ở kho
    // chung (đường hiện tại), rồi dòng tenant được sao vào kho
    // riêng tương ứng — trạng thái sau di trú.
    const createdA = (await must(
      await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm A (spec 584)', slug: CENTRE_A_SLUG, kind: 'school',
      }),
      'create tenant A',
    )) as { id: string };
    tenantAId = createdA.id;
    const createdB = (await must(
      await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm B (spec 584)', slug: CENTRE_B_SLUG, kind: 'school',
      }),
      'create tenant B',
    )) as { id: string };
    tenantBId = createdB.id;
    await copyRow(process.env.DATABASE_URL!, clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), 'tenants', 'id', tenantAId);
    await copyRow(process.env.DATABASE_URL!, clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD), 'tenants', 'id', tenantBId);

    // Tenant platform của site chính sao vào kho riêng của nó.
    const tenantsList = (await must(
      await http(app).get('/api/v1/tenants').set(auth(adminToken)),
      'list tenants',
    )) as Array<{ id: string; slug: string }>;
    mainTenantId = tenantsList.find((tenant) => tenant.slug === MAIN_SLUG)!.id;
    sharedTenantId = tenantsList.find((tenant) => tenant.slug === SHARED_SLUG)!.id;
    await copyRow(process.env.DATABASE_URL!, clusterUrl(MAIN_DATABASE, MAIN_ROLE, MAIN_PASSWORD), 'tenants', 'id', mainTenantId);

    // Quản trị đầu tiên của mỗi không gian, tạo bằng chính service
    // của ứng dụng bên trong kho của không gian đó.
    const spaceDb = app.get(SpaceDatabaseService, { strict: false });
    const users = app.get(UsersService, { strict: false });
    const tenants = app.get(TenantsService, { strict: false });
    const contexts = app.get(ContextsService, { strict: false });
    const roles = app.get(RolesService, { strict: false });
    const createSpaceAdmin = async (slug: string, tenantId: string, host: string, prefix: string) => {
      const username = uniqueName(prefix);
      const email = `${username}@example.com`;
      const created = await spaceDb.withSpaceDatabase(slug, async () => {
        const user = await users.createUser({ username, email, password: STRONG_PASSWORD, firstName: 'Admin', lastName: 'Spec584' });
        await tenants.ensureActiveMembership(tenantId, user.id);
        const ctx = await contexts.ensureTenantContext(tenantId);
        const role = await roles.createRole({ name: 'Quản trị trung tâm (spec 584)', shortName: `spec584-admin-${slug}` });
        await roles.setCapabilityOverride(role.id, 'tenant:manage', ctx.id, CAP_ALLOW);
        await roles.assignRole(user.id, role.id, ctx.id);
        return user;
      }, { tenantId });
      const logged = await loginAt(host, username, STRONG_PASSWORD);
      return { user: created, token: logged.accessToken };
    };
    const adminA = await createSpaceAdmin(CENTRE_A_SLUG, tenantAId, HOST_A, 'admina');
    adminAToken = adminA.token;
    const adminB = await createSpaceAdmin(CENTRE_B_SLUG, tenantBId, HOST_B, 'adminb');
    adminBToken = adminB.token;
    const adminMain = await createSpaceAdmin(MAIN_SLUG, mainTenantId, HOST_MAIN, 'adminmain');
    adminMainToken = adminMain.token;

    // Cùng một email đăng ký qua đường API tạo người dùng của
    // tenant tại chính địa chỉ của từng trung tâm — hai tài khoản
    // độc lập, mỗi tài khoản chỉ tồn tại trong kho của trung tâm
    // đã tạo nó.
    dualEmail = `${uniqueName('dual')}@example.com`;
    dualAUsername = uniqueName('dual-a');
    const createdDualA = (await must(
      await http(app).post(`/api/v1/tenants/${tenantAId}/users`).set('Host', HOST_A).set(auth(adminAToken)).send({
        username: dualAUsername, email: dualEmail, password: STRONG_PASSWORD, firstName: 'Dual', lastName: 'A',
      }),
      'create dual user at A',
    )) as { id: string };
    dualAId = createdDualA.id;
    dualBUsername = uniqueName('dual-b');
    const createdDualB = (await must(
      await http(app).post(`/api/v1/tenants/${tenantBId}/users`).set('Host', HOST_B).set(auth(adminBToken)).send({
        username: dualBUsername, email: dualEmail, password: STRONG_PASSWORD, firstName: 'Dual', lastName: 'B',
      }),
      'create dual user at B',
    )) as { id: string };
    dualBId = createdDualB.id;
  }, 300_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    delete process.env.SPACE_TEST_A_584_URL;
    delete process.env.SPACE_TEST_B_584_URL;
    delete process.env.SPACE_TEST_MAIN_584_URL;
    delete process.env.CONTROL_PLANE_DATABASE_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE, MAIN_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE, CENTRE_B_ROLE, MAIN_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    }).catch(() => undefined);
  });

  it('cùng email đăng ký ở hai trung tâm kho riêng thành hai tài khoản độc lập, không có dòng nào ở kho chung', async () => {
    expect(dualAId).not.toBe(dualBId);
    // Không một dòng tài khoản hay membership nào mang email này ở kho chung.
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'email', dualEmail)).toBe(0);
    const membershipsInShared = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ count: string }>(
        'SELECT count(*) FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1',
        [dualEmail],
      );
      return Number(result.rows[0]!.count);
    });
    expect(membershipsInShared).toBe(0);
    // Mỗi tài khoản chỉ có đúng một dòng trong đúng kho của trung tâm đã tạo nó.
    expect(await countRows(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), 'users', 'id', dualAId)).toBe(1);
    expect(await countRows(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD), 'users', 'id', dualAId)).toBe(0);
    expect(await countRows(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD), 'users', 'id', dualBId)).toBe(1);
    expect(await countRows(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), 'users', 'id', dualBId)).toBe(0);
  });

  it('đổi mật khẩu ở một trung tâm không ảnh hưởng tài khoản cùng email ở trung tâm kia', async () => {
    const tokenB = (await loginAt(HOST_B, dualBUsername, STRONG_PASSWORD)).accessToken;
    const changed = await http(app)
      .post('/api/v1/auth/change-password')
      .set('Host', HOST_B)
      .set(auth(tokenB))
      .send({ currentPassword: STRONG_PASSWORD, newPassword: DUAL_NEW_PASSWORD });
    expect(changed.status).toBe(201);

    // Mật khẩu mới chỉ có hiệu lực ở trung tâm B.
    expect((await loginAt(HOST_B, dualBUsername, DUAL_NEW_PASSWORD)).accessToken).toBeTruthy();
    const loginBWithOld = await http(app).post('/api/v1/auth/token').set('Host', HOST_B).send({ username: dualBUsername, password: STRONG_PASSWORD });
    expect(loginBWithOld.status).toBe(401);
    // Trung tâm A không biết gì về lần đổi này: mật khẩu cũ vẫn dùng được, mật khẩu mới thì không.
    expect((await loginAt(HOST_A, dualAUsername, STRONG_PASSWORD)).accessToken).toBeTruthy();
    const loginAWithNew = await http(app).post('/api/v1/auth/token').set('Host', HOST_A).send({ username: dualAUsername, password: DUAL_NEW_PASSWORD });
    expect(loginAWithNew.status).toBe(401);
  });

  it('đình chỉ tài khoản ở một trung tâm không ảnh hưởng tài khoản cùng email ở trung tâm kia', async () => {
    await withClient(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('UPDATE users SET suspended = true WHERE id = $1', [dualAId]);
    });
    const loginA = await http(app).post('/api/v1/auth/token').set('Host', HOST_A).send({ username: dualAUsername, password: STRONG_PASSWORD });
    expect(loginA.status).toBe(403);
    // Bên B vẫn đăng nhập bình thường bằng mật khẩu mới đã đổi ở ca trước.
    expect((await loginAt(HOST_B, dualBUsername, DUAL_NEW_PASSWORD)).accessToken).toBeTruthy();
  });

  it('phiên token của trung tâm A bị từ chối ở trung tâm B và ở site chính', async () => {
    const atB = await http(app).get('/api/v1/users/me').set('Host', HOST_B).set(auth(adminAToken));
    expect(atB.status).toBe(401);
    expect((atB.body as { code?: string }).code).toBe('auth.centre_mismatch');
    const atMain = await http(app).get('/api/v1/users/me').set('Host', HOST_MAIN).set(auth(adminAToken));
    expect(atMain.status).toBe(401);
    expect((atMain.body as { code?: string }).code).toBe('auth.centre_mismatch');
  });

  it('phiên cookie của trung tâm A bị từ chối ở trung tâm B và ở site chính', async () => {
    // Tài khoản riêng cho ca cookie (không dùng quản trị A để khỏi
    // làm lệch luồng đăng nhập của các ca khác).
    const cookieUsername = uniqueName('cookie-a');
    await must(
      await http(app).post(`/api/v1/tenants/${tenantAId}/users`).set('Host', HOST_A).set(auth(adminAToken)).send({
        username: cookieUsername, email: `${cookieUsername}@example.com`, password: STRONG_PASSWORD, firstName: 'Cookie', lastName: 'A',
      }),
      'create cookie user at A',
    );
    const sessionLogin = async () => {
      const res = await http(app).post('/api/v1/auth/session/login').set('Host', HOST_A).send({ username: cookieUsername, password: STRONG_PASSWORD });
      expect(res.status).toBe(201);
      const setCookie = res.headers['set-cookie'] as unknown as string[];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie ?? '').split(';')[0]!;
      return cookie;
    };
    const cookieForB = await sessionLogin();
    const meAtB = await http(app).get('/api/v1/auth/session/me').set('Host', HOST_B).set('Cookie', cookieForB);
    expect(meAtB.status).toBe(401);
    expect((meAtB.body as { code?: string }).code).toBe('auth.session_space_mismatch');
    // Phiên bị huỷ ngay khi phát hiện lệch không gian nên ca ở
    // site chính cần một phiên mới.
    const cookieForMain = await sessionLogin();
    const meAtMain = await http(app).get('/api/v1/auth/session/me').set('Host', HOST_MAIN).set('Cookie', cookieForMain);
    expect(meAtMain.status).toBe(401);
    expect((meAtMain.body as { code?: string }).code).toBe('auth.session_space_mismatch');
  });

  it('chuyển tenant không áp dụng ở trung tâm kho riêng', async () => {
    const res = await http(app)
      .post(`/api/v1/auth/switch-tenant/${tenantBId}`)
      .set('Host', HOST_A)
      .set(auth(adminAToken));
    expect(res.status).toBe(403);
    expect((res.body as { code?: string }).code).toBe('auth.switch_tenant_not_in_space');
  });

  it('site chính hoạt động như một không gian độc lập trên kho riêng của nó', async () => {
    const communityUsername = uniqueName('congdong');
    const communityEmail = `${communityUsername}@example.com`;
    const created = (await must(
      await http(app).post(`/api/v1/tenants/${mainTenantId}/users`).set('Host', HOST_MAIN).set(auth(adminMainToken)).send({
        username: communityUsername, email: communityEmail, password: STRONG_PASSWORD, firstName: 'Cong', lastName: 'Dong',
      }),
      'create community user at main site',
    )) as { id: string };
    // Đăng nhập tại địa chỉ site chính thành công, token mang
    // centre_id của site chính và tid của tenant platform.
    const logged = await loginAt(HOST_MAIN, communityUsername, STRONG_PASSWORD);
    const payload = decodeJwtPayload(logged.accessToken);
    expect(payload['centre_id']).toBe(registryMainId);
    expect(payload['tid']).toBe(mainTenantId);
    // Dữ kiện nằm trong kho của site chính, không ở kho chung.
    expect(await countRows(clusterUrl(MAIN_DATABASE, MAIN_ROLE, MAIN_PASSWORD), 'users', 'id', created.id)).toBe(1);
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'email', communityEmail)).toBe(0);
    // Token của site chính bị từ chối ở trung tâm A.
    const atA = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(logged.accessToken));
    expect(atA.status).toBe(401);
    expect((atA.body as { code?: string }).code).toBe('auth.centre_mismatch');
  });

  it('token platform và token nghiệp vụ không dùng chéo bề mặt', async () => {
    const platformLogin = await http(app).post('/api/v1/auth/platform/login').send({ username: 'admin', password: 'Admin123!' });
    expect(platformLogin.status).toBe(201);
    const platformToken = (platformLogin.body as { accessToken: string; refreshToken?: string }).accessToken;
    expect(platformToken).toBeTruthy();
    expect((platformLogin.body as { refreshToken?: string }).refreshToken).toBeUndefined();
    expect(decodeJwtPayload(platformToken)['aud']).toBe('platform');
    // Token platform không gọi được API nghiệp vụ.
    const businessCall = await http(app).get('/api/v1/users/me').set(auth(platformToken));
    expect(businessCall.status).toBe(403);
    expect((businessCall.body as { code?: string }).code).toBe('auth.audience_denied');
    // Token nghiệp vụ không gọi được control plane.
    const controlCall = await http(app).get(`/api/v1/control-plane/spaces/by-slug/${CENTRE_A_SLUG}`).set(auth(adminToken));
    expect(controlCall.status).toBe(403);
    expect((controlCall.body as { code?: string }).code).toBe('auth.audience_denied');
    // Token platform gọi được control plane.
    const platformCall = await http(app).get(`/api/v1/control-plane/spaces/by-slug/${CENTRE_A_SLUG}`).set(auth(platformToken));
    expect(platformCall.status).toBe(200);
    expect((platformCall.body as { slug?: string }).slug).toBe(CENTRE_A_SLUG);
    // Tài khoản thường ở kho chung không qua được bề mặt đăng nhập
    // platform (tài khoản chỉ ở kho riêng sẽ chết sớm hơn ở bước
    // xác thực với 401, vì nó không tồn tại ở kho chung — ca đó
    // thuộc về đường kho riêng, không phải cổng quản trị platform).
    const sharedUsername = uniqueName('shared-plain');
    await must(
      await http(app).post('/api/v1/users').set(auth(adminToken)).send({
        username: sharedUsername, email: `${sharedUsername}@example.com`, password: STRONG_PASSWORD, firstName: 'Thuong', lastName: 'KhoChung',
      }),
      'create shared plain user',
    );
    const deniedLogin = await http(app).post('/api/v1/auth/platform/login').send({ username: sharedUsername, password: STRONG_PASSWORD });
    expect(deniedLogin.status).toBe(403);
    expect((deniedLogin.body as { code?: string }).code).toBe('auth.platform_admin_required');
  });

  it('challenge MFA gắn với không gian đã cấp nó: đổi địa chỉ thì bước hai thất bại', async () => {
    const totp = app.get(TotpService, { strict: false });
    const spaceDb = app.get(SpaceDatabaseService, { strict: false });
    // Tài khoản riêng cho ca MFA (không dùng quản trị A để khỏi
    // làm lệch luồng đăng nhập của các ca khác).
    const mfaUsername = uniqueName('mfa-a');
    const mfaUser = (await must(
      await http(app).post(`/api/v1/tenants/${tenantAId}/users`).set('Host', HOST_A).set(auth(adminAToken)).send({
        username: mfaUsername, email: `${mfaUsername}@example.com`, password: STRONG_PASSWORD, firstName: 'Mfa', lastName: 'A',
      }),
      'create MFA user at A',
    )) as { id: string };
    const { secret } = await spaceDb.withSpaceDatabase(CENTRE_A_SLUG, () => totp.setup(mfaUser.id, mfaUsername));
    await spaceDb.withSpaceDatabase(CENTRE_A_SLUG, async () => totp.confirm(mfaUser.id, await generate({ secret })));
    const challenged = await http(app).post('/api/v1/auth/token').set('Host', HOST_A).send({ username: mfaUsername, password: STRONG_PASSWORD });
    expect(challenged.status).toBe(201);
    expect((challenged.body as { mfaRequired?: boolean }).mfaRequired).toBe(true);
    const challengeToken = (challenged.body as { challengeToken: string }).challengeToken;
    // Hoàn tất ở địa chỉ trung tâm B bằng mã TOTP hợp lệ vẫn thất bại vì challenge thuộc không gian A.
    const atB = await http(app).post('/api/v1/auth/mfa/verify').set('Host', HOST_B).send({ challengeToken, code: await generate({ secret }) });
    expect(atB.status).toBe(401);
    expect((atB.body as { code?: string }).code).toBe('auth.mfa_challenge_invalid');
    // Hoàn tất ở đúng địa chỉ A thì thành công.
    const atA = await http(app).post('/api/v1/auth/mfa/verify').set('Host', HOST_A).send({ challengeToken, code: await generate({ secret }) });
    expect(atA.status).toBe(201);
    expect((atA.body as { accessToken?: string }).accessToken).toBeTruthy();
  });

  it('đăng nhập ở kho riêng chỉ tạo family refresh trong kho đó', async () => {
    const bLoginBefore = await countFamilies(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD), dualBId);
    await loginAt(HOST_B, dualBUsername, DUAL_NEW_PASSWORD);
    expect(await countFamilies(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD), dualBId)).toBeGreaterThan(bLoginBefore);
    expect(await countFamilies(process.env.DATABASE_URL!, dualBId)).toBe(0);
    expect(await countFamilies(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), dualBId)).toBe(0);
  });

  it('đường kho chung giữ nguyên hành vi: đăng nhập, chuyển tenant, tạo người dùng ở địa chỉ gốc và tên miền con', async () => {
    const member = await createUserViaApi(app, adminToken);
    await must(
      await http(app).post(`/api/v1/tenants/${sharedTenantId}/members`).set(auth(adminToken)).send({ userId: member.id }),
      'add member to shared tenant',
    );
    const memberApex = await login(app, member.username, STRONG_PASSWORD);
    const switched = (await must(
      await http(app).post(`/api/v1/auth/switch-tenant/${sharedTenantId}`).set(auth(memberApex.accessToken)),
      'switch member to shared tenant',
    )) as { accessToken: string };
    const payload = decodeJwtPayload(switched.accessToken);
    expect(payload['tid']).toBe(sharedTenantId);
    expect(payload['centre_id']).toBeUndefined();
    const atSubdomain = await http(app).get('/api/v1/users/me').set('Host', HOST_SHARED).set(auth(switched.accessToken));
    expect(atSubdomain.status).toBe(200);
    expect((atSubdomain.body as { id?: string }).id).toBe(member.id);
    const atApex = await http(app).get('/api/v1/users/me').set(auth(switched.accessToken));
    expect(atApex.status).toBe(200);
    expect((atApex.body as { id?: string }).id).toBe(member.id);
  });

  // --- Hồi quy các chốt fail-closed của đường kho riêng ----------
  //
  // Các ca dưới đây khoá những chốt fail-closed mà các ca trên chưa
  // chạm: phân giải kho gặp lỗi cấu hình khi tạo người dùng không
  // được rơi về đường kho chung, và bước làm mới phiên ở kho riêng
  // phải xét lại trạng thái của tenant cùng membership ngay trong
  // kho đó trước khi cấp token mới — một phiên ở kho riêng không
  // được sống lâu hơn trạng thái đã cấp ra nó.

  it('trung tâm kho riêng lệch cấu hình bí mật: tạo người dùng qua API thất bại và không sinh dòng nào ở kho chung', async () => {
    const badSlug = `trung-tam-lech-${RUN_SUFFIX}`;
    const createdBad = (await must(
      await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm lệch cấu hình (spec 584)', slug: badSlug, kind: 'school',
      }),
      'create misconfigured tenant',
    )) as { id: string };
    // Dòng đăng ký ghi trung tâm này ở kho riêng (dedicated) nhưng
    // secretRef trỏ vào một biến môi trường không tồn tại: bộ phân
    // giải kho ném `space_routing.secret_missing` — lỗi cấu hình
    // của một trung tâm kho riêng ĐÃ đăng ký, khác hẳn hai trường
    // hợp "chưa đăng ký / chưa cấu hình" được phép đi đường chung.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query(
        `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version)
         VALUES ($1, 'Trung tâm lệch cấu hình (spec 584)', 'center', 'active', 'lms_test_bad_584', 'dedicated', 'lms_bad_584_app', 'env:SPACE_TEST_MISSING_584_URL', 'v1')
         ON CONFLICT (slug) DO UPDATE SET status = 'active', database_name = EXCLUDED.database_name,
           storage_mode = 'dedicated', connection_role_ref = EXCLUDED.connection_role_ref, secret_ref = EXCLUDED.secret_ref`,
        [badSlug],
      );
    });
    emitSpaceRegistryChanged(badSlug);

    const badUsername = uniqueName('lech-cau-hinh');
    const badEmail = `${badUsername}@example.com`;
    const res = await http(app).post(`/api/v1/tenants/${createdBad.id}/users`).set(auth(adminToken)).send({
      username: badUsername, email: badEmail, password: STRONG_PASSWORD, firstName: 'Lech', lastName: 'CauHinh',
    });
    // Thao tác phải THẤT BẠI tại tầng phân giải kho thay vì lặng lẽ
    // tạo tài khoản ở kho chung...
    expect(res.status).toBe(500);
    // ...và không một dòng tài khoản hay membership nào sinh ở kho
    // chung cho email này.
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'email', badEmail)).toBe(0);
    const membershipsInShared = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ count: string }>(
        'SELECT count(*) FROM tenant_memberships m JOIN users u ON u.id = m.user_id WHERE u.email = $1',
        [badEmail],
      );
      return Number(result.rows[0]!.count);
    });
    expect(membershipsInShared).toBe(0);
  });

  it('làm mới phiên ở kho riêng bị từ chối khi membership của người dùng đã kết thúc trong kho đó', async () => {
    const username = uniqueName('refresh-member');
    const created = (await must(
      await http(app).post(`/api/v1/tenants/${tenantAId}/users`).set('Host', HOST_A).set(auth(adminAToken)).send({
        username, email: `${username}@example.com`, password: STRONG_PASSWORD, firstName: 'Refresh', lastName: 'Member',
      }),
      'create refresh member user at A',
    )) as { id: string };
    const logged = await loginAt(HOST_A, username, STRONG_PASSWORD);
    // Kết thúc membership ngay trong kho của trung tâm A: tài khoản
    // vẫn còn, phiên vẫn còn family, nhưng tư cách thành viên đã hết.
    await withClient(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query(
        `UPDATE tenant_memberships SET status = 'ended', ended_at = now() WHERE tenant_id = $1 AND user_id = $2`,
        [tenantAId, created.id],
      );
    });
    const res = await http(app).post('/api/v1/auth/refresh').set('Host', HOST_A).send({ refreshToken: logged.refreshToken });
    expect(res.status).toBe(401);
    expect((res.body as { code?: string }).code).toBe('tenant.not_member');
  });

  it('làm mới phiên ở kho riêng bị từ chối khi tenant trong kho đó đã bị đình chỉ, và làm mới lại được sau khi khôi phục', async () => {
    const username = uniqueName('refresh-tenant');
    await must(
      await http(app).post(`/api/v1/tenants/${tenantAId}/users`).set('Host', HOST_A).set(auth(adminAToken)).send({
        username, email: `${username}@example.com`, password: STRONG_PASSWORD, firstName: 'Refresh', lastName: 'Tenant',
      }),
      'create refresh tenant user at A',
    );
    const logged = await loginAt(HOST_A, username, STRONG_PASSWORD);
    const setTenantStatusInA = async (status: string) => {
      await withClient(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), async (client) => {
        await client.query("SELECT set_config('app.platform', 'on', false)");
        await client.query('UPDATE tenants SET status = $1 WHERE id = $2', [status, tenantAId]);
      });
    };
    try {
      await setTenantStatusInA('suspended');
      const res = await http(app).post('/api/v1/auth/refresh').set('Host', HOST_A).send({ refreshToken: logged.refreshToken });
      expect(res.status).toBe(401);
      expect((res.body as { code?: string }).code).toBe('tenant.not_active');
    } finally {
      await setTenantStatusInA('active');
    }
    // Lần từ chối không xoay và không thu hồi family: tenant được
    // kích hoạt lại thì chính refresh token cũ làm mới lại được.
    const again = await http(app).post('/api/v1/auth/refresh').set('Host', HOST_A).send({ refreshToken: logged.refreshToken });
    expect(again.status).toBe(201);
    expect((again.body as { accessToken?: string }).accessToken).toBeTruthy();
  });

  it('làm mới phiên ở kho riêng bị từ chối space.tenant_missing khi kho đó chưa có dòng tenant của chính nó', async () => {
    // Dựng không gian C: kho riêng thật (baseline đầy đủ) kèm dòng
    // đăng ký dedicated; tenant được tạo ở kho chung nhưng dòng
    // tenant KHÔNG được sao vào kho C — trạng thái "đã đăng ký
    // kho riêng, chưa cấp phát xong phần dữ kiện" mà chốt
    // fail-closed phải bắt như khi cấp phiên mới.
    const centreCDatabase = 'lms_test_centre_c_584';
    const centreCRole = 'lms_centre_c_584_app';
    const centreCPassword = 'centre-c-584';
    const centreCSlug = `trung-tam-c-${RUN_SUFFIX}`;
    const hostC = `${centreCSlug}.test.local`;
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(centreCDatabase)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${quoted(centreCRole)}`);
      await admin.query(`CREATE ROLE ${quoted(centreCRole)} LOGIN PASSWORD '${centreCPassword}'`);
      await admin.query(`CREATE DATABASE ${quoted(centreCDatabase)} OWNER ${quoted(centreCRole)}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(centreCDatabase)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(centreCDatabase)} TO ${quoted(centreCRole)}`);
    });
    await applyBusinessBaseline(clusterUrl(centreCDatabase, centreCRole, centreCPassword));
    process.env.SPACE_TEST_C_584_URL = clusterUrl('postgres', centreCRole, centreCPassword);
    try {
      const createdC = (await must(
        await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
          name: 'Trung tâm C (spec 584)', slug: centreCSlug, kind: 'school',
        }),
        'create tenant C',
      )) as { id: string };
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query(
          `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version)
           VALUES ($1, 'Trung tâm C (spec 584)', 'center', 'active', $2, 'dedicated', $3, 'env:SPACE_TEST_C_584_URL', 'v1')
           ON CONFLICT (slug) DO UPDATE SET status = 'active', database_name = EXCLUDED.database_name,
             storage_mode = 'dedicated', connection_role_ref = EXCLUDED.connection_role_ref, secret_ref = EXCLUDED.secret_ref`,
          [centreCSlug, centreCDatabase, centreCRole],
        );
      });
      emitSpaceRegistryChanged(centreCSlug);

      // Tài khoản và family refresh được tạo ngay trong kho C bằng
      // chính service của ứng dụng (family ghi theo đúng khuôn bảng
      // của hệ) — chỉ riêng dòng tenant của C là vắng mặt trong kho
      // của nó.
      const spaceDb = app.get(SpaceDatabaseService, { strict: false });
      const users = app.get(UsersService, { strict: false });
      const username = uniqueName('refresh-missing');
      const user = await spaceDb.withSpaceDatabase(centreCSlug, async () => users.createUser({
        username, email: `${username}@example.com`, password: STRONG_PASSWORD, firstName: 'Refresh', lastName: 'Missing',
      }), { tenantId: createdC.id });
      const refreshToken = randomBytes(48).toString('base64url');
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      await withClient(clusterUrl(centreCDatabase, centreCRole, centreCPassword), async (client) => {
        await client.query("SELECT set_config('app.platform', 'on', false)");
        await client.query(
          `INSERT INTO refresh_token_family (family_id, user_id, tenant_id, current_token_hash, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
          [randomUUID(), user.id, createdC.id, tokenHash],
        );
      });

      const res = await http(app).post('/api/v1/auth/refresh').set('Host', hostC).send({ refreshToken });
      expect(res.status).toBe(401);
      expect((res.body as { code?: string }).code).toBe('space.tenant_missing');
    } finally {
      // Chỉ gỡ dòng đăng ký và biến bí mật: pool kết nối tới kho C
      // còn sống trong ứng dụng tới khi cả file đóng app ở
      // `afterAll`, nên database/role của C được thả ở đầu ca của
      // lần chạy kế tiếp (khối dựng ở đầu ca đã DROP IF EXISTS) —
      // thả database ngay tại đây sẽ cắt ngang kết nối của pool
      // đang sống và sinh lỗi 57P01 ngoài ý muốn.
      delete process.env.SPACE_TEST_C_584_URL;
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query(`DELETE FROM space_registry WHERE slug = $1`, [centreCSlug]);
      }).catch(() => undefined);
      emitSpaceRegistryChanged(centreCSlug);
    }
  }, 180_000);
});
