import { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emitSpaceRegistryChanged } from '../../../src/db/routing/space-routing-events';
import { FleetRegistryWriter } from '../../../src/modules/fleet/fleet-registry-writer';
import { ControlPlaneConnection } from '../../../src/modules/control-plane/control-plane.connection';
import { manageCentreInvite, runSpaceProvision } from '../../../src/modules/tenants/space-provision-runner';
import { STRONG_PASSWORD, createTestApp, http } from '../../support/identity-access-helpers';

/**
 * Ca đầu-cuối của CẤP PHÁT TRUNG TÂM + NHẬN DIỆN (issue #583):
 * hai trung tâm được cấp phát THẬT bằng pipeline cấp phát (sổ đăng
 * ký riêng, database + role riêng, baseline hiện hành, gói chương
 * trình, quản trị đầu tiên + lời mời), rồi ứng dụng thật chạy trên
 * chính hai kho đó qua tên miền con mang slug. Database test dùng
 * chung (`lms_test_api`) phải đã migrate từ trống trước khi chạy
 * spec này — đúng tiền điều kiện của mọi spec e2e khác (bước
 * Migrate trong CI).
 *
 * Các ca khoá các tiêu chí nghiệm thu của issue ở phía HTTP:
 * (1) một lệnh cấp phát cho ra trung tâm dùng được: quản trị đầu
 *     tiên kích hoạt bằng lời mời rồi đăng nhập tại địa chỉ trung
 *     tâm, nhận diện công khai đọc được ở cả địa chỉ trung tâm lẫn
 *     địa chỉ gốc;
 * (2) token lời mời của trung tâm này không kích hoạt được ở trung
 *     tâm khác (kho của trung tâm kia không có lời mời đó);
 * (3) mật khẩu yếu làm cháy lời mời (đốt trước, đặt mật khẩu sau),
 *     phát hành lại bằng CLI rồi kích hoạt thành công;
 * (4) quản trị trung tâm sửa được nhận diện của mình, người dùng
 *     thường của cùng trung tâm bị từ chối, nhận diện của trung tâm
 *     khác không đổi;
 * (5) đình chỉ chặn traffic nghiệp vụ nhưng nhận diện công khai
 *     vẫn đọc được, dữ kiện còn nguyên, mở lại thì traffic trở lại;
 * (6) sau khi đã định tuyến, tắt control plane đi thì bề mặt trung
 *     tâm vẫn hiển thị đúng nhận diện đã nạp (nhận diện đọc từ kho
 *     của trung tâm, không đọc từ control plane).
 *
 * MẪU MIRROR CHO PHIÊN TRUNG TÂM (theo pattern của e2e #582):
 * luồng cấp token hiện tại tra tenant trong kho chung dưới ngữ
 * cảnh platform, nên một quản trị chỉ tồn tại trong kho riêng
 * chưa nhận được claim `centre_id` — đó là cổng #587 (thứ tự
 * phân giải danh tính), không thuộc phạm vi issue #583. Để các
 * ca đình chỉ/chặn được kiểm chứng ở tầng guard (chứ không kẹt
 * ở lỗi gắn phiên), spec này mirror dòng tenant + membership của
 * các tài khoản trung tâm vào kho chung. Mirror chỉ phục vụ việc
 * gắn phiên trong ca test; mọi quyết định phân quyền dưới test
 * (ai sửa được nhận diện, đình chỉ chặn gì) vẫn đọc từ kho riêng
 * của trung tâm. Tương tự, endpoint tạo user qua API chạy dưới
 * ngữ cảnh platform trên kho chung nên không tạo được user của
 * trung tâm kho riêng — hành vi thế giới kho chung từ trước,
 * thuộc phạm vi issue #584; ca (4) vì vậy tạo người dùng thường
 * trực tiếp trong kho trung tâm thay vì qua endpoint đó.
 */
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CP_DATABASE = `lms_test_cp_583e_${RUN_SUFFIX}`;
const SLUG_A = `trung-tam-e2e-a-${RUN_SUFFIX}`;
const SLUG_B = `trung-tam-e2e-b-${RUN_SUFFIX}`;
const HOST_A = `${SLUG_A}.test.local`;
const HOST_B = `${SLUG_B}.test.local`;
const NAME_A = 'Trung tâm E2E A 583';
const NAME_B = 'Trung tâm E2E B 583';
const ADMIN_A_EMAIL = `admin-a-583-${RUN_SUFFIX}@example.com`;
const ADMIN_B_EMAIL = `admin-b-583-${RUN_SUFFIX}@example.com`;
const ADMIN_A_USERNAME = `admine2ea${RUN_SUFFIX}`;
const ADMIN_B_USERNAME = `admine2eb${RUN_SUFFIX}`;
const DB_PASSWORD = 'Test583E2eDb!';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database test. */
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

