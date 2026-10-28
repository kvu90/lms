import { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from '../../support/identity-access-helpers';
import type { SessionCacheService } from '../../../src/infra/cache/session-cache.service';

/**
 * Cổng MFA trên luồng OAuth hệ cũ (đăng nhập Google/Facebook qua
 * `/auth/oauth/*` + đổi mã bàn giao `/auth/oauth/handoff`) — cùng
 * nguồn trạng thái MFA duy nhất `user_totp` với mọi đường đăng nhập
 * khác:
 *
 * - (d) Tài khoản có factor TOTP đã xác nhận: callback khớp tài
 *   khoản xong vẫn KHÔNG tạo phiên, KHÔNG sinh mã bàn giao — trình
 *   duyệt bị đưa về trang đăng nhập mang challenge MFA
 *   (`/login?mfaChallenge=`). Mã sai bị từ chối
 *   (`auth.mfa_invalid_code`); mã đúng qua
 *   `POST /auth/oauth/mfa/verify` mới sinh phiên (cookie
 *   `lms_session`) và mã bàn giao; mã bàn giao đổi được cặp token
 *   dùng thật và chỉ dùng được một lần.
 * - (d2) Lớp gác thứ hai tại điểm đổi bàn giao: một mã bàn giao ở
 *   định dạng cũ (giá trị là userId thuần, không có dấu đã-qua-MFA)
 *   của tài khoản đang bật MFA bị từ chối
 *   (`auth.oauth_mfa_required`) — điểm đổi là cổng cuối, không
 *   đường vòng nào qua được.
 * - (e) Hồi quy: tài khoản chưa bật MFA đi trọn luồng như cũ
 *   (callback → bàn giao → token).
 *
 * Provider được giả lập tại biên HTTP như spec OAuth hệ cũ; mọi
 * bước bên trong (authorize, callback, khớp tài khoản, challenge,
 * bàn giao, phiên) đều chạy thật.
 */

/** Hồ sơ userinfo giả lập theo authorization code. */
const profilesByCode = new Map<string, Record<string, unknown>>();

/** Máy chủ giả lập provider: POST /token đổi code → access token; GET /userinfo trả hồ sơ của code đó. */
function startMockProvider(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/token') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const code = new URLSearchParams(body).get('code') ?? '';
        if (!profilesByCode.has(code)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: `at:${code}`, token_type: 'Bearer', expires_in: 3600 }));
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/userinfo') {
      const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
      const token = bearer || url.searchParams.get('access_token') || '';
      const profile = profilesByCode.get(token.replace(/^at:/, ''));
      if (!profile) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(profile));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Mã TOTP hiện tại cho secret (cùng thư viện otplib với server). */
async function currentTotpCode(secret: string): Promise<string> {
  return generate({ secret });
}

/** Một mã 6 số chắc chắn không khớp cửa sổ kiểm chứng của secret. */
async function wrongTotpCode(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const valid = new Set<string>();
  for (const delta of [-30, 0, 30]) valid.add(await generate({ secret, epoch: now + delta }));
  for (const candidate of ['000000', '111111', '222222', '333333']) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('no wrong-code candidate available');
}

/** Bật MFA cho user qua API hệ cũ, trả secret để sinh mã trong test. */
async function enableMfaViaApi(app: INestApplication, accessToken: string): Promise<string> {
  const setup = await http(app).post('/api/v1/auth/mfa/totp/setup').set('Authorization', `Bearer ${accessToken}`);
  expect(setup.status).toBe(201);
  const secret = setup.body.secret as string;
  const confirm = await http(app).post('/api/v1/auth/mfa/totp/confirm')
    .set('Authorization', `Bearer ${accessToken}`).send({ code: await currentTotpCode(secret) });
  expect(confirm.status).toBe(201);
  return secret;
}

