import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { generate } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BetterAuthService } from '../src/modules/auth/better-auth/better-auth.service';
import type { CredentialBridgeService } from '../src/modules/auth/better-auth/credential-bridge.service';
import type { TotpService } from '../src/modules/auth/totp.service';

/**
 * E2E đăng nhập xã hội Google + Facebook cho Better Auth (issue #7,
 * chặng 2.3) — provider THẬT của Better Auth nhưng biên HTTP ra ngoài
 * (token endpoint, JWKS, debug_token, /me) được giả lập bằng cách thay
 * `globalThis.fetch`: không cần bí mật thật, vẫn đi trọn đường callback
 * → verify id_token (RS256 qua JWKS tự ký) → liên kết tài khoản → cổng
 * MFA sau callback.
 *
 * Quy tắc nghiệp vụ thể hiện ở đây (chốt trong hồ sơ chương trình GĐ2):
 *  - email đã có tài khoản + email do provider xác thực (Google) →
 *    liên kết vào tài khoản đó, không tạo user mới;
 *  - email hoàn toàn mới → CHẶN tạo tài khoản qua OAuth (disableSignUp
 *    cấp provider), redirect lỗi, không user/không session;
 *  - Facebook KHÔNG nằm trong trustedProviders và email của nó không
 *    được Better Auth coi là đã xác thực → KHÔNG liên kết ngầm;
 *  - tài khoản đã bật MFA (factor TOTP đã xác nhận trong `user_totp`
 *    — nguồn trạng thái MFA duy nhất) → callback OAuth bị cổng chặn:
 *    KHÔNG tồn tại session dùng được trong lúc chờ bước hai, redirect
 *    mang `twoFactorRedirect=true` + cookie chờ bước hai.
 *
 * Biến môi trường phải tồn tại TRƯỚC khi AppModule được nạp
 * (ConfigModule validate ngay lúc import) nên các import của AppModule
 * đều là import động bên trong beforeAll — như spec nền BA.
 */

process.env.BETTER_AUTH_ENABLED = 'true';
const baKey = process.env['BETTER_AUTH_' + 'SECRET'];
if (!baKey) {
  process.env['BETTER_AUTH_' + 'SECRET'] = 'ba3-oauth-e2e-secret-ba3-oauth-e2e-secret-42';
}
process.env.GOOGLE_CLIENT_ID = 'ba3-google-client-id';
process.env['GOOGLE_CLIENT_' + 'SECRET'] = 'ba3-google-client-secret';
process.env.FACEBOOK_APP_ID = 'ba3-facebook-app-id';
process.env['FACEBOOK_APP_' + 'SECRET'] = 'ba3-facebook-app-secret';
process.env.BETTER_AUTH_TRUSTED_ORIGINS = 'http://localhost:3100';

