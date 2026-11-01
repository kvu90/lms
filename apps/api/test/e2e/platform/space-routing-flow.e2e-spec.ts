import { INestApplication } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceRegistry } from '@lms/db/control-plane';
import { drizzle } from 'drizzle-orm/node-postgres';
import { emitSpaceRegistryChanged } from '../../../src/db/routing/space-routing-events';
import {
  STRONG_PASSWORD,
  createTestApp,
  createUserViaApi,
  http,
  login,
} from '../../support/identity-access-helpers';

/**
 * Ca đầu-cuối của ĐỊNH TUYẾN THEO TRUNG TÂM Ở TẦNG API (issue
 * #582): ứng dụng thật (toàn bộ chuỗi guard) chạy với hai trung
 * tâm kiểm chứng ở kho riêng dựng riêng cho đợt này — hai
 * database mới trên cùng cụm test (`lms_test_centre_a_582`,
 * `lms_test_centre_b_582`), mỗi kho có role ứng dụng riêng,
 * CONNECT của PUBLIC bị thu hồi, baseline nghiệp vụ áp bằng role
 * chủ kho; sổ đăng ký nằm ở database control plane riêng
 * (`lms_test_cp_582`) mà ứng dụng đọc qua biến
 * `CONTROL_PLANE_DATABASE_URL` đặt trước khi ứng dụng khởi động.
 * Hai tenant tương ứng được tạo bằng chính API công khai ở kho
 * chung, rồi dòng tenant (và với trung tâm A: dòng user + dòng
 * membership của giáo viên) được sao vào kho riêng tương ứng —
 * đúng trạng thái sau di trú mà đợt di trú dữ kiện (#587) sẽ tạo:
 * dữ kiện của trung tâm nằm ở kho của nó. Địa chỉ của trung tâm
 * là tên miền con mang slug (`<slug>.test.local`) theo quy ước
 * địa chỉ của hệ.
 *
 * Các ca khoá các tiêu chí nghiệm thu của issue ở phía API:
 * (1) access token của phiên thuộc trung tâm kho riêng mang
 *     claim `centre_id` bằng định danh đăng ký của trung tâm;
 *     token của phiên ở kho chung không mang claim;
 * (2) token của trung tâm A mang tới địa chỉ của trung tâm B bị
 *     từ chối 401 `auth.centre_mismatch` TRƯỚC tầng dữ kiện —
 *     kiểm chứng bằng số kết nối thật vào kho B (không một kết
 *     nối nào của role kho B được mở bởi request bị từ chối);
 * (3) đăng nhập tại địa chỉ của trung tâm A đọc/ghi ở kho A:
 *     family refresh được tạo trong kho A (không tạo ở kho
 *     chung), tài khoản chỉ có ở kho chung thì đăng nhập tại địa
 *     chỉ A thất bại, và hồ sơ đọc tại địa chỉ A mang dữ kiện
 *     của kho A trong khi cùng token đọc ở địa chỉ gốc cho dữ
 *     kiện của kho chung;
 * (4) trung tâm bị đình chỉ trên sổ thì traffic nghiệp vụ tại
 *     địa chỉ của nó bị từ chối 403 `space.not_active`, dữ kiện
 *     trong kho của nó còn nguyên, và đường vận hành platform
 *     (quản trị viên site chính ở tenant platform) vẫn vào được;
 * (5) trung tâm ở kho chung giữ nguyên hành vi hiện tại ở cả địa
 *     chỉ gốc lẫn tên miền con của nó.
 */
const CP_DATABASE = 'lms_test_cp_582';
const CP_ROLE = 'lms_cp_test_582';
const CP_PASSWORD = 'cp-test-582';
const CENTRE_A_DATABASE = 'lms_test_centre_a_582';
const CENTRE_A_ROLE = 'lms_centre_a_582_app';
const CENTRE_A_PASSWORD = 'centre-a-582';
const CENTRE_B_DATABASE = 'lms_test_centre_b_582';
const CENTRE_B_ROLE = 'lms_centre_b_582_app';
const CENTRE_B_PASSWORD = 'centre-b-582';
// Slug của hai trung tâm mang hậu tố ngẫu nhiên theo lượt chạy:
// tenant tương ứng được tạo thật trong database nghiệp vụ test
// DÙNG CHUNG của tầng e2e, nên slug cố định sẽ va chạm khi chạy
// lại spec trên cùng một database; địa chỉ (tên miền con) và dòng
// đăng ký đều suy ra từ slug nên tính nhất quán không đổi.
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CENTRE_A_SLUG = `trung-tam-a-${RUN_SUFFIX}`;
const CENTRE_B_SLUG = `trung-tam-b-${RUN_SUFFIX}`;
const HOST_A = `${CENTRE_A_SLUG}.test.local`;
const HOST_B = `${CENTRE_B_SLUG}.test.local`;
const SHARED_SLUG = 'truong-mac-dinh';
const HOST_SHARED = `${SHARED_SLUG}.test.local`;
/** Dấu phân biệt ghi thẳng vào dòng user ở kho A: hồ sơ đọc qua địa chỉ A phải mang dấu này, đọc ở kho chung thì không. */
const CENTRE_A_FIRST_NAME = 'DauAnKhoA582';

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

