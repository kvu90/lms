import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BetterAuthService } from '../../src/modules/auth/better-auth/better-auth.service';
import type { CredentialBridgeService } from '../../src/modules/auth/better-auth/credential-bridge.service';

/**
 * Flow test của nền Better Auth (issue #7, Giai đoạn 1) — chạy với cờ
 * BETTER_AUTH_ENABLED bật. Đường auth cũ vẫn là đường chính của hệ; spec
 * này chứng minh các cổng đạt của giai đoạn trên code thật: đăng nhập
 * username qua Better Auth, phiên ghi IP/User-Agent, guard mỏng nhận
 * cookie trên route nghiệp vụ, suspended bị chặn dù phiên còn hạn, huỷ
 * phiên hiệu lực ngay, endpoint đổi trạng thái thiếu Origin bị 403 (kèm
 * cookie — kiểm tra Origin của 1.7.12 chỉ kích hoạt khi request mang
 * cookie, xem Giai đoạn 0), phiên tạo theo chương trình cho login-as,
 * cầu nối hash từ hệ cũ, và route auth cũ vẫn chạy khi cờ bật. Hai cổng
 * của điểm nối tiếp 2.1 (issue #7): gọi linkExistingPasswordHash đồng
 * thời hai lần chỉ sinh đúng một dòng credential, và lỗi ép tại bước
 * tạo account thì rollback cả dòng user (không để user mồ côi).
 * Vòng fix sau review của 2.1: internalAdapter dựng trong transaction
 * không mang database hook của plugin username nên cầu nối tự gác
 * luật username của plugin — spec có ca username sai định dạng/độ dài
 * bị từ chối không sinh user, và ca username chữ hoa hợp lệ được lưu
 * hạ thường, đăng nhập được, trùng thì bị chặn.
 *
 * Biến môi trường phải tồn tại TRƯỚC khi AppModule được nạp
 * (ConfigModule validate cấu hình ngay khi module được import), nên các
 * import của AppModule và của helpers (vốn import AppModule) đều là
 * import động bên trong beforeAll — không import tĩnh ở đầu file.
 */
process.env.BETTER_AUTH_ENABLED = 'true';
process.env.BETTER_AUTH_SECRET = 'e2e-better-auth-secret-0123456789abcdef';
const TRUSTED_ORIGIN = 'http://localhost:5173';
process.env.BETTER_AUTH_TRUSTED_ORIGINS = TRUSTED_ORIGIN;

const FLOW_PASSWORD = 'BridgePass123';

type Helpers = typeof import('../support/identity-access-helpers');
let helpers: Helpers;

function http(app: INestApplication) {
  return request(app.getHttpServer());
}

async function createMountedTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../src/app.module');
  const { enableTrustedProxy } = await import('../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../src/modules/auth/better-auth/better-auth.service'
  );
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  enableTrustedProxy(app as NestExpressApplication);
  // Mount handler của Better Auth trước init — đúng thứ tự như main.ts.
  const betterAuth: BetterAuthService = app.get(BetterAuthServiceClass);
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

/** Lấy cặp cookie phiên Better Auth từ header set-cookie của một response. */
function sessionCookieFrom(setCookie: string[] | undefined): string {
  const raw = (setCookie ?? []).find((value) => value.includes('better-auth.session_token='));
  if (!raw) throw new Error(`no Better Auth session cookie in: ${JSON.stringify(setCookie)}`);
  return raw.split(';')[0]!;
}

