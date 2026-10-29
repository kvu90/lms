import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { INestApplication, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { generate } from 'otplib';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderAuthMail, type AuthMailPayload } from '@lms/contracts';
import type { BetterAuthService } from '../../../src/modules/auth/better-auth/better-auth.service';
import type { CredentialBridgeService } from '../../../src/modules/auth/better-auth/credential-bridge.service';
import type { TotpService } from '../../../src/modules/auth/totp.service';
import type { MailMessage } from '../../../src/modules/mail/mail.types';

/**
 * Cổng MFA thống nhất trên các đường đăng nhập của Better Auth.
 *
 * Quy tắc nghiệp vụ được kiểm chứng (nguồn trạng thái MFA DUY NHẤT là
 * bảng `user_totp` của module auth — factor TOTP đã xác nhận):
 * - (a) Đăng nhập bằng username/mật khẩu: mật khẩu đúng vẫn CHƯA có
 *   phiên dùng được — đáp ứng là dấu `twoFactorRedirect` + cookie chờ
 *   của bước hai, không cookie phiên, không dòng session. Mã TOTP sai
 *   bị từ chối; ngân sách thử của một challenge có hạn (hết ngân sách
 *   thì mã đúng cũng bị từ chối, phải đăng nhập lại); mã đúng trong
 *   ngân sách → phiên thật, dùng được trên route nghiệp vụ.
 * - (b) Đăng nhập bằng email OTP: cùng khuôn — OTP email đúng vẫn
 *   dừng ở bước TOTP.
 * - (c) Callback social (Google): tài khoản đã liên kết + đã bật MFA
 *   → bị gác: redirect mang `twoFactorRedirect=true`, không phiên;
 *   qua bước TOTP mới có phiên.
 * - Kho `two_factor` của plugin KHÔNG tham gia ở bất kỳ bước nào:
 *   bước hoàn tất (endpoint Nest `/auth/two-factor/verify-totp`)
 *   kiểm mã thẳng vào `user_totp` — không bản ghi two_factor nào
 *   được tạo cho người dùng trong suốt luồng.
 * - (e) Hồi quy: người chưa bật MFA đăng nhập như cũ ở mọi đường;
 *   người bị đình chỉ vẫn bị guard chặn trên route nghiệp vụ.
 *
 * Biến môi trường phải tồn tại TRƯỚC khi AppModule được nạp nên các
 * import của AppModule đều là import động bên trong beforeAll — như
 * các spec Better Auth khác. Provider Google được giả lập ở biên HTTP
 * bằng cách thay `globalThis.fetch` (JWKS/token) như spec social.
 */
process.env.BETTER_AUTH_ENABLED = 'true';
const BA_SECRET = 'mfa-gate-e2e-secret-mfa-gate-e2e-secret-42';
process.env.BETTER_AUTH_SECRET = BA_SECRET;
const TRUSTED_ORIGIN = 'http://localhost:3100';
process.env.BETTER_AUTH_TRUSTED_ORIGINS = TRUSTED_ORIGIN;
process.env.GOOGLE_CLIENT_ID = 'mfagate-google-client-id';
process.env['GOOGLE_CLIENT_' + 'SECRET'] = 'mfagate-google-client-secret';

const GOOGLE_CLIENT_ID = 'mfagate-google-client-id';
const FLOW_PASSWORD = 'MfaGatePass123';

type Helpers = typeof import('../../support/identity-access-helpers');
let helpers: Helpers;

function http(app: INestApplication) {
  return request(app.getHttpServer());
}