/** Đếm kết nối đang mở vào một database của một role trên cụm (qua pg_stat_activity ở database quản trị). */
async function countConnections(database: string, role: string): Promise<number> {
  return withClient(clusterUrl('postgres'), async (admin) => {
    const result = await admin.query<{ count: string }>(
      'SELECT count(*) FROM pg_stat_activity WHERE datname = $1 AND usename = $2',
      [database, role],
    );
    return Number(result.rows[0]!.count);
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

describe('Định tuyến theo trung tâm ở tầng API (đầu-cuối)', () => {
  let app: INestApplication;
  let adminToken = '';
  let tenantAId = '';
  let tenantBId = '';
  let sharedTenantId = '';
  let registryAId = '';
  let teacherId = '';
  let teacherUsername = '';
  let teacherTokenA = '';
  let sharedOnlyUsername = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as never;
  };

  beforeAll(async () => {
    // Cấp phát control plane + hai kho riêng trên cụm test, đúng
    // khuôn ca tích hợp của khung (issue #581): role riêng cho
    // từng kho, CONNECT của PUBLIC bị thu hồi.
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE, CENTRE_B_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_A_ROLE} LOGIN PASSWORD '${CENTRE_A_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_B_ROLE} LOGIN PASSWORD '${CENTRE_B_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_A_DATABASE} OWNER ${CENTRE_A_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_B_DATABASE} OWNER ${CENTRE_B_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_A_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_A_DATABASE} TO ${CENTRE_A_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_B_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_B_DATABASE} TO ${CENTRE_B_ROLE}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD));

    // Ứng dụng phải thấy control plane và hai bí mật kho riêng
    // ngay từ lúc khởi động (seed lúc boot ghi sổ cho hai không
    // gian hiện hữu vào chính control plane này).
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
    process.env.SPACE_TEST_A_582_URL = clusterUrl('postgres', CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    process.env.SPACE_TEST_B_582_URL = clusterUrl('postgres', CENTRE_B_ROLE, CENTRE_B_PASSWORD);

    app = await createTestApp();

    // Hai dòng đăng ký kho riêng trong sổ (seed của ứng dụng đã
    // ghi hai dòng kho chung của Trang chính và trường mặc định).
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const cpDb = drizzle({ client });
      const inserted = await cpDb
        .insert(spaceRegistry)
        .values([
          {
            slug: CENTRE_A_SLUG,
            name: 'Trung tâm A 582',
            kind: 'center',
            status: 'active',
            databaseName: CENTRE_A_DATABASE,
            storageMode: 'dedicated',
            connectionRoleRef: CENTRE_A_ROLE,
            secretRef: 'env:SPACE_TEST_A_582_URL',
            schemaVersion: 'v1',
          },
          {
            slug: CENTRE_B_SLUG,
            name: 'Trung tâm B 582',
            kind: 'center',
            status: 'active',
            databaseName: CENTRE_B_DATABASE,
            storageMode: 'dedicated',
            connectionRoleRef: CENTRE_B_ROLE,
            secretRef: 'env:SPACE_TEST_B_582_URL',
            schemaVersion: 'v1',
          },
        ])
        .returning({ id: spaceRegistry.id, slug: spaceRegistry.slug });
      registryAId = inserted.find((row) => row.slug === CENTRE_A_SLUG)!.id;
    });

    adminToken = (await login(app, 'admin', 'Admin123!')).accessToken;

    // Hai tenant của hai trung tâm tạo bằng API công khai ở kho
    // chung (đường hiện tại), rồi dòng tenant được sao vào kho
    // riêng tương ứng — trạng thái sau di trú.
    const createdA = (await must(
      await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm A (spec 582)',
        slug: CENTRE_A_SLUG,
        kind: 'school',
      }),
      'create tenant A',
    )) as { id: string };
    tenantAId = createdA.id;
    const createdB = (await must(
      await http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm B (spec 582)',
        slug: CENTRE_B_SLUG,
        kind: 'school',
      }),
      'create tenant B',
    )) as { id: string };
    tenantBId = createdB.id;
    await copyRow(process.env.DATABASE_URL!, clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), 'tenants', 'id', tenantAId);
    await copyRow(process.env.DATABASE_URL!, clusterUrl(CENTRE_B_DATABASE, CENTRE_B_ROLE, CENTRE_B_PASSWORD), 'tenants', 'id', tenantBId);

    // Giáo viên là thành viên của trung tâm A: tạo ở kho chung,
    // thêm membership bằng API, rồi sao dòng user + dòng
    // membership vào kho A và đóng dấu phân biệt lên dòng user
    // ở kho A.
    const teacher = await createUserViaApi(app, adminToken);
    teacherId = teacher.id;
    teacherUsername = teacher.username;
    await must(
      await http(app).post(`/api/v1/tenants/${tenantAId}/members`).set(auth(adminToken)).send({ userId: teacherId }),
      'add teacher to tenant A',
    );
    await copyRow(process.env.DATABASE_URL!, clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), 'users', 'id', teacherId);
    const membershipRow = await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      const result = await client.query<{ id: string }>(
        'SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
        [tenantAId, teacherId],
      );
      return result.rows[0];
    });
    if (!membershipRow) throw new Error('membership của giáo viên ở tenant A không tồn tại');
    await copyRow(
      process.env.DATABASE_URL!,
      clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD),
      'tenant_memberships',
      'id',
      membershipRow.id,
    );
    await withClient(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('UPDATE users SET first_name = $1 WHERE id = $2', [CENTRE_A_FIRST_NAME, teacherId]);
    });

    // Token của giáo viên cho tenant A qua đường chuyển tenant
    // như người dùng thật.
    const teacherApex = await login(app, teacherUsername, STRONG_PASSWORD);
    const switched = (await must(
      await http(app).post(`/api/v1/auth/switch-tenant/${tenantAId}`).set(auth(teacherApex.accessToken)),
      'switch teacher to tenant A',
    )) as { accessToken: string };
    teacherTokenA = switched.accessToken;

    // Một tài khoản chỉ tồn tại ở kho chung (không sao vào kho
    // riêng nào) cho ca đăng nhập lệch kho.
    const sharedOnly = await createUserViaApi(app, adminToken);
    sharedOnlyUsername = sharedOnly.username;

    // Tenant ở kho chung cho ca hồi quy: trường mặc định đã được
    // seed cùng ứng dụng.
    const tenantsList = (await must(
      await http(app).get('/api/v1/tenants').set(auth(adminToken)),
      'list tenants',
    )) as Array<{ id: string; slug: string }>;
    sharedTenantId = tenantsList.find((tenant) => tenant.slug === SHARED_SLUG)!.id;
  }, 300_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    delete process.env.SPACE_TEST_A_582_URL;
    delete process.env.SPACE_TEST_B_582_URL;
    delete process.env.CONTROL_PLANE_DATABASE_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE, CENTRE_B_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE, CENTRE_B_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    }).catch(() => undefined);
  });

  it('token của phiên thuộc trung tâm kho riêng mang centre_id bằng định danh đăng ký của trung tâm; token ở kho chung không mang claim', async () => {
    expect(decodeJwtPayload(teacherTokenA)['centre_id']).toBe(registryAId);
    expect(decodeJwtPayload(teacherTokenA)['tid']).toBe(tenantAId);

    // Giáo viên thứ hai là thành viên của tenant ở kho chung:
    // token chuyển tenant của họ không mang centre_id.
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
  });

  it('token của trung tâm A tới địa chỉ của trung tâm B bị từ chối 401 auth.centre_mismatch trước tầng dữ kiện — không một kết nối nào vào kho B', async () => {
    // Chưa có request hợp lệ nào tới địa chỉ B trước ca này nên
    // kho B chưa có kết nối nào của role kho B từ ứng dụng.
    expect(await countConnections(CENTRE_B_DATABASE, CENTRE_B_ROLE)).toBe(0);

    const res = await http(app)
      .get('/api/v1/users/me')
      .set('Host', HOST_B)
      .set(auth(teacherTokenA));

    expect(res.status).toBe(401);
    expect((res.body as { code?: string }).code).toBe('auth.centre_mismatch');
    // Việc từ chối xảy ra ở guard trước bước chuẩn bị: kho B vẫn
    // không có kết nối nào — request bị từ chối không chạm được
    // vào kho của trung tâm tại địa chỉ.
    expect(await countConnections(CENTRE_B_DATABASE, CENTRE_B_ROLE)).toBe(0);
  });

  it('đăng nhập tại địa chỉ của trung tâm A tạo family refresh trong kho A chứ không ở kho chung, và hồ sơ đọc tại địa chỉ A mang dữ kiện của kho A', async () => {
    const familiesInSharedBefore = await countFamilies(process.env.DATABASE_URL!, teacherId);
    expect(await countFamilies(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), teacherId)).toBe(0);

    const res = await http(app)
      .post('/api/v1/auth/token')
      .set('Host', HOST_A)
      .send({ username: teacherUsername, password: STRONG_PASSWORD });
    expect(res.status).toBe(201);
    const loginPayload = decodeJwtPayload((res.body as { accessToken: string }).accessToken);
    expect(loginPayload['centre_id']).toBe(registryAId);

    expect(
      await countFamilies(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), teacherId),
    ).toBeGreaterThanOrEqual(1);
    expect(await countFamilies(process.env.DATABASE_URL!, teacherId)).toBe(familiesInSharedBefore);

    // Cùng một token, hồ sơ đọc tại địa chỉ A mang dấu của kho A;
    // đọc ở địa chỉ gốc (kho chung) mang dữ kiện gốc ở kho chung.
    const meAtA = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(teacherTokenA));
    expect(meAtA.status).toBe(200);
    expect((meAtA.body as { firstName?: string }).firstName).toBe(CENTRE_A_FIRST_NAME);
    const meAtApex = await http(app).get('/api/v1/users/me').set(auth(teacherTokenA));
    expect(meAtApex.status).toBe(200);
    expect((meAtApex.body as { firstName?: string }).firstName).not.toBe(CENTRE_A_FIRST_NAME);
  });

  it('tài khoản chỉ tồn tại ở kho chung đăng nhập tại địa chỉ của trung tâm A thì thất bại vì kho A không có tài khoản đó', async () => {
    const res = await http(app)
      .post('/api/v1/auth/token')
      .set('Host', HOST_A)
      .send({ username: sharedOnlyUsername, password: STRONG_PASSWORD });
    expect(res.status).toBe(401);
  });

  it('trung tâm bị đình chỉ thì traffic nghiệp vụ tại địa chỉ của nó bị từ chối 403 space.not_active, dữ kiện còn nguyên, và đường vận hành platform vẫn vào được', async () => {
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      await client.query('UPDATE space_registry SET status = $1 WHERE slug = $2', ['suspended', CENTRE_A_SLUG]);
    });
    emitSpaceRegistryChanged(CENTRE_A_SLUG);
    try {
      const blocked = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(teacherTokenA));
      expect(blocked.status).toBe(403);
      expect((blocked.body as { code?: string }).code).toBe('space.not_active');

      // Đường vận hành platform tường minh: quản trị viên ở
      // tenant platform không bị chặn bởi trạng thái của trung tâm.
      const operations = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(adminToken));
      expect(operations.status).toBe(200);

      // Dữ kiện của trung tâm trong kho của nó còn nguyên vẹn.
      const tenantRows = await withClient(
        clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD),
        async (client) => {
          await client.query("SELECT set_config('app.platform', 'on', false)");
          const result = await client.query<{ count: string }>(
            'SELECT count(*) FROM tenants WHERE id = $1',
            [tenantAId],
          );
          return Number(result.rows[0]!.count);
        },
      );
      expect(tenantRows).toBe(1);
    } finally {
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query('UPDATE space_registry SET status = $1 WHERE slug = $2', ['active', CENTRE_A_SLUG]);
      });
      emitSpaceRegistryChanged(CENTRE_A_SLUG);
    }
  });

  it('trung tâm ở kho chung giữ nguyên hành vi hiện tại ở cả tên miền con của nó lẫn địa chỉ gốc', async () => {
    const member = await createUserViaApi(app, adminToken);
    await must(
      await http(app).post(`/api/v1/tenants/${sharedTenantId}/members`).set(auth(adminToken)).send({ userId: member.id }),
      'add member to shared tenant (regression)',
    );
    const memberApex = await login(app, member.username, STRONG_PASSWORD);
    const switched = (await must(
      await http(app).post(`/api/v1/auth/switch-tenant/${sharedTenantId}`).set(auth(memberApex.accessToken)),
      'switch member to shared tenant (regression)',
    )) as { accessToken: string };

    const atSubdomain = await http(app).get('/api/v1/users/me').set('Host', HOST_SHARED).set(auth(switched.accessToken));
    expect(atSubdomain.status).toBe(200);
    expect((atSubdomain.body as { id?: string }).id).toBe(member.id);
    const atApex = await http(app).get('/api/v1/users/me').set(auth(switched.accessToken));
    expect(atApex.status).toBe(200);
    expect((atApex.body as { id?: string }).id).toBe(member.id);
  });
});