/** Giải mã phần payload của JWT mà không kiểm chữ ký — chỉ dùng để khẳng định claim trong ca test. */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split('.')[1]!;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
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
async function applySqlFile(connectionString: string, filePath: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
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
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'));
  }
}

/** Env chạy lệnh cấp phát: sổ control plane riêng + cụm test + mật khẩu role do ca test cấp. */
function provisionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE),
    DATABASE_URL: process.env.DATABASE_URL!,
    SPACE_PROVISION_DB_PASSWORD: DB_PASSWORD,
    ...extra,
  };
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre');

describe('Cấp phát trung tâm + nhận diện (đầu-cuối)', () => {
  let app: INestApplication;
  let writer: FleetRegistryWriter;
  let centreA: Awaited<ReturnType<typeof runSpaceProvision>>;
  let centreB: Awaited<ReturnType<typeof runSpaceProvision>>;
  let adminAToken = '';
  let adminBToken = '';
  let teacherId = '';
  // Writer đã đóng trong ca tắt control plane (xem ca cuối) thì
  // afterAll không đóng lại nữa: pg-pool ném lỗi khi end() lần 2.
  let writerClosed = false;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`CREATE DATABASE ${quoted(CP_DATABASE)}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE));
    const env = provisionEnv();
    centreA = await runSpaceProvision({
      slug: SLUG_A, name: NAME_A, adminEmail: ADMIN_A_EMAIL, adminUsername: ADMIN_A_USERNAME,
      databasePassword: DB_PASSWORD, actorId: ACTOR_ID, migrationsDir: MIGRATIONS_DIR, env, log: () => undefined,
    });
    centreB = await runSpaceProvision({
      slug: SLUG_B, name: NAME_B, adminEmail: ADMIN_B_EMAIL, adminUsername: ADMIN_B_USERNAME,
      databasePassword: DB_PASSWORD, actorId: ACTOR_ID, migrationsDir: MIGRATIONS_DIR, env, log: () => undefined,
    });
    writer = new FleetRegistryWriter(env);

    // Mirror tenant + membership của quản trị A vào kho chung để
    // luồng cấp token (tra tenant dưới ngữ cảnh platform) gắn được
    // claim `centre_id` cho phiên trung tâm — xem chú thích đầu file.
    await withClient(process.env.DATABASE_URL!, async (shared) => {
      await shared.query(`SELECT set_config('app.platform', 'on', false)`);
      await shared.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [centreA.adminUserId, ADMIN_A_USERNAME, ADMIN_A_EMAIL]);
      await shared.query('INSERT INTO tenants (id, slug, name, kind, status) VALUES ($1, $2, $3, $4, $5)', [centreA.tenantId, SLUG_A, NAME_A, 'center', 'active']);
      await shared.query('INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES ($1, $2, $3)', [centreA.tenantId, centreA.adminUserId, 'active']);
    });

    // Ứng dụng phải thấy control plane và hai bí mật kho riêng ngay
    // từ lúc khởi động.
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE);
    process.env[centreA.secretEnvVar] = clusterUrl(centreA.databaseName, centreA.connectionRole, DB_PASSWORD);
    process.env[centreB.secretEnvVar] = clusterUrl(centreB.databaseName, centreB.connectionRole, DB_PASSWORD);
    app = await createTestApp();
  }, 180000);

  afterAll(async () => {
    if (app) await app.close();
    if (writer && !writerClosed) await writer.close();
    // Dọn các dòng mirror khỏi kho chung (xem chú thích đầu file).
    await withClient(process.env.DATABASE_URL!, async (shared) => {
      await shared.query(`SELECT set_config('app.platform', 'on', false)`);
      if (centreA) {
        await shared.query('DELETE FROM tenant_memberships WHERE tenant_id = $1', [centreA.tenantId]);
        await shared.query('DELETE FROM tenants WHERE id = $1', [centreA.tenantId]);
        await shared.query('DELETE FROM users WHERE id = $1', [centreA.adminUserId]);
      }
      if (teacherId) {
        await shared.query('DELETE FROM tenant_memberships WHERE user_id = $1', [teacherId]);
        await shared.query('DELETE FROM users WHERE id = $1', [teacherId]);
      }
    });
    await withClient(clusterUrl('postgres'), async (admin) => {
      if (centreA) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(centreA.databaseName)} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${quoted(centreA.connectionRole)}`);
      }
      if (centreB) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(centreB.databaseName)} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${quoted(centreB.connectionRole)}`);
      }
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(CP_DATABASE)} WITH (FORCE)`);
    });
  });

  it('token lời mời của trung tâm này không kích hoạt được ở trung tâm khác', async () => {
    const res = await http(app)
      .post('/api/v1/centres/activate-invite')
      .send({ slug: SLUG_A, token: centreB.inviteToken, password: STRONG_PASSWORD });
    expect(res.status).toBe(404);
    expect((res.body as { code?: string }).code).toBe('centre.invite_not_found');
  });

  it('mật khẩu yếu làm cháy lời mời, phát hành lại bằng CLI rồi kích hoạt thành công', async () => {
    const weak = await http(app)
      .post('/api/v1/centres/activate-invite')
      .send({ slug: SLUG_B, token: centreB.inviteToken, password: '123' });
    expect(weak.status).toBe(400);
    expect((weak.body as { code?: string }).code).toBe('user.password_policy');
    // Lời mời đã cháy dù mật khẩu chưa đặt: thử lại bằng token cũ bị từ chối.
    const retry = await http(app)
      .post('/api/v1/centres/activate-invite')
      .send({ slug: SLUG_B, token: centreB.inviteToken, password: STRONG_PASSWORD });
    expect(retry.status).toBe(409);
    expect((retry.body as { code?: string }).code).toBe('centre.invite_consumed');
    // Phát hành lại: lời mời cũ đang chờ (không còn — đã cháy) và
    // token mới kích hoạt được.
    const reissued = await manageCentreInvite({
      slug: SLUG_B,
      email: ADMIN_B_EMAIL,
      env: provisionEnv({ [centreB.secretEnvVar]: clusterUrl(centreB.databaseName, centreB.connectionRole, DB_PASSWORD) }),
      log: () => undefined,
    });
    expect(reissued.inviteToken).toBeTruthy();
    expect(reissued.inviteToken).not.toBe(centreB.inviteToken);
    const activated = await http(app)
      .post('/api/v1/centres/activate-invite')
      .send({ slug: SLUG_B, token: reissued.inviteToken, password: STRONG_PASSWORD });
    // POST theo mặc định của Nest trả 201 (endpoint không gắn @HttpCode).
    expect(activated.status).toBe(201);
    expect(activated.body).toMatchObject({ activated: true, userId: centreB.adminUserId });
  });

  it('quản trị đầu tiên kích hoạt rồi đăng nhập tại địa chỉ trung tâm và đọc nhận diện công khai', async () => {
    const activated = await http(app)
      .post('/api/v1/centres/activate-invite')
      .send({ slug: SLUG_A, token: centreA.inviteToken, password: STRONG_PASSWORD });
    expect(activated.status).toBe(201);
    expect(activated.body).toMatchObject({ activated: true, userId: centreA.adminUserId });
    const loginRes = await http(app)
      .post('/api/v1/auth/token')
      .set('Host', HOST_A)
      .send({ username: ADMIN_A_USERNAME, password: STRONG_PASSWORD });
    expect(loginRes.status).toBe(201);
    adminAToken = loginRes.body.accessToken;
    const loginB = await http(app)
      .post('/api/v1/auth/token')
      .set('Host', HOST_B)
      .send({ username: ADMIN_B_USERNAME, password: STRONG_PASSWORD });
    expect(loginB.status).toBe(201);
    adminBToken = loginB.body.accessToken;

    // Token của phiên trung tâm mang claim `centre_id` bằng định danh đăng ký của trung tâm.
    const spaceA = await writer.findSpaceBySlug(SLUG_A);
    expect(decodeJwtPayload(loginRes.body.accessToken).centre_id).toBe(spaceA!.id);

    const atCentre = await http(app).get(`/api/v1/centres/${SLUG_A}/identity`).set('Host', HOST_A);
    expect(atCentre.status).toBe(200);
    expect(atCentre.body).toMatchObject({ displayName: NAME_A, tenantId: centreA.tenantId });
    const atPlatform = await http(app).get(`/api/v1/centres/${SLUG_A}/identity`);
    expect(atPlatform.status).toBe(200);
    expect(atPlatform.body).toMatchObject({ displayName: NAME_A });
    // Địa chỉ trung tâm này không đọc được nhận diện của trung tâm khác.
    const mismatch = await http(app).get(`/api/v1/centres/${SLUG_B}/identity`).set('Host', HOST_A);
    expect(mismatch.status).toBe(400);
    expect((mismatch.body as { code?: string }).code).toBe('centre.address_mismatch');
  });

  it('quản trị trung tâm sửa được nhận diện của mình, người dùng thường bị từ chối, trung tâm khác không đổi', async () => {
    // Tạo người dùng thường TRỰC TIẾP trong kho của trung tâm A
    // (kèm mirror vào kho chung để gắn phiên — xem chú thích đầu
    // file). Băm mật khẩu bằng đúng thuật toán của PasswordService
    // (argon2id) để đường đăng nhập thật kiểm chứng được.
    teacherId = randomUUID();
    const teacherUsername = `gv583${RUN_SUFFIX}`;
    const teacherEmail = `gv-583-${RUN_SUFFIX}@example.com`;
    const teacherHash = await argon2.hash(STRONG_PASSWORD, { type: argon2.argon2id });
    await withClient(clusterUrl(centreA.databaseName, centreA.connectionRole, DB_PASSWORD), async (centre) => {
      await centre.query(`SELECT set_config('app.platform', 'on', false)`);
      await centre.query('INSERT INTO users (id, username, email, password_hash, first_name, last_name) VALUES ($1, $2, $3, $4, $5, $6)', [teacherId, teacherUsername, teacherEmail, teacherHash, 'Giao', 'Vien']);
      await centre.query('INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES ($1, $2, $3)', [centreA.tenantId, teacherId, 'active']);
    });
    await withClient(process.env.DATABASE_URL!, async (shared) => {
      await shared.query(`SELECT set_config('app.platform', 'on', false)`);
      await shared.query('INSERT INTO users (id, username, email) VALUES ($1, $2, $3)', [teacherId, teacherUsername, teacherEmail]);
      await shared.query('INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES ($1, $2, $3)', [centreA.tenantId, teacherId, 'active']);
    });
    const teacherLogin = await http(app)
      .post('/api/v1/auth/token')
      .set('Host', HOST_A)
      .send({ username: teacherUsername, password: STRONG_PASSWORD });
    expect(teacherLogin.status).toBe(201);

    const forbidden = await http(app)
      .patch(`/api/v1/centres/${SLUG_A}/identity`)
      .set('Host', HOST_A)
      .set(auth(teacherLogin.body.accessToken))
      .send({ displayName: 'Tên lén đổi' });
    expect(forbidden.status).toBe(403);
    expect((forbidden.body as { code?: string }).code).toBe('centre.not_admin');

    const updated = await http(app)
      .patch(`/api/v1/centres/${SLUG_A}/identity`)
      .set('Host', HOST_A)
      .set(auth(adminAToken))
      .send({ displayName: 'Trung tâm E2E A 583 — đã đổi tên', brandColor: '#1d4ed8' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ displayName: 'Trung tâm E2E A 583 — đã đổi tên', brandColor: '#1d4ed8' });
    const after = await http(app).get(`/api/v1/centres/${SLUG_A}/identity`).set('Host', HOST_A);
    expect(after.body).toMatchObject({ displayName: 'Trung tâm E2E A 583 — đã đổi tên' });
    const other = await http(app).get(`/api/v1/centres/${SLUG_B}/identity`).set('Host', HOST_B);
    expect(other.body).toMatchObject({ displayName: NAME_B });
  });

  it('đình chỉ chặn traffic nghiệp vụ nhưng nhận diện công khai vẫn đọc được, mở lại thì traffic trở lại', async () => {
    const spaceA = await writer.findSpaceBySlug(SLUG_A);
    await writer.changeSpaceStatus(spaceA!.id, 'suspended', ACTOR_ID);
    emitSpaceRegistryChanged(SLUG_A);
    try {
      const blocked = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(adminAToken));
      expect(blocked.status).toBe(403);
      expect((blocked.body as { code?: string }).code).toBe('space.not_active');
      const identityStill = await http(app).get(`/api/v1/centres/${SLUG_A}/identity`).set('Host', HOST_A);
      expect(identityStill.status).toBe(200);
      expect(identityStill.body).toMatchObject({ displayName: 'Trung tâm E2E A 583 — đã đổi tên' });
      // Dữ kiện trong kho của trung tâm còn nguyên vẹn.
      const rows = await withClient(clusterUrl(centreA.databaseName, centreA.connectionRole, DB_PASSWORD), async (client) => {
        await client.query(`SELECT set_config('app.platform', 'on', false)`);
        const result = await client.query<{ count: string }>('SELECT count(*) FROM tenants WHERE id = $1', [centreA.tenantId]);
        return Number(result.rows[0]!.count);
      });
      expect(rows).toBe(1);
    } finally {
      await writer.changeSpaceStatus(spaceA!.id, 'active', ACTOR_ID);
      emitSpaceRegistryChanged(SLUG_A);
    }
    const restored = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(adminAToken));
    expect(restored.status).toBe(200);
  });

  it('tắt control plane sau khi đã định tuyến thì bề mặt trung tâm vẫn hiển thị đúng nhận diện đã nạp', async () => {
    // Ca cuối cùng của file: xoá hẳn database control plane của ca
    // test (database dùng một lần của riêng spec này). Từ đây mọi
    // đường cần sổ đăng ký đều hỏng — chứng minh bằng một request
    // nghiệp vụ bị từ chối 401 fail-closed: sổ đăng ký không đọc
    // được nên khung định tuyến ném not_configured, chiến lược JWT
    // tra tài khoản ở kho chung không thấy tài khoản chỉ sống ở kho
    // riêng nên từ chối, không phục vụ dữ kiện nào — nhưng đọc
    // nhận diện đi đường handle đã-chuẩn-bị nên vẫn trả đúng tên
    // đã đổi ở ca trước.
    // Đóng sạch hai pool control plane TRƯỚC khi DROP: DROP WITH
    // (FORCE) trong khi pool còn backend mở sẽ giết các backend đó
    // (lỗi 57P01), pg báo thành uncaught exception và vitest trả
    // exit 1 dù mọi ca đều xanh — đã kiểm chứng ở lần chạy trước.
    await writer.close();
    writerClosed = true;
    const cpConnection = app.get(ControlPlaneConnection);
    await cpConnection.onModuleDestroy();
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE ${quoted(CP_DATABASE)} WITH (FORCE)`);
    });
    // Chờ quá TTL cache của khung định tuyến (5 giây) để request
    // nghiệp vụ kế tiếp bắt buộc phải đọc sổ đã chết, thay vì ăn
    // dòng đăng ký còn cache.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const business = await http(app).get('/api/v1/users/me').set('Host', HOST_A).set(auth(adminAToken));
    expect(business.status).toBe(401);
    const identity = await http(app).get(`/api/v1/centres/${SLUG_A}/identity`).set('Host', HOST_A);
    expect(identity.status).toBe(200);
    expect(identity.body).toMatchObject({ displayName: 'Trung tâm E2E A 583 — đã đổi tên', brandColor: '#1d4ed8' });
  });
});