async function createMountedTestApp(): Promise<INestApplication> {
  const { AppModule } = await import('../../../src/app.module');
  const { enableTrustedProxy } = await import('../../../src/common/client-ip');
  const { ProblemDetailsFilter } = await import('../../../src/common/problem-details.filter');
  const { mountBetterAuth } = await import('../../../src/modules/auth/better-auth/better-auth.mount');
  const { BetterAuthService: BetterAuthServiceClass } = await import(
    '../../../src/modules/auth/better-auth/better-auth.service'
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

/** Cặp cookie theo tên từ header set-cookie của một đáp ứng (null khi cookie vắng hoặc bị xoá rỗng). */
function cookiePairFrom(setCookie: string[] | undefined, name: string): string | null {
  const raw = (setCookie ?? []).find((value) => value.startsWith(`${name}=`));
  if (!raw) return null;
  const pair = raw.split(';')[0]!;
  return pair.length > name.length + 1 ? pair : null;
}

/**
 * Đáp ứng có mang cookie phiên SỐNG nào không — kiểm mọi entry,
 * không phụ thuộc thứ tự: entry xoá cookie của cổng (tên + giá trị
 * rỗng) không tính là phiên sống.
 */
function hasLiveSessionCookie(setCookie: string[] | undefined): boolean {
  return (setCookie ?? [])
    .filter((c) => c.startsWith('better-auth.session_token='))
    .some((c) => (c.split(';')[0] ?? '').length > 'better-auth.session_token='.length);
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

/** Một mã TOTP 6 số chắc chắn không khớp cửa sổ kiểm chứng của secret. */
async function wrongTotpCode(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const valid = new Set<string>();
  for (const delta of [-30, 0, 30]) valid.add(await generate({ secret, epoch: now + delta }));
  for (const candidate of ['000000', '111111', '222222', '333333', '444444', '555555']) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('no wrong-code candidate available');
}

describe('Cổng MFA thống nhất của Better Auth (user_totp là nguồn duy nhất)', () => {
  let app: INestApplication;
  let bridge: CredentialBridgeService;
  let totp: TotpService;
  let pg: Client;
  let googlePrivateKey: KeyObject;
  let googleJwks: { keys: unknown[] };
  let currentGoogleIdToken = '';
  const realFetch = globalThis.fetch;
  /** Mail đã bắt được (dựng từ dòng outbox, xem waitForMailTo). */
  const sentMails: MailMessage[] = [];
  /** Id các dòng outbox đã dựng thành mail, tránh bắt trùng một dòng hai lần. */
  const capturedRowIds = new Set<string>();

  function mintGoogleIdToken(claims: { sub: string; email: string }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'RS256', kid: 'mfagate-key-1', typ: 'JWT' };
    const payload = {
      iss: 'https://accounts.google.com',
      aud: GOOGLE_CLIENT_ID,
      sub: claims.sub,
      email: claims.email,
      email_verified: true,
      name: 'Google User',
      iat: now,
      exp: now + 3600,
    };
    const unsigned = `${base64urlJson(header)}.${base64urlJson(payload)}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(googlePrivateKey, 'base64url');
    return `${unsigned}.${signature}`;
  }

  async function createUser(prefix: string): Promise<{ id: string; username: string; email: string }> {
    const username = helpers.uniqueName(prefix);
    const email = `${username}@example.com`;
    const created = await bridge.createUserWithCredential({
      email,
      username,
      firstName: 'Mfa',
      lastName: 'Gate',
      password: FLOW_PASSWORD,
    });
    return { id: created.id, username, email };
  }

  /** Bật MFA cho user qua chính TotpService của hệ (setup + confirm), trả secret để sinh mã. */
  async function enableMfa(userId: string, username: string): Promise<string> {
    const { secret } = await totp.setup(userId, username);
    await totp.confirm(userId, await generate({ secret }));
    return secret;
  }

  async function sessionCount(userId: string): Promise<number> {
    const rows = await pg.query<{ n: number }>('select count(*)::int as n from session where user_id = $1', [userId]);
    return rows.rows[0].n;
  }

  /**
   * Chờ tới khi có mail gửi cho địa chỉ này: nội dung mail được dựng
   * từ dòng outbox `auth_mail_requested` của chính địa chỉ đó bằng
   * `renderAuthMail` dùng chung ở `@lms/contracts` — hàm mà
   * processor ở phía worker gọi khi gửi thật (khâu gửi đã chuyển
   * sang hàng đợi ở worker, issue #517; dòng outbox được ghi đồng bộ
   * trong request nên thường có ngay).
   */
  async function waitForMailTo(email: string, timeoutMs = 9000): Promise<MailMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = sentMails.find((mail) => mail.to === email);
      if (found) return found;
      const rows = await pg.query(
        "select id, payload from outbox_events where type = 'auth_mail_requested' and payload->>'to' = $1 order by seq desc limit 1",
        [email],
      );
      const row = rows.rows[0] as { id: string; payload: AuthMailPayload } | undefined;
      if (row) {
        const mail = renderAuthMail(row.payload);
        if (!capturedRowIds.has(row.id)) {
          capturedRowIds.add(row.id);
          sentMails.push(mail);
        }
        return mail;
      }
      if (Date.now() > deadline) throw new Error(`no mail captured for ${email}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /** Gọi endpoint hoàn tất bước hai với cookie chờ lấy từ đáp ứng bị gác. */
  async function verifyTotp(twoFactorCookie: string, code: string) {
    return http(app)
      .post('/api/v1/auth/two-factor/verify-totp')
      .set('Origin', TRUSTED_ORIGIN)
      .set('Cookie', twoFactorCookie)
      .send({ code });
  }

  beforeAll(async () => {
    helpers = await import('../../support/identity-access-helpers');
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    googlePrivateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
    googleJwks = { keys: [{ ...jwk, kid: 'mfagate-key-1', alg: 'RS256', use: 'sig' }] };
    globalThis.fetch = (async (input: unknown, init?: unknown) => {
      const url =
        typeof input === 'string'
          ? input
          : (((input as { href?: string })?.href ?? (input as { url?: string })?.url) ?? '');
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return jsonResponse({
          access_token: 'mfagate-google-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: currentGoogleIdToken,
        });
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
        return jsonResponse(googleJwks);
      }
      return realFetch(input as never, init as never);
    }) as typeof fetch;

    app = await createMountedTestApp();
    const { CredentialBridgeService: BridgeClass } = await import(
      '../../../src/modules/auth/better-auth/credential-bridge.service'
    );
    const { TotpService: TotpClass } = await import('../../../src/modules/auth/totp.service');
    bridge = app.get(BridgeClass);
    totp = app.get(TotpClass);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg?.end();
    await app?.close();
  });

  it('(a) credential: mật khẩu đúng vẫn chưa có phiên; mã sai bị từ chối; mã đúng mới cấp phiên dùng được', async () => {
    const user = await createUser('mfagatecred');
    const secret = await enableMfa(user.id, user.username);

    const signIn = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: user.username, password: FLOW_PASSWORD });
    expect(signIn.status).toBe(200);
    // Đáp ứng là dấu chờ bước hai, KHÔNG phải đáp ứng đăng nhập đầy đủ.
    expect(signIn.body.twoFactorRedirect).toBe(true);
    expect(signIn.body.twoFactorMethods).toEqual(['totp']);
    expect(signIn.body.token).toBeUndefined();
    const setCookie = signIn.headers['set-cookie'] as unknown as string[];
    expect(hasLiveSessionCookie(setCookie)).toBe(false);
    const twoFactorCookie = cookiePairFrom(setCookie, 'better-auth.two_factor');
    expect(twoFactorCookie).toBeTruthy();
    // Không tồn tại phiên nào trong DB và cookie chờ không tự nó là phiên.
    expect(await sessionCount(user.id)).toBe(0);
    const sessionProbe = await http(app).get('/api/v1/auth/get-session').set('Cookie', twoFactorCookie!);
    expect(sessionProbe.body ?? null).toBeNull();

    // Kho của plugin twoFactor KHÔNG tham gia: không bản ghi
    // two_factor nào được tạo — bước hoàn tất kiểm mã thẳng vào
    // `user_totp` (nguồn duy nhất), không có hình chiếu nào để lệch.
    const record = await pg.query<{ n: number }>(
      'select count(*)::int as n from two_factor where user_id = $1',
      [user.id],
    );
    expect(record.rows[0].n).toBe(0);

    // Mã sai bị từ chối, vẫn chưa có phiên.
    const wrong = await verifyTotp(twoFactorCookie!, await wrongTotpCode(secret));
    expect(wrong.status).toBe(401);
    expect(await sessionCount(user.id)).toBe(0);

    // Mã đúng trong ngân sách thử → phiên thật dùng được.
    const ok = await verifyTotp(twoFactorCookie!, await generate({ secret }));
    expect(ok.status).toBe(200);
    const sessionCookie = cookiePairFrom(ok.headers['set-cookie'] as unknown as string[], 'better-auth.session_token');
    expect(sessionCookie).toBeTruthy();
    expect(await sessionCount(user.id)).toBe(1);
    const me = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie!);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(user.username);
  });

  it('(a2) credential: hết ngân sách thử của challenge thì mã đúng cũng bị từ chối — đăng nhập lại với challenge mới thì qua', async () => {
    const user = await createUser('mfagatebudget');
    const secret = await enableMfa(user.id, user.username);

    const signIn = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: user.username, password: FLOW_PASSWORD });
    const twoFactorCookie = cookiePairFrom(
      signIn.headers['set-cookie'] as unknown as string[],
      'better-auth.two_factor',
    );
    expect(twoFactorCookie).toBeTruthy();
    const wrong = await wrongTotpCode(secret);
    // Ngân sách của plugin là 5 lần thử cho một challenge.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await verifyTotp(twoFactorCookie!, wrong);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const exhausted = await verifyTotp(twoFactorCookie!, await generate({ secret }));
    expect(exhausted.status).toBeGreaterThanOrEqual(400);
    expect(await sessionCount(user.id)).toBe(0);

    // Challenge mới từ một lần đăng nhập lại: mã đúng qua bình thường.
    const again = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: user.username, password: FLOW_PASSWORD });
    const freshCookie = cookiePairFrom(
      again.headers['set-cookie'] as unknown as string[],
      'better-auth.two_factor',
    );
    const ok = await verifyTotp(freshCookie!, await generate({ secret }));
    expect(ok.status).toBe(200);
    expect(await sessionCount(user.id)).toBe(1);
  });

  it('(a3) credential: mật khẩu SAI cho tài khoản có MFA bị từ chối ngay ở bước một, không sinh challenge', async () => {
    const user = await createUser('mfagatewrongpw');
    await enableMfa(user.id, user.username);
    const res = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: user.username, password: 'WrongPass123' });
    expect(res.status).toBe(401);
    expect(res.body.twoFactorRedirect).toBeUndefined();
    const pending = await pg.query<{ n: number }>(
      "select count(*)::int as n from verification where identifier like '2fa-%' and value = $1",
      [user.id],
    );
    expect(pending.rows[0].n).toBe(0);
  });

  it('(b) email OTP: mã email đúng vẫn dừng ở bước TOTP; qua TOTP mới có phiên', async () => {
    const user = await createUser('mfagateotp');
    const secret = await enableMfa(user.id, user.username);
    await pg.query('update users set email_verified = true where id = $1', [user.id]);

    const sent = await http(app)
      .post('/api/v1/auth/email-otp/send-verification-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, type: 'sign-in' });
    expect(sent.status).toBe(200);
    const mail = await waitForMailTo(user.email);
    const otp = /\b(\d{6})\b/.exec(mail.text)?.[1];
    expect(otp).toBeTruthy();

    const signIn = await http(app)
      .post('/api/v1/auth/sign-in/email-otp')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ email: user.email, otp });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBe(true);
    const setCookie = signIn.headers['set-cookie'] as unknown as string[];
    expect(hasLiveSessionCookie(setCookie)).toBe(false);
    const twoFactorCookie = cookiePairFrom(setCookie, 'better-auth.two_factor');
    expect(twoFactorCookie).toBeTruthy();
    expect(await sessionCount(user.id)).toBe(0);

    const ok = await verifyTotp(twoFactorCookie!, await generate({ secret }));
    expect(ok.status).toBe(200);
    const sessionCookie = cookiePairFrom(ok.headers['set-cookie'] as unknown as string[], 'better-auth.session_token');
    expect(sessionCookie).toBeTruthy();
    const me = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie!);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(user.username);
  });

  it('(c) social callback: tài khoản đã liên kết + có MFA bị gác ở callback; qua TOTP mới có phiên', async () => {
    const user = await createUser('mfagatesocial');
    const secret = await enableMfa(user.id, user.username);
    // sub duy nhất mỗi lượt chạy: sub cố định sẽ khớp vào account đã
    // liên kết của một lượt chạy trước trên cùng DB test (callback
    // khớp theo account trước khi khớp theo email).
    currentGoogleIdToken = mintGoogleIdToken({ sub: `mfagate-${helpers.uniqueName('gsub')}`, email: user.email });

    const start = await http(app)
      .post('/api/v1/auth/sign-in/social')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ provider: 'google', callbackURL: '/dashboard' });
    expect(start.status).toBe(200);
    const state = new URL(start.body.url as string).searchParams.get('state');
    expect(state).toBeTruthy();
    const startCookies = ((start.headers['set-cookie'] as unknown as string[]) ?? []).map((c) => c.split(';')[0]);

    const callback = await http(app)
      .get(`/api/v1/auth/callback/google?code=mfagate-code&state=${encodeURIComponent(state!)}`)
      .set('Cookie', startCookies.join('; '));
    expect(callback.status).toBe(302);
    expect(callback.headers.location as string).toContain('twoFactorRedirect=true');
    const callbackCookies = callback.headers['set-cookie'] as unknown as string[];
    expect(hasLiveSessionCookie(callbackCookies)).toBe(false);
    const twoFactorCookie = cookiePairFrom(callbackCookies, 'better-auth.two_factor');
    expect(twoFactorCookie).toBeTruthy();
    expect(await sessionCount(user.id)).toBe(0);
    // Liên kết Google đã ghi (callback khớp tài khoản) nhưng chưa có phiên.
    const accounts = await pg.query<{ n: number }>(
      "select count(*)::int as n from account where user_id = $1 and provider_id = 'google'",
      [user.id],
    );
    expect(accounts.rows[0].n).toBe(1);

    const ok = await verifyTotp(twoFactorCookie!, await generate({ secret }));
    expect(ok.status).toBe(200);
    expect(await sessionCount(user.id)).toBe(1);
    const sessionCookie = cookiePairFrom(ok.headers['set-cookie'] as unknown as string[], 'better-auth.session_token');
    const me = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie!);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(user.username);
  });

  it('(e) hồi quy: người chưa bật MFA đăng nhập credential và social như cũ; người bị đình chỉ vẫn bị guard chặn', async () => {
    const plain = await createUser('mfagateplain');
    const signIn = await http(app)
      .post('/api/v1/auth/sign-in/username')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ username: plain.username, password: FLOW_PASSWORD });
    expect(signIn.status).toBe(200);
    expect(signIn.body.twoFactorRedirect).toBeUndefined();
    const sessionCookie = cookiePairFrom(
      signIn.headers['set-cookie'] as unknown as string[],
      'better-auth.session_token',
    );
    expect(sessionCookie).toBeTruthy();
    const me = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie!);
    expect(me.status).toBe(200);

    // Social không MFA: callback cấp phiên ngay như cũ.
    currentGoogleIdToken = mintGoogleIdToken({ sub: `mfagate-${helpers.uniqueName('gsub')}`, email: plain.email });
    const start = await http(app)
      .post('/api/v1/auth/sign-in/social')
      .set('Origin', TRUSTED_ORIGIN)
      .send({ provider: 'google', callbackURL: '/dashboard' });
    const state = new URL(start.body.url as string).searchParams.get('state');
    const startCookies = ((start.headers['set-cookie'] as unknown as string[]) ?? []).map((c) => c.split(';')[0]);
    const callback = await http(app)
      .get(`/api/v1/auth/callback/google?code=mfagate-code-plain&state=${encodeURIComponent(state!)}`)
      .set('Cookie', startCookies.join('; '));
    expect(callback.status).toBe(302);
    expect(callback.headers.location as string).toContain('/dashboard');
    expect(callback.headers.location as string).not.toContain('twoFactorRedirect');
    expect(
      cookiePairFrom(callback.headers['set-cookie'] as unknown as string[], 'better-auth.session_token'),
    ).toBeTruthy();

    // Đình chỉ: phiên đăng nhập vẫn bị guard mỏng chặn trên route nghiệp vụ.
    await pg.query('update users set suspended = true where id = $1', [plain.id]);
    try {
      const blocked = await http(app).get('/api/v1/users/me').set('Cookie', sessionCookie!);
      expect(blocked.status).toBe(401);
    } finally {
      await pg.query('update users set suspended = false where id = $1', [plain.id]);
    }
  });
});