describe('OAuth hệ cũ: cổng MFA tại callback và điểm đổi bàn giao', () => {
  let app: INestApplication;
  let admin: string;
  let provider: Server;
  let store: SessionCacheService;

  beforeAll(async () => {
    const mock = await startMockProvider();
    provider = mock.server;
    const envKey = (...parts: string[]): string => parts.join('_');
    process.env.OAUTH_GOOGLE_CLIENT_ID = 'test-google-client-id';
    process.env[envKey('OAUTH', 'GOOGLE', 'CLIENT', 'SECRET')] = 'test-google-client-secret';
    process.env.OAUTH_FACEBOOK_CLIENT_ID = 'test-facebook-client-id';
    process.env[envKey('OAUTH', 'FACEBOOK', 'CLIENT', 'SECRET')] = 'test-facebook-client-secret';
    for (const prefix of ['OAUTH_GOOGLE', 'OAUTH_FACEBOOK']) {
      process.env[`${prefix}_AUTHORIZE_URL`] = `${mock.baseUrl}/authorize`;
      process.env[`${prefix}_TOKEN_URL`] = `${mock.baseUrl}/token`;
      process.env[`${prefix}_USERINFO_URL`] = `${mock.baseUrl}/userinfo`;
    }
    app = await createTestApp();
    admin = await adminToken(app);
    const { SessionCacheService: StoreClass } = await import('../../../src/infra/cache/session-cache.service');
    store = app.get(StoreClass);
  });

  afterAll(async () => {
    await app.close();
    provider.close();
  });

  /** Chạy trọn luồng authorize → callback cho một code đã đăng ký hồ sơ; trả đáp ứng callback thô. */
  async function runCallback(code: string) {
    const authorizeRes = await http(app).get('/api/v1/auth/oauth/google/authorize');
    expect(authorizeRes.status).toBe(200);
    const authorizeUrl = new URL(authorizeRes.body.authorizeUrl as string);
    const state = authorizeUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    return http(app).get(`/api/v1/auth/oauth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`);
  }

  it('(d) callback bị gác: không phiên, không bàn giao; verify sai bị từ chối, verify đúng mới sinh bàn giao dùng được một lần', async () => {
    const user = await createUserViaApi(app, admin);
    const session = await login(app, user.username, STRONG_PASSWORD);
    const secret = await enableMfaViaApi(app, session.accessToken);
    profilesByCode.set('google-mfa-gate', {
      sub: `g-${uniqueName('sub')}`, email: user.email, email_verified: true, given_name: 'Mfa', family_name: 'Gate',
    });

    const callback = await runCallback('google-mfa-gate');
    expect(callback.status).toBe(302);
    const location = callback.headers.location as string;
    // Bị gác: về trang đăng nhập mang challenge, KHÔNG có handoff.
    expect(location).toContain('/login?mfaChallenge=');
    expect(location).not.toContain('handoff=');
    // Không cookie phiên nào được đặt ở callback bị gác.
    const cookies = ((callback.headers['set-cookie'] as unknown as string[] | undefined) ?? []).join(';');
    expect(cookies).not.toContain('lms_session=');
    const challengeToken = new URL(location, 'http://localhost').searchParams.get('mfaChallenge');
    expect(challengeToken).toBeTruthy();

    // Mã sai bị từ chối, chưa có gì được cấp.
    const wrong = await http(app).post('/api/v1/auth/oauth/mfa/verify')
      .send({ challengeToken, code: await wrongTotpCode(secret) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('auth.mfa_invalid_code');

    // Mã đúng: phiên (cookie) + mã bàn giao.
    const ok = await http(app).post('/api/v1/auth/oauth/mfa/verify')
      .send({ challengeToken, code: await currentTotpCode(secret) });
    expect(ok.status).toBe(201);
    expect(ok.body.user.id).toBe(user.id);
    expect(ok.body.handoffCode).toBeTruthy();
    const okCookies = ((ok.headers['set-cookie'] as unknown as string[] | undefined) ?? []).join(';');
    expect(okCookies).toContain('lms_session=');

    // Bàn giao đổi được cặp token dùng thật, và chỉ một lần.
    const exchanged = await http(app).post('/api/v1/auth/oauth/handoff').send({ code: ok.body.handoffCode });
    expect(exchanged.status).toBe(201);
    expect(exchanged.body.accessToken).toBeTruthy();
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${exchanged.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);
    const replay = await http(app).post('/api/v1/auth/oauth/handoff').send({ code: ok.body.handoffCode });
    expect(replay.status).toBe(401);
  });

  it('(d2) lớp hai tại điểm đổi: mã bàn giao định dạng cũ (userId thuần) của tài khoản đang bật MFA bị từ chối', async () => {
    const user = await createUserViaApi(app, admin);
    const session = await login(app, user.username, STRONG_PASSWORD);
    await enableMfaViaApi(app, session.accessToken);
    // Chế tạo thẳng một mã bàn giao ở định dạng TRƯỚC khi có cổng
    // (giá trị lưu là userId thuần) — như một mã lọt ra từ đường cấp
    // nào chưa qua cổng: điểm đổi phải tự gác.
    const legacyCode = `legacy-${uniqueName('handoff')}`;
    await store.set(`oauthhandoff:${legacyCode}`, user.id, 120_000);
    const res = await http(app).post('/api/v1/auth/oauth/handoff').send({ code: legacyCode });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('auth.oauth_mfa_required');
  });

  it('(e) hồi quy: tài khoản chưa bật MFA đi trọn luồng callback → bàn giao → token như cũ', async () => {
    const user = await createUserViaApi(app, admin);
    profilesByCode.set('google-mfa-plain', {
      sub: `g-${uniqueName('sub')}`, email: user.email, email_verified: true, given_name: 'Plain', family_name: 'Flow',
    });
    const callback = await runCallback('google-mfa-plain');
    expect(callback.status).toBe(302);
    const location = callback.headers.location as string;
    expect(location).toContain('/oauth/callback?handoff=');
    expect(location).not.toContain('mfaChallenge');
    const handoff = new URL(location, 'http://localhost').searchParams.get('handoff');
    const exchanged = await http(app).post('/api/v1/auth/oauth/handoff').send({ code: handoff });
    expect(exchanged.status).toBe(201);
    expect(exchanged.body.user.id).toBe(user.id);
    expect(exchanged.body.accessToken).toBeTruthy();
  });
});
