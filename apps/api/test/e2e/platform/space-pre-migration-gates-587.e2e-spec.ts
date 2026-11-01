import { JwtService } from '@nestjs/jwt';
import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spaceRegistry } from '@lms/db/control-plane';
import { drizzle } from 'drizzle-orm/node-postgres';

/**
 * Better Auth phải bật ngay từ lúc AppModule được import (ConfigModule
 * kiểm chứng cấu hình khi import module, như khuôn của spec
 * better-auth-flow): đặt biến môi trường ở đầu file, rồi import
 * helpers ĐỘNG trong beforeAll — import tĩnh helpers sẽ kéo AppModule
 * vào trước khi các biến này được gán.
 */
const BETTER_AUTH_SECRET = 'test-better-auth-secret-at-least-32-chars';
process.env.BETTER_AUTH_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = BETTER_AUTH_SECRET;
process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'http://localhost:5173';

type Helpers = typeof import('../../support/identity-access-helpers');
let helpers: Helpers;

/**
 * Dựng app test đúng khuôn bootstrap thật (main.ts): mount handler
 * Better Auth TRƯỚC khi init, kèm khung định tuyến kho để đường
 * ghi đăng nhập đi đúng kho đích tại địa chỉ trung tâm ở kho
 * riêng — `helpers.createTestApp` không mount Better Auth nên ca
 * (e) không dùng được nó. Mọi import của AppModule đều động bên
 * trong hàm này (gọi từ beforeAll, sau khi biến môi trường Better
 * Auth đã gán ở đầu file).
 */