describe('Better Auth foundation (issue #7 phase 1)', () => {
  let app: INestApplication;
  let bridge: CredentialBridgeService;
  let pg: Client;
  let userId: string;
  let username: string;
  let sessionCookie: string;

  beforeAll(async () => {
    helpers = await import('../support/identity-access-helpers');
    app = await createMountedTestApp();
    const { CredentialBridgeService: BridgeClass } = await import(
      '../../src/modules/auth/better-auth/credential-bridge.service'
    );
    bridge = app.get(BridgeClass);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    username = helpers.uniqueName('bauser');
    const created = await bridge.createUserWithCredential({
      email: `${username}@example.com`,
      username,
      firstName: 'Bridge',
      lastName: 'User',
      password: FLOW_PASSWORD,
    });
    userId = created.id;
  });

  afterAll(async () => {
    await pg?.end();
    await app?.close();
  });

  it('rejects a weak password at the bridge (project policy runs inside the hash step)', async () => {
    const weakName = helpers.uniqueName('baweak');
    await expect(
      bridge.createUserWithCredential({
        email: `${weakName}@example.com`,
        username: weakName,
        firstName: 'Weak',
        lastName: 'User',
        password: 'weak',
      }),
    ).rejects.toThrow(/Password policy violated/);
    const rows = await pg.query('select count(*)::int as n from account a join users u on u.id = a.user_id where u.username = $1', [weakName]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('rejects a malformed username at the bridge (the plugin username rules run in the bridge)', async () => {
    // Điểm chặn vòng review của điểm 2.1: internalAdapter dựng trong
    // transaction KHÔNG mang database hook của plugin username, nên
    // cầu nối tự validate theo đúng luật plugin. Username chứa khoảng
    // trắng + ký tự `!` là định dạng mà endpoint đăng nhập username
    // không bao giờ chấp nhận — để lọt là sinh user không đăng nhập
    // được. Phải bị từ chối TRƯỚC khi bất kỳ bản ghi nào được ghi.
    await expect(
      bridge.createUserWithCredential({
        email: 'badname-format@example.com',
        username: 'bad name!',
        firstName: 'Bad',
        lastName: 'Format',
        password: FLOW_PASSWORD,
      }),
    ).rejects.toThrow(/username không hợp lệ/);
    const byEmail = await pg.query('select count(*)::int as n from users where email = $1', [
      'badname-format@example.com',
    ]);
    expect(byEmail.rows[0].n).toBe(0);
    // Cả hai biên độ dài của plugin (tối thiểu 3, tối đa 30) cũng gác.
    await expect(
      bridge.createUserWithCredential({
        email: 'badname-short@example.com',
        username: 'ab',
        firstName: 'Bad',
        lastName: 'Short',
        password: FLOW_PASSWORD,
      }),
    ).rejects.toThrow(/username quá ngắn/);
    await expect(
      bridge.createUserWithCredential({
        email: 'badname-long@example.com',
        username: 'a'.repeat(31),
        firstName: 'Bad',
        lastName: 'Long',
        password: FLOW_PASSWORD,
      }),
    ).rejects.toThrow(/username quá dài/);
    const leftovers = await pg.query(
      "select count(*)::int as n from users where email in ('badname-short@example.com', 'badname-long@example.com')",
    );
    expect(leftovers.rows[0].n).toBe(0);
  });

  it('accepts a valid mixed-case username, stores it lowercased, and blocks duplicates', async () => {
    const suffix = helpers.uniqueName('case');
    const mixed = `Ba${suffix}`;
    const created = await bridge.createUserWithCredential({
      email: `${suffix}@example.com`,
      username: mixed,
      firstName: 'Mixed',
      lastName: 'Case',
      password: FLOW_PASSWORD,
    });
    // Chuẩn hoá hạ thường của plugin vẫn áp ở tầng schema field.
    const rows = await pg.query('select username from users where id = $1', [created.id]);
    expect(rows.rows[0].username).toBe(mixed.toLowerCase());
    // User tạo qua cầu nối phải đăng nhập được bằng username đã
    // chuẩn hoá — tiêu chí mà điểm chặn của vòng review bảo vệ.
    const res = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: mixed.toLowerCase(), password: FLOW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(mixed.toLowerCase());
    // Trùng username bị chặn kể cả khi khác hoa/thường (hook của
    // plugin so trên dạng đã hạ thường; tầng DB còn UNIQUE gác cuối).
    await expect(
      bridge.createUserWithCredential({
        email: `dup-${suffix}@example.com`,
        username: mixed.toUpperCase(),
        firstName: 'Dup',
        lastName: 'Case',
        password: FLOW_PASSWORD,
      }),
    ).rejects.toThrow(/username đã được sử dụng/);
    const count = await pg.query('select count(*)::int as n from users where username = $1', [
      mixed.toLowerCase(),
    ]);
    expect(count.rows[0].n).toBe(1);
  });

  it('sign-in with a wrong password is refused', async () => {
    const res = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username, password: 'WrongPass123' });
    expect(res.status).toBe(401);
  });

  it('signs in by username and records IP + User-Agent on the session row', async () => {
    const res = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .set('User-Agent', 'ba-foundation-flow/1.0')
      .set('X-Forwarded-For', '203.0.113.9')
      .send({ username, password: FLOW_PASSWORD });
    expect(res.status).toBe(200);
    sessionCookie = sessionCookieFrom(res.headers['set-cookie'] as unknown as string[]);
    const rows = await pg.query(
      'select ip_address, user_agent from session where user_id = $1 order by created_at desc limit 1',
      [userId],
    );
    expect(rows.rows[0].user_agent).toBe('ba-foundation-flow/1.0');
    expect(rows.rows[0].ip_address).toBe('203.0.113.9');
  });

  it('get-session resolves the signed cookie', async () => {
    const res = await http(app).get('/api/v1/auth/get-session').set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(username);
    expect(res.body.session.userId).toBe(userId);
  });

  it('the thin guard authenticates a business route with only the Better Auth cookie', async () => {
    const res = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe(username);
  });

  it('blocks a suspended user even though the session is still live', async () => {
    await pg.query('update users set suspended = true where id = $1', [userId]);
    try {
      const res = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie);
      expect(res.status).toBe(401);
    } finally {
      await pg.query('update users set suspended = false where id = $1', [userId]);
    }
    const again = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie);
    expect(again.status).toBe(200);
  });

  it('a state-changing Better Auth endpoint without Origin (but with cookie) is 403', async () => {
    const res = await http(app).post('/api/v1/auth/sign-out').set('Cookie', sessionCookie).send({});
    expect(res.status).toBe(403);
    // Phiên chưa bị huỷ bởi request bị từ chối đó.
    const stillThere = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie);
    expect(stillThere.status).toBe(200);
  });

  it('sign-out revokes the session immediately', async () => {
    const res = await http(app)
      .post('/api/v1/auth/sign-out')
      .set('Cookie', sessionCookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send({});
    expect(res.status).toBe(200);
    const session = await http(app).get('/api/v1/auth/get-session').set('Cookie', sessionCookie);
    expect(session.status).toBe(200);
    expect(session.body ?? null).toBeNull();
    const business = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie);
    expect(business.status).toBe(401);
  });

  it('accepts a programmatic session (login-as foundation) only with the signed cookie value', async () => {
    const created = await bridge.createProgrammaticSession(userId);
    const signed = await http(app)
      .get('/api/v1/users/me')
      .set('Cookie', `better-auth.session_token=${created.signedCookieValue}`);
    expect(signed.status).toBe(200);
    expect(signed.body.username).toBe(username);
    const raw = await http(app)
      .get('/api/v1/users/me')
      .set('Cookie', `better-auth.session_token=${created.token}`);
    expect(raw.status).toBe(401);
  });

  it('the legacy auth routes keep working while the flag is on', async () => {
    const token = await helpers.adminToken(app);
    expect(token).toBeTruthy();
  });

  it('bridges an existing user: the current argon2 hash signs in through Better Auth unchanged', async () => {
    const token = await helpers.adminToken(app);
    const legacy = await helpers.createUserViaApi(app, token);
    // Từ chặng 2.6 (issue #7), tạo user qua API đã TỰ đồng bộ
    // credential (UsersService gọi cầu nối sau khi ghi mật khẩu) nên
    // user mới không còn ở trạng thái "chưa có credential". Ca này
    // kiểm đường LINK cho user tồn tại từ trước thời đồng bộ (hash
    // nằm ở users.password_hash, chưa có dòng account) — xoá dòng
    // credential vừa được tự đồng bộ để dựng lại đúng trạng thái đó.
    await pg.query("delete from account where user_id = $1 and provider_id = 'credential'", [legacy.id]);
    expect(await bridge.linkExistingPasswordHash(legacy.id)).toBe(true);
    expect(await bridge.linkExistingPasswordHash(legacy.id)).toBe(false);
    const res = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: legacy.username, password: helpers.STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(legacy.username);
  });

  it('two concurrent linkExistingPasswordHash calls yield exactly one credential row', async () => {
    const token = await helpers.adminToken(app);
    const legacy = await helpers.createUserViaApi(app, token);
    // Trạng thái "user có hash nhưng chưa có credential" như ca trên.
    await pg.query("delete from account where user_id = $1 and provider_id = 'credential'", [legacy.id]);
    const results = await Promise.all([
      bridge.linkExistingPasswordHash(legacy.id),
      bridge.linkExistingPasswordHash(legacy.id),
    ]);
    // Đúng một lời gọi thực sự chèn (true); lời còn lại nhận false thay
    // vì văng lỗi trùng UNIQUE (user_id, provider_id) — chèn idempotent
    // của điểm 2.1 (hồ sơ Giai đoạn 2).
    expect(results.filter((r) => r === true)).toHaveLength(1);
    expect(results.filter((r) => r === false)).toHaveLength(1);
    const rows = await pg.query(
      "select count(*)::int as n from account where user_id = $1 and provider_id = 'credential'",
      [legacy.id],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('a failure at account creation rolls the user back (no orphan user)', async () => {
    const orphanName = helpers.uniqueName('baorphan');
    // Ép lỗi tại đúng bước chèn account BÊN TRONG transaction của cầu
    // nối: trigger chặn INSERT vào account khi user của nó mang
    // username của test này. Dòng user đã chèn ngay trước đó trong
    // cùng transaction phải bị rollback theo — tiêu chí "không còn
    // user mồ côi" của điểm 2.1 (hồ sơ Giai đoạn 2).
    await pg.query(`
      create or replace function test_fail_account_insert() returns trigger as $fn$
      begin
        if exists (select 1 from users u where u.id = new.user_id and u.username = '${orphanName}') then
          raise exception 'forced account creation failure (test)';
        end if;
        return new;
      end
      $fn$ language plpgsql
    `);
    await pg.query(
      'create trigger test_fail_account_insert before insert on account for each row execute function test_fail_account_insert()',
    );
    let caught: unknown;
    try {
      await bridge.createUserWithCredential({
        email: `${orphanName}@example.com`,
        username: orphanName,
        firstName: 'Orphan',
        lastName: 'Rollback',
        password: FLOW_PASSWORD,
      });
    } catch (err) {
      caught = err;
    } finally {
      await pg.query('drop trigger if exists test_fail_account_insert on account');
      await pg.query('drop function if exists test_fail_account_insert()');
    }
    expect(caught).toBeTruthy();
    // Thông điệp lỗi phải là lỗi bị ép tại bước account (không phải
    // lỗi khác tình cờ) — duyệt cả chuỗi cause vì tầng ORM có thể bọc.
    const texts: string[] = [];
    let current: unknown = caught;
    while (current && typeof current === 'object' && texts.length < 6) {
      const message = (current as { message?: unknown }).message;
      if (typeof message === 'string') texts.push(message);
      current = (current as { cause?: unknown }).cause;
    }
    expect(texts.join(' | ')).toMatch(/forced account creation failure/);
    const users = await pg.query('select count(*)::int as n from users where username = $1', [orphanName]);
    expect(users.rows[0].n).toBe(0);
  });

  it('public sign-up stays closed', async () => {
    const name = helpers.uniqueName('basignup');
    const res = await http(app)
      .post('/api/v1/auth/sign-up/email')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: `${name}@example.com`, password: FLOW_PASSWORD, name: 'Nope' });
    expect(res.status).toBe(400);
  });
});
