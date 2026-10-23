import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BetterAuthService } from '../src/modules/auth/better-auth/better-auth.service';
import type { CredentialBridgeService } from '../src/modules/auth/better-auth/credential-bridge.service';

/**
 * Flow test của nền Better Auth (issue #7, Giai đoạn 1) — chạy với cờ
 * BETTER_AUTH_ENABLED bật. Đường auth cũ vẫn là đường chính của hệ; spec
 * này chứng minh các cổng đạt của giai đoạn trên code thật: đăng nhập
 * username qua Better Auth, phiên ghi IP/User-Agent, guard mỏng nhận
 * cookie trên route nghiệp vụ, suspended bị chặn dù phiên còn hạn, huỷ
 * phiên hiệu lực ngay, endpoint đổi trạng thái thiếu Origin bị 403 (kèm
 * cookie — kiểm tra Origin của 1.7.12 chỉ kích hoạt khi request mang
 * cookie, xem Giai đoạn 0), phiên tạo theo chương trình cho login-as,
 * cầu nối hash từ hệ cũ, và route auth cũ vẫn chạy khi cờ bật.
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

type Helpers = typeof import('./identity-access-helpers');
let helpers: Helpers;

function http(app: INestApplication) {
  return request(app.getHttpServer());
}

async function createMountedTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../src/app.module');
  const { enableTrustedProxy } = await import('../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../src/modules/auth/better-auth/better-auth.service'
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
    helpers = await import('./identity-access-helpers');
    app = await createMountedTestApp();
    const { CredentialBridgeService: BridgeClass } = await import(
      '../src/modules/auth/better-auth/credential-bridge.service'
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
    expect(await bridge.linkExistingPasswordHash(legacy.id)).toBe(true);
    expect(await bridge.linkExistingPasswordHash(legacy.id)).toBe(false);
    const res = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: legacy.username, password: helpers.STRONG_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe(legacy.username);
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