async function createMountedTestApp(): Promise<INestApplication> {
  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../../../src/app.module');
  const { enableTrustedProxy } = await import('../../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../../src/modules/auth/better-auth/better-auth.service'
  );
  const { SpaceDatabaseService: SpaceDatabaseServiceClass } = await import(
    '../../../src/db/routing/space-database.service'
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  const betterAuth = app.get(BetterAuthServiceClass);
  const spaceDb = app.get(SpaceDatabaseServiceClass, { strict: false });
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth(), spaceDb);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

/** Lấy cặp cookie phiên Better Auth từ header set-cookie của một response đăng nhập. */
function sessionCookieFrom(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((value) => value.includes('better-auth.session_token='));
  if (!raw) throw new Error(`no Better Auth session cookie in: ${JSON.stringify(setCookie)}`);
  return raw.split(';')[0]!;
}

/**
 * Ký giá trị cookie phiên Better Auth đúng định dạng mà handler của
 * nó kiểm chứng khi đọc (`<token>.<base64 HMAC-SHA256(secret,
 * token)>`, rồi encodeURIComponent toàn bộ — xem better-call
 * `serializeSignedCookie`/`getSignedCookie`): cookie không ký thì
 * `getSession` trả null ngay trước khi tra bảng phiên.
 */
function signedBetterAuthCookie(token: string): string {
  const signature = createHmac('sha256', BETTER_AUTH_SECRET).update(token).digest('base64');
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

/**
 * Ca đầu-cuối của CÁC CỔNG TIỀN DI TRÚ (Phần A, issue #587):
 * ứng dụng thật (toàn bộ chuỗi guard) chạy với một trung tâm kiểm
 * chứng ở kho riêng dựng riêng cho đợt này — database mới trên
 * cùng cụm test (`lms_test_centre_a_587`), role ứng dụng riêng,
 * CONNECT của PUBLIC bị thu hồi, baseline nghiệp vụ áp bằng role
 * chủ kho; sổ đăng ký nằm ở database control plane riêng
 * (`lms_test_cp_587`) mà ứng dụng đọc qua biến
 * `CONTROL_PLANE_DATABASE_URL` đặt trước khi ứng dụng khởi động.
 * Tenant tương ứng được tạo bằng chính API công khai ở kho chung,
 * rồi dòng tenant (và dòng user + dòng membership của từng tài
 * khoản kiểm chứng) được sao vào kho riêng — đúng trạng thái sau
 * di trú mà đợt di trú dữ kiện (#587) sẽ tạo: dữ kiện của trung
 * tâm nằm ở kho của nó. Địa chỉ của trung tâm là tên miền con
 * mang slug (`<slug>.test.local`) theo quy ước địa chỉ của hệ.
 *
 * Các ca khoá đúng các cổng tiền di trú của Phần A:
 * (a) đối chứng dương — token mang claim của trung tâm kho riêng
 *     đọc được hồ sơ từ kho đích (dấu phân biệt ghi ở kho đích);
 * (b) cổng 1b — token JWT cũ không mang claim `centre_id` của tài
 *     khoản chỉ còn ở kho riêng bị từ chối 401
 *     `auth.centre_mismatch`, KHÔNG cho qua theo slug khớp;
 * (c) cổng 1a — thành viên đã bị thu hồi ở kho đích (membership
 *     đã kết thúc sau khi token được cấp) bị từ chối 401
 *     `tenant.membership_inactive`;
 * (d) cổng 1c/A2 — phiên cookie Better Auth của tài khoản ở kho
 *     riêng đọc được hồ sơ qua địa chỉ của chính trung tâm đó
 *     (phiên và tài khoản đều đọc qua kho đích, không đọc kho
 *     chung). Phiên được gieo thẳng vào bảng `session` ở kho đích
 *     — ca này khoá đường ĐỌC theo địa chỉ của guard.
 * (e) đường GHI đăng nhập Better Auth (B1, vòng sửa sau phán quyết
 *     CHƯA ĐẠT của PR #627) — tài khoản chỉ ở kho riêng đăng nhập
 *     bằng luồng web Better Auth (`POST /api/v1/auth/sign-in/
 *     username`) tại địa chỉ của chính trung tâm đó phải thành
 *     công, phiên phải được GHI vào bảng `session` ở kho đích (không
 *     phải kho chung), và cookie phiên đó đọc được hồ sơ mang dấu
 *     kho đích. Ca này khoá đúng khâu ghi mà ca (d) bỏ qua (gieo
 *     phiên thẳng) và ca đối chứng dương bỏ qua (giáo viên có ở cả
 *     hai kho).
 * (f) đối chứng âm của (e) — tài khoản chỉ ở kho chung (có
 *     credential Better Auth hẳn hoi, đăng nhập được ở địa chỉ
 *     platform) phải bị TỪ CHỐI khi đăng nhập tại địa chỉ của
 *     trung tâm kho riêng: kiểm chứng credential tại địa chỉ đó
 *     chỉ được chạm kho đích. Đây là chiều xuyên thủng đã gặp ở
 *     production trong thí điểm nhantin (tiền điều kiện TĐ5):
 *     khi Host không tới được API nguyên vẹn, ca này ở production
 *     trả 200 cho tài khoản kho chung.
 * (g) địa chỉ platform giữ nguyên hành vi hiện tại sau khi đường
 *     địa chỉ trung tâm được nối đúng: tài khoản kho chung đăng
 *     nhập được tại địa chỉ platform và phiên ghi ở kho chung;
 *     tài khoản chỉ ở kho riêng bị từ chối tại địa chỉ platform.
 */
const CP_DATABASE = 'lms_test_cp_587';
const CP_ROLE = 'lms_cp_test_587';
const CP_PASSWORD = 'cp-test-587';
const CENTRE_A_DATABASE = 'lms_test_centre_a_587';
const CENTRE_A_ROLE = 'lms_centre_a_587_app';
const CENTRE_A_PASSWORD = 'centre-a-test-587';
// Slug của trung tâm mang hậu tố ngẫu nhiên theo lượt chạy:
// tenant tương ứng được tạo thật trong database nghiệp vụ test
// DÙNG CHUNG của tầng e2e, nên slug cố định sẽ va chạm khi chạy
// lại spec trên cùng một database.
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CENTRE_A_SLUG = `trung-tam-a-587-${RUN_SUFFIX}`;
const HOST_A = `${CENTRE_A_SLUG}.test.local`;
/** Dấu phân biệt ghi thẳng vào dòng user ở kho A: hồ sơ đọc qua địa chỉ A phải mang dấu này, đọc ở kho chung thì không. */
const CENTRE_A_FIRST_NAME = 'DauAnKhoA587';

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
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
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
  const baseline = join(__dirname, '..', '..', '..', 'drizzle', '20261025163710_baseline', 'migration.sql');
  await applySqlFile(connectionString, baseline, true);
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

/** Sao dòng user + dòng membership của một tài khoản vào kho đích, rồi đóng dấu phân biệt lên dòng user ở kho đích khi có. */
async function copyMemberToCentre(userId: string, tenantId: string, marker: string | null): Promise<void> {
  const centreUrl = clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);
  await copyRow(process.env.DATABASE_URL!, centreUrl, 'users', 'id', userId);
  const membershipRow = await withClient(process.env.DATABASE_URL!, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ id: string }>(
      'SELECT id FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    );
    return result.rows[0];
  });
  if (!membershipRow) throw new Error('membership của tài khoản ở tenant A không tồn tại');
  await copyRow(process.env.DATABASE_URL!, centreUrl, 'tenant_memberships', 'id', membershipRow.id);
  if (marker !== null) {
    await withClient(centreUrl, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('UPDATE users SET first_name = $1 WHERE id = $2', [marker, userId]);
    });
  }
}