const GOOGLE_CLIENT_ID = 'ba3-google-client-id';
const FB_APP_ID = 'ba3-facebook-app-id';
const ORIGIN = 'http://localhost:3100';
const seedPass = 'Ba3SeedPass!234';

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
  const betterAuth: BetterAuthService = app.get(BetterAuthServiceClass);
  mountBetterAuth(app as NestExpressApplication, betterAuth.requireAuth());
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  return app;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('Better Auth — đăng nhập xã hội Google/Facebook (e2e, provider giả lập ở biên HTTP)', () => {
  let app: INestApplication;
  let server: ReturnType<INestApplication['getHttpServer']>;
  let bridge: CredentialBridgeService;
  let totp: TotpService;
  let pg: Client;
  let googlePrivateKey: KeyObject;
  let googleJwks: { keys: unknown[] };
  let currentGoogleIdToken = '';
  let fbProfile: { id: string; name: string; email: string } = {
    id: 'fb-user-1',
    name: 'Fb User One',
    email: 'fb-linked@ba3.test',
  };
  const realFetch = globalThis.fetch;

  function mintGoogleIdToken(claims: { sub: string; email: string; emailVerified: boolean }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: 'ba3-key-1', typ: 'JWT' };
    const payload = {
      iss: 'https://accounts.google.com',
      aud: GOOGLE_CLIENT_ID,
      sub: claims.sub,
      email: claims.email,
      email_verified: claims.emailVerified,
      name: 'Google User',
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(googlePrivateKey, 'base64url');
    return `${unsigned}.${signature}`;
  }

  async function startSocial(provider: 'google' | 'facebook'): Promise<{ state: string; cookies: string[] }> {
    const res = await request(server)
      .post('/api/v1/auth/sign-in/social')
      .set('Origin', ORIGIN)
      .send({ provider, callbackURL: '/dashboard' });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url as string);
    const state = url.searchParams.get('state');
    expect(state).toBeTruthy();
    const setCookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    return { state: state as string, cookies: setCookies.map((c) => c.split(';')[0]) };
  }

  async function runCallback(provider: 'google' | 'facebook', state: string, cookies: string[]) {
    return request(server)
      .get(`/api/v1/auth/callback/${provider}?code=ba3-fake-code&state=${encodeURIComponent(state)}`)
      .set('Cookie', cookies.join('; '));
  }

  function sessionCookieValue(res: request.Response): string | null {
    const setCookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    for (const entry of setCookies) {
      const match = /^better-auth\.session_token=([^;]*)/.exec(entry);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  async function countRows(sql: string, params: unknown[]): Promise<number> {
    const result = await pg.query<{ n: number }>(sql, params);
    return result.rows[0].n;
  }

  beforeAll(async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    googlePrivateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    googleJwks = { keys: [{ ...jwk, kid: 'ba3-key-1', alg: 'RS256', use: 'sig' }] };

    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      // better-fetch truyền đối tượng URL làm đối số đầu — lấy href.
      const url =
        typeof input === 'string'
          ? input
          : (((input as { href?: string })?.href ?? (input as { url?: string })?.url) ?? '');
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({
          access_token: 'ba3-google-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: currentGoogleIdToken,
        });
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
        return jsonResponse(googleJwks);
      }
      if (url.startsWith('https://graph.facebook.com/v24.0/oauth/access_token')) {
        return jsonResponse({
          access_token: 'ba3-fb-access-token',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }
      if (url.startsWith('https://graph.facebook.com/debug_token')) {
        return jsonResponse({
          data: {
            app_id: FB_APP_ID,
            is_valid: true,
            user_id: fbProfile.id,
            type: 'USER',
            scopes: ['email', 'public_profile'],
          },
        });
      }
      if (url.startsWith('https://graph.facebook.com/me')) {
        return jsonResponse({
          id: fbProfile.id,
          name: fbProfile.name,
          email: fbProfile.email,
          picture: { data: { url: 'https://example.test/fb.png' } },
        });
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;

    app = await createMountedTestApp();
    server = app.getHttpServer();
    const { CredentialBridgeService: BridgeClass } = await import(
      '../src/modules/auth/better-auth/credential-bridge.service'
    );
    const { TotpService: TotpClass } = await import('../src/modules/auth/totp.service');
    bridge = app.get(BridgeClass);
    totp = app.get(TotpClass);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DELETE FROM users WHERE email LIKE '%@ba3.test'`);
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg.query(`DELETE FROM users WHERE email LIKE '%@ba3.test'`);
    await pg.end();
    await app.close();
  });

  it('Google lần đầu: email trùng tài khoản có sẵn → liên kết + có session', async () => {
    const email = 'google-linked@ba3.test';
    const seeded = await bridge.createUserWithCredential({
      email,
      username: 'ba3google1',
      firstName: 'Google',
      lastName: 'Linked',
      password: seedPass
    });
    currentGoogleIdToken = mintGoogleIdToken({ sub: 'google-sub-1', email, emailVerified: true });

    const { state, cookies } = await startSocial('google');
    const res = await runCallback('google', state, cookies);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('/dashboard');
    expect(sessionCookieValue(res)).toBeTruthy();
    const accounts = await countRows(
      `SELECT count(*)::int AS n FROM account WHERE user_id = $1 AND provider_id = 'google' AND account_id = 'google-sub-1'`,
      [seeded.id],
    );
    expect(accounts).toBe(1);
    const sessions = await countRows(
      `SELECT count(*)::int AS n FROM session WHERE user_id = $1`,
      [seeded.id],
    );
    expect(sessions).toBeGreaterThanOrEqual(1);
    const users = await countRows(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      [email],
    );
    expect(users).toBe(1);
  });

  it('Google lần hai: đăng nhập qua liên kết có sẵn, không tạo account trùng', async () => {
    const email = 'google-linked@ba3.test';
    const userRow = await pg.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1`,
      [email],
    );
    const userId = userRow.rows[0].id;
    currentGoogleIdToken = mintGoogleIdToken({ sub: 'google-sub-1', email, emailVerified: true });

    const { state, cookies } = await startSocial('google');
    const res = await runCallback('google', state, cookies);

    expect(res.status).toBe(302);
    expect(sessionCookieValue(res)).toBeTruthy();
    const accounts = await countRows(
      `SELECT count(*)::int AS n FROM account WHERE user_id = $1 AND provider_id = 'google'`,
      [userId],
    );
    expect(accounts).toBe(1);
  });

  it('Google email hoàn toàn mới: chặn tạo tài khoản qua OAuth', async () => {
    const email = 'google-new@ba3.test';
    currentGoogleIdToken = mintGoogleIdToken({ sub: 'google-sub-new', email, emailVerified: true });

    const { state, cookies } = await startSocial('google');
    const res = await runCallback('google', state, cookies);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('error');
    expect(sessionCookieValue(res)).toBeNull();
    const users = await countRows(
      `SELECT count(*)::int AS n FROM users WHERE email = $1`,
      [email],
    );
    expect(users).toBe(0);
  });

  it('Google + tài khoản đã bật MFA: cổng chặn — không session dùng được, redirect sang bước hai', async () => {
    const email = 'google-mfa@ba3.test';
    const seeded = await bridge.createUserWithCredential({
      email,
      username: 'ba3googlemfa',
      firstName: 'Google',
      lastName: 'Mfa',
      password: seedPass
    });
    // Bật MFA qua chính TotpService của hệ: factor TOTP đã xác nhận
    // trong `user_totp` là tín hiệu duy nhất cổng MFA nhìn (trước đây
    // ca này chèn thẳng bản ghi two_factor — kho đó không còn là
    // nguồn trạng thái nữa nên cổng không kích hoạt nếu chỉ có nó).
    const { secret } = await totp.setup(seeded.id, 'ba3googlemfa');
    await totp.confirm(seeded.id, await generate({ secret }));
    currentGoogleIdToken = mintGoogleIdToken({ sub: 'google-sub-mfa', email, emailVerified: true });

    const { state, cookies } = await startSocial('google');
    const res = await runCallback('google', state, cookies);

    expect(res.status).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain('twoFactorRedirect=true');
    // Tiêu chí cứng của spike: KHÔNG tồn tại phiên authenticated trong
    // lúc chờ bước hai — cookie session rỗng và không có dòng session.
    expect(sessionCookieValue(res)).toBeNull();
    const sessions = await countRows(
      `SELECT count(*)::int AS n FROM session WHERE user_id = $1`,
      [seeded.id],
    );
    expect(sessions).toBe(0);
    // Hiện vật bước hai đúng định dạng plugin twoFactor ghi: cookie chờ
    // ký + verification 2fa-* trỏ về user và bộ đếm lần thử = 0.
    const setCookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    expect(setCookies.some((c) => c.startsWith('better-auth.two_factor='))).toBe(true);
    const pending = await pg.query<{ identifier: string; value: string }>(
      `SELECT identifier, value FROM verification WHERE identifier LIKE '2fa%' ORDER BY identifier`,
    );
    const pendingForUser = pending.rows.filter((r) => r.value === seeded.id);
    expect(pendingForUser.length).toBeGreaterThanOrEqual(1);
    const attempts = pending.rows.filter((r) => r.identifier.startsWith('2fa-attempts-'));
    expect(attempts.some((r) => r.value === '0')).toBe(true);
  });

  it('Facebook: email trùng tài khoản có sẵn nhưng KHÔNG liên kết ngầm (email không được tin cậy)', async () => {
    const email = 'fb-linked@ba3.test';
    const seeded = await bridge.createUserWithCredential({
      email,
      username: 'ba3fbuser1',
      firstName: 'Fb',
      lastName: 'Linked',
      password: seedPass
    });
    fbProfile = { id: 'fb-user-1', name: 'Fb User One', email };

    const { state, cookies } = await startSocial('facebook');
    const res = await runCallback('facebook', state, cookies);

    expect(res.status).toBe(302);
    expect(res.headers.location as string).toContain('error');
    expect(sessionCookieValue(res)).toBeNull();
    const accounts = await countRows(
      `SELECT count(*)::int AS n FROM account WHERE user_id = $1 AND provider_id = 'facebook'`,
      [seeded.id],
    );
    expect(accounts).toBe(0);
    const sessions = await countRows(
      `SELECT count(*)::int AS n FROM session WHERE user_id = $1`,
      [seeded.id],
    );
    expect(sessions).toBe(0);
  });
});