/** Đếm dòng theo một cột định danh trong một bảng ở một kho (nền platform tường minh). */
async function countRows(
  connectionString: string,
  table: string,
  column: string,
  value: string,
): Promise<number> {
  return withClient(connectionString, async (client) => {
    await client.query("SELECT set_config('app.platform', 'on', false)");
    const result = await client.query<{ count: string }>(
      `SELECT count(*) FROM ${quoted(table)} WHERE ${quoted(column)} = $1`,
      [value],
    );
    return Number(result.rows[0]!.count);
  });
}

/** Giải mã phần payload của một access token JWT (không kiểm chứng chữ ký — chỉ đọc claim cho khẳng định). */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const segment = token.split('.')[1];
  if (!segment) throw new Error('access token không có phần payload');
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('Các cổng tiền di trú ở kho riêng (đầu-cuối, issue #587)', () => {
  let app: INestApplication;
  let adminToken = '';
  let tenantAId = '';
  let registryAId = '';
  let teacherTokenA = '';
  let teacherUsername = '';
  let teacherId = '';
  let betterAuthSessionToken = '';
  let revokedTokenA = '';
  let dedicatedOnlyId = '';
  let dedicatedOnlyUsername = '';
  let dedicatedOnlyBaId = '';
  let dedicatedOnlyBaUsername = '';
  let sharedOnlyBaId = '';
  let sharedOnlyBaUsername = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as never;
  };

  beforeAll(async () => {
    // Cấp phát control plane + kho riêng trên cụm test, đúng khuôn
    // ca tích hợp của khung (issue #581): role riêng cho từng kho,
    // CONNECT của PUBLIC bị thu hồi.
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${CP_ROLE} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${CENTRE_A_ROLE} LOGIN PASSWORD '${CENTRE_A_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${CP_DATABASE} OWNER ${CP_ROLE}`);
      await admin.query(`CREATE DATABASE ${CENTRE_A_DATABASE} OWNER ${CENTRE_A_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CP_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CP_DATABASE} TO ${CP_ROLE}`);
      await admin.query(`REVOKE CONNECT ON DATABASE ${CENTRE_A_DATABASE} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${CENTRE_A_DATABASE} TO ${CENTRE_A_ROLE}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));
    await applyBusinessBaseline(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD));

    // Ứng dụng phải thấy control plane và bí mật kho riêng ngay từ
    // lúc khởi động.
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
    process.env.SPACE_TEST_A_587_URL = clusterUrl('postgres', CENTRE_A_ROLE, CENTRE_A_PASSWORD);

    // Dòng đăng ký kho riêng trong sổ (seed của ứng dụng đã ghi
    // hai dòng kho chung của Trang chính và trường mặc định).
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      const cpDb = drizzle({ client });
      const inserted = await cpDb
        .insert(spaceRegistry)
        .values([
          {
            slug: CENTRE_A_SLUG,
            name: 'Trung tâm A 587',
            kind: 'center',
            status: 'active',
            databaseName: CENTRE_A_DATABASE,
            storageMode: 'dedicated',
            connectionRoleRef: CENTRE_A_ROLE,
            secretRef: 'env:SPACE_TEST_A_587_URL',
            schemaVersion: 'v1',
          },
        ])
        .returning({ id: spaceRegistry.id });
      registryAId = inserted[0]!.id;
    });

    // Import helpers ĐỘNG sau khi biến môi trường Better Auth đã
    // được gán ở đầu file (xem chú thích ở đầu file).
    helpers = await import('../../support/identity-access-helpers');
    // App mount handler Better Auth kèm định tuyến kho (ca (e)
    // đăng nhập qua handler này, không qua createTestApp).
    app = await createMountedTestApp();
    adminToken = (await helpers.login(app, 'admin', 'Admin123!')).accessToken;

    // Tenant của trung tâm tạo bằng API công khai ở kho chung
    // (đường hiện tại), rồi dòng tenant được sao vào kho riêng —
    // trạng thái sau di trú.
    const createdA = (await must(
      await helpers.http(app).post('/api/v1/tenants').set(auth(adminToken)).send({
        name: 'Trung tâm A (spec 587)',
        slug: CENTRE_A_SLUG,
        kind: 'school',
      }),
      'create tenant A',
    )) as { id: string };
    tenantAId = createdA.id;
    await copyRow(
      process.env.DATABASE_URL!,
      clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD),
      'tenants',
      'id',
      tenantAId,
    );

    // Giáo viên chính là thành viên của trung tâm A: tạo ở kho
    // chung, thêm membership bằng API, rồi sao dòng user + dòng
    // membership vào kho A và đóng dấu phân biệt lên dòng user ở
    // kho A.
    const teacher = await helpers.createUserViaApi(app, adminToken);
    teacherUsername = teacher.username;
    teacherId = teacher.id;
    await must(
      await helpers.http(app).post(`/api/v1/tenants/${tenantAId}/members`).set(auth(adminToken)).send({ userId: teacher.id }),
      'add teacher to tenant A',
    );
    await copyMemberToCentre(teacher.id, tenantAId, CENTRE_A_FIRST_NAME);

    // Phiên Better Auth của giáo viên gieo thẳng vào kho đích (bảng
    // `session` của kho A): ca cookie kiểm chứng đường đọc của
    // guard, không phụ thuộc đường ghi đăng nhập.
    betterAuthSessionToken = `ba587-${RUN_SUFFIX}-${randomUUID()}`;
    await withClient(clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD), async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query(
        `INSERT INTO "session" (token, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
        [betterAuthSessionToken, teacherId],
      );
    });

    // Token của giáo viên cho tenant A qua đường chuyển tenant như
    // người dùng thật — token này mang claim centre_id.
    const teacherApex = await helpers.login(app, teacherUsername, helpers.STRONG_PASSWORD);
    const switched = (await must(
      await helpers.http(app).post(`/api/v1/auth/switch-tenant/${tenantAId}`).set(auth(teacherApex.accessToken)),
      'switch teacher to tenant A',
    )) as { accessToken: string };
    teacherTokenA = switched.accessToken;

    // Tài khoản chỉ còn ở kho riêng: tạo ở kho chung, sao vào kho
    // A, rồi XOÁ khỏi kho chung (membership trước, user sau) —
    // trạng thái sau di trú mà phía kho chung không còn dấu vết.
    const dedicatedOnly = await helpers.createUserViaApi(app, adminToken);
    dedicatedOnlyId = dedicatedOnly.id;
    dedicatedOnlyUsername = dedicatedOnly.username;
    await must(
      await helpers.http(app).post(`/api/v1/tenants/${tenantAId}/members`).set(auth(adminToken)).send({ userId: dedicatedOnlyId }),
      'add dedicated-only user to tenant A',
    );
    await copyMemberToCentre(dedicatedOnlyId, tenantAId, null);
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [
        tenantAId,
        dedicatedOnlyId,
      ]);
      await client.query('DELETE FROM users WHERE id = $1', [dedicatedOnlyId]);
    });

    // Tài khoản chỉ ở kho riêng dùng cho ca đăng nhập Better Auth
    // (e): tạo CẶP user + account credential qua cầu nối (kho
    // chung, vì cầu nối chạy ngoài ngữ cảnh trung tâm), thêm
    // membership, sao user + membership + dòng account credential
    // vào kho A kèm dấu phân biệt, rồi xoá sạch khỏi kho chung
    // (account trước, membership sau, user cuối) — trạng thái sau
    // di trú mà phía kho chung không còn dấu vết nào để đường ghi
    // có thể "ăn gian" bằng kho chung.
    const { CredentialBridgeService: BridgeClass } = await import(
      '../../../src/modules/auth/better-auth/credential-bridge.service'
    );
    const bridge = app.get(BridgeClass);
    const baUsername = helpers.uniqueName('bauser587');
    const baCreated = await bridge.createUserWithCredential({
      email: `${baUsername}@example.com`,
      username: baUsername,
      firstName: 'Test',
      lastName: 'User',
      password: helpers.STRONG_PASSWORD,
    });
    dedicatedOnlyBaId = baCreated.id;
    dedicatedOnlyBaUsername = baUsername;
    await must(
      await helpers.http(app).post(`/api/v1/tenants/${tenantAId}/members`).set(auth(adminToken)).send({ userId: dedicatedOnlyBaId }),
      'add dedicated-only BA user to tenant A',
    );
    await copyMemberToCentre(dedicatedOnlyBaId, tenantAId, 'DauAnKhoBA587');
    await copyRow(
      process.env.DATABASE_URL!,
      clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD),
      'account',
      'user_id',
      dedicatedOnlyBaId,
    );
    await withClient(process.env.DATABASE_URL!, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query('DELETE FROM account WHERE user_id = $1', [dedicatedOnlyBaId]);
      await client.query('DELETE FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [
        tenantAId,
        dedicatedOnlyBaId,
      ]);
      await client.query('DELETE FROM users WHERE id = $1', [dedicatedOnlyBaId]);
    });

    // Tài khoản CHỈ ở kho chung dùng cho ca (f) và (g): tạo cặp
    // user + account credential qua cầu nối ở kho chung và KHÔNG
    // sao đi đâu cả — tài khoản đăng nhập được ở địa chỉ platform
    // nhưng không tồn tại ở kho riêng.
    const sharedBaUsername = helpers.uniqueName('sharedba587');
    const sharedBaCreated = await bridge.createUserWithCredential({
      email: `${sharedBaUsername}@example.com`,
      username: sharedBaUsername,
      firstName: 'Test',
      lastName: 'User',
      password: helpers.STRONG_PASSWORD,
    });
    sharedOnlyBaId = sharedBaCreated.id;
    sharedOnlyBaUsername = sharedBaUsername;

    // Tài khoản sẽ bị thu hồi: tạo, sao vào kho A, lấy token
    // chuyển tenant khi membership còn hiệu lực — ca thu hồi sẽ
    // kết thúc membership ở kho đích rồi dùng lại chính token này.
    const revoked = await helpers.createUserViaApi(app, adminToken);
    await must(
      await helpers.http(app).post(`/api/v1/tenants/${tenantAId}/members`).set(auth(adminToken)).send({ userId: revoked.id }),
      'add revoked user to tenant A',
    );
    await copyMemberToCentre(revoked.id, tenantAId, null);
    const revokedApex = await helpers.login(app, revoked.username, helpers.STRONG_PASSWORD);
    const revokedSwitched = (await must(
      await helpers.http(app).post(`/api/v1/auth/switch-tenant/${tenantAId}`).set(auth(revokedApex.accessToken)),
      'switch revoked user to tenant A',
    )) as { accessToken: string };
    revokedTokenA = revokedSwitched.accessToken;
  }, 300_000);

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    delete process.env.SPACE_TEST_A_587_URL;
    delete process.env.CONTROL_PLANE_DATABASE_URL;
    await withClient(clusterUrl('postgres'), async (admin) => {
      for (const database of [CP_DATABASE, CENTRE_A_DATABASE]) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`);
      }
      for (const role of [CP_ROLE, CENTRE_A_ROLE]) {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    }).catch(() => undefined);
  });

  it('token mang claim của trung tâm kho riêng đọc được hồ sơ từ kho đích', async () => {
    expect(decodeJwtPayload(teacherTokenA)['centre_id']).toBe(registryAId);
    expect(decodeJwtPayload(teacherTokenA)['tid']).toBe(tenantAId);

    const res = await helpers.http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(teacherTokenA));

    expect(res.status).toBe(200);
    expect((res.body as { firstName?: string }).firstName).toBe(CENTRE_A_FIRST_NAME);
  });

  it('token JWT cũ không claim của tài khoản chỉ còn ở kho riêng bị từ chối 401 auth.centre_mismatch', async () => {
    // Tài khoản thật sự chỉ còn ở kho riêng: kho chung không còn
    // dòng user lẫn dòng membership, kho đích còn đủ cả hai.
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'id', dedicatedOnlyId)).toBe(0);
    expect(await countRows(process.env.DATABASE_URL!, 'tenant_memberships', 'user_id', dedicatedOnlyId)).toBe(0);
    const centreUrl = clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    expect(await countRows(centreUrl, 'users', 'id', dedicatedOnlyId)).toBe(1);
    expect(await countRows(centreUrl, 'tenant_memberships', 'user_id', dedicatedOnlyId)).toBe(1);

    // Token cũ: mang tid nhưng KHÔNG mang centre_id, đúng hình
    // dạng phiên cấp trước khi trung tâm tách kho.
    const jwtService = app.get(JwtService);
    const oldToken = await jwtService.signAsync({
      sub: dedicatedOnlyId,
      username: dedicatedOnlyUsername,
      sid: randomUUID(),
      tid: tenantAId,
    });

    const res = await helpers.http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(oldToken));

    expect(res.status).toBe(401);
    expect((res.body as { code?: string }).code).toBe('auth.centre_mismatch');
  });

  it('thành viên đã bị thu hồi ở kho đích bị từ chối 401 tenant.membership_inactive', async () => {
    // Thu hồi xảy ra SAU khi token được cấp: kết thúc membership
    // của tài khoản trong kho đích, token cũ vẫn còn hạn.
    const revokedUserId = decodeJwtPayload(revokedTokenA)['sub'] as string;
    const centreUrl = clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    await withClient(centreUrl, async (client) => {
      await client.query("SELECT set_config('app.platform', 'on', false)");
      await client.query("UPDATE tenant_memberships SET status = 'ended' WHERE tenant_id = $1 AND user_id = $2", [
        tenantAId,
        revokedUserId,
      ]);
    });

    const res = await helpers.http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(revokedTokenA));

    expect(res.status).toBe(401);
    expect((res.body as { code?: string }).code).toBe('tenant.membership_inactive');
  });

  it('đăng nhập Better Auth tại địa chỉ kho riêng của tài khoản chỉ ở kho riêng ghi phiên vào kho đích', async () => {
    // Tài khoản thật sự chỉ còn ở kho riêng: kho chung không còn
    // dòng user lẫn dòng account credential, kho đích còn đủ cả hai.
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'id', dedicatedOnlyBaId)).toBe(0);
    expect(await countRows(process.env.DATABASE_URL!, 'account', 'user_id', dedicatedOnlyBaId)).toBe(0);
    const centreUrl = clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    expect(await countRows(centreUrl, 'users', 'id', dedicatedOnlyBaId)).toBe(1);
    expect(await countRows(centreUrl, 'account', 'user_id', dedicatedOnlyBaId)).toBe(1);

    // Đăng nhập bằng đúng luồng web Better Auth tại địa chỉ của
    // chính trung tâm: kiểm chứng credential và ghi phiên đều phải
    // đi kho đích — kho chung không còn tài khoản này nên mọi lần
    // đọc/ghi rơi về kho chung đều thất bại ngay tại đây.
    const signIn = await helpers
      .http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Host', HOST_A)
      .set('Origin', 'http://localhost:5173')
      .send({ username: dedicatedOnlyBaUsername, password: helpers.STRONG_PASSWORD });
    expect(signIn.status).toBe(200);

    // Phiên được GHI vào kho đích, không phải kho chung.
    expect(await countRows(centreUrl, 'session', 'user_id', dedicatedOnlyBaId)).toBe(1);
    expect(await countRows(process.env.DATABASE_URL!, 'session', 'user_id', dedicatedOnlyBaId)).toBe(0);

    // Cookie phiên vừa ghi đọc được hồ sơ mang dấu kho đích qua
    // địa chỉ của chính trung tâm.
    const me = await helpers
      .http(app)
      .get('/api/v1/users/me')
      .set('Host', HOST_A)
      .set('Cookie', sessionCookieFrom(signIn.headers['set-cookie'] as unknown as string[]));
    expect(me.status).toBe(200);
    expect((me.body as { firstName?: string }).firstName).toBe('DauAnKhoBA587');
  });

  it('phiên cookie Better Auth ở kho riêng đọc được hồ sơ qua địa chỉ của chính trung tâm', async () => {
    // Cookie phải ký đúng định dạng của Better Auth (xem hàm
    // signedBetterAuthCookie ở đầu file): cookie không ký bị
    // getSession bỏ qua trước khi tra bảng phiên.
    const me = await helpers
      .http(app)
      .get('/api/v1/users/me')
      .set('Host', HOST_A)
      .set('Cookie', signedBetterAuthCookie(betterAuthSessionToken));

    expect(me.status).toBe(200);
    expect((me.body as { firstName?: string }).firstName).toBe(CENTRE_A_FIRST_NAME);
  });

  it('tài khoản chỉ ở kho chung bị từ chối khi đăng nhập Better Auth tại địa chỉ của trung tâm kho riêng', async () => {
    // Tài khoản có credential hẳn hoi ở kho chung và không tồn
    // tại ở kho riêng: kiểm chứng credential tại địa chỉ của
    // trung tâm chỉ được chạm kho đích, không được rơi về kho
    // chung theo bất kỳ đường nào.
    expect(await countRows(process.env.DATABASE_URL!, 'users', 'id', sharedOnlyBaId)).toBe(1);
    expect(await countRows(process.env.DATABASE_URL!, 'account', 'user_id', sharedOnlyBaId)).toBe(1);
    const centreUrl = clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);
    expect(await countRows(centreUrl, 'users', 'id', sharedOnlyBaId)).toBe(0);
    expect(await countRows(centreUrl, 'account', 'user_id', sharedOnlyBaId)).toBe(0);

    const signIn = await helpers
      .http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Host', HOST_A)
      .set('Origin', 'http://localhost:5173')
      .send({ username: sharedOnlyBaUsername, password: helpers.STRONG_PASSWORD });
    expect(signIn.status).toBe(401);
    expect((signIn.body as { code?: string }).code).toBe('INVALID_USERNAME_OR_PASSWORD');

    // Lượt từ chối không ghi phiên ở bất kỳ kho nào.
    expect(await countRows(centreUrl, 'session', 'user_id', sharedOnlyBaId)).toBe(0);
    expect(await countRows(process.env.DATABASE_URL!, 'session', 'user_id', sharedOnlyBaId)).toBe(0);
  });

  it('đăng nhập Better Auth tại địa chỉ platform giữ nguyên hành vi: tài khoản kho chung vào được, tài khoản chỉ ở kho riêng bị từ chối', async () => {
    // Không đặt Host của trung tâm: request mang địa chỉ mặc định
    // (không trích được slug) — đúng đường platform hiện tại.
    const centreUrl = clusterUrl(CENTRE_A_DATABASE, CENTRE_A_ROLE, CENTRE_A_PASSWORD);

    // Tài khoản kho chung đăng nhập được và phiên ghi ở kho chung.
    const sharedSignIn = await helpers
      .http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', 'http://localhost:5173')
      .send({ username: sharedOnlyBaUsername, password: helpers.STRONG_PASSWORD });
    expect(sharedSignIn.status).toBe(200);
    expect(await countRows(process.env.DATABASE_URL!, 'session', 'user_id', sharedOnlyBaId)).toBe(1);
    expect(await countRows(centreUrl, 'session', 'user_id', sharedOnlyBaId)).toBe(0);

    // Tài khoản chỉ ở kho riêng không tồn tại ở kho chung nên bị
    // từ chối tại địa chỉ platform như mọi tài khoản không tồn tại.
    const dedicatedSignIn = await helpers
      .http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', 'http://localhost:5173')
      .send({ username: dedicatedOnlyBaUsername, password: helpers.STRONG_PASSWORD });
    expect(dedicatedSignIn.status).toBe(401);
    expect((dedicatedSignIn.body as { code?: string }).code).toBe('INVALID_USERNAME_OR_PASSWORD');
  });
});
