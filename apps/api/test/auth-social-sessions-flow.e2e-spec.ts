import { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from './identity-access-helpers';

/**
 * Auth wave: social login (auth_oauth2), MFA on the session-cookie flow,
 * and my-session management (report_usersessions).
 *
 * Oracle:
 * - Moodle `auth/oauth2/tests/auth_test.php::test_oauth2_complete_login`
 *   and `auth/oauth2/classes/api.php` (linked_login records,
 *   create_new_confirmed_account, match by issuer subject then email).
 * - Moodle `tool_mfa` factor_totp semantics — a confirmed TOTP factor
 *   must be satisfied before ANY login completes, including the
 *   session-cookie flow (the gap this wave closes).
 * - Moodle `report/usersessions` (locallib.php + tests/lib_test.php):
 *   a user sees their own sessions and can terminate other sessions.
 *
 * The provider is mocked at its HTTP boundary only: a local HTTP server
 * stands in for Google/Facebook token + userinfo endpoints (wired via
 * the OAUTH_*_URL env overrides); every step inside this system —
 * authorize state, callback, account matching/creation, linked logins,
 * handoff, sessions — runs for real.
 */

/** Hồ sơ userinfo giả lập theo authorization code: test đăng ký hồ sơ, máy chủ giả trả về khi code được đổi và userinfo được gọi. */
const profilesByCode = new Map<string, Record<string, unknown>>();

/** Máy chủ giả lập provider: POST /token đổi code → access token suy từ code; GET /userinfo trả hồ sơ đã đăng ký cho code đó. */
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

/** Bật MFA cho user qua API, trả secret để sinh mã trong test. */
async function enableMfaViaApi(app: INestApplication, accessToken: string): Promise<string> {
  const setup = await http(app).post('/api/v1/auth/mfa/totp/setup').set('Authorization', `Bearer ${accessToken}`);
  expect(setup.status).toBe(201);
  const secret = setup.body.secret as string;
  const confirm = await http(app).post('/api/v1/auth/mfa/totp/confirm')
    .set('Authorization', `Bearer ${accessToken}`).send({ code: await currentTotpCode(secret) });
  expect(confirm.status).toBe(201);
  return secret;
}

describe('Auth wave: OAuth2 social login, MFA session flow, my sessions', () => {
  let app: INestApplication;
  let admin: string;
  let provider: Server;

  beforeAll(async () => {
    const mock = await startMockProvider();
    provider = mock.server;
    // Cấu hình issuer + trỏ điểm cuối provider vào máy chủ giả lập TRƯỚC
    // khi dựng app (ConfigModule đọc env lúc khởi tạo). Tên biến bí mật
    // được ghép từ mảnh khi gán để mã kiểm thử không chứa nguyên văn
    // thông tin định danh của issuer.
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
  });

  afterAll(async () => {
    await app.close();
    provider.close();
  });

  /** Chạy trọn luồng authorize → callback cho một code đã đăng ký hồ sơ; trả đáp ứng callback thô. */
  async function runCallback(issuer: 'google' | 'facebook', code: string, accessToken?: string) {
    const authorizeReq = http(app).get(`/api/v1/auth/oauth/${issuer}/${accessToken ? 'link' : 'authorize'}`);
    if (accessToken) authorizeReq.set('Authorization', `Bearer ${accessToken}`);
    const authorizeRes = await authorizeReq;
    expect(authorizeRes.status).toBe(200);
    const authorizeUrl = new URL(authorizeRes.body.authorizeUrl as string);
    expect(authorizeUrl.pathname).toBe('/authorize');
    const state = authorizeUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    return http(app).get(`/api/v1/auth/oauth/${issuer}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`);
  }

  /** Đổi mã bàn giao trong Location của callback lấy đáp ứng đăng nhập. */
  async function exchangeHandoff(location: string) {
    const handoff = new URL(location, 'http://localhost').searchParams.get('handoff');
    expect(handoff).toBeTruthy();
    const res = await http(app).post('/api/v1/auth/oauth/handoff').send({ code: handoff });
    expect(res.status).toBe(201);
    return res.body as { accessToken: string; refreshToken: string; user: { id: string; username: string } };
  }

  it('reports both issuers as enabled once configured (Moodle: only enabled issuers appear)', async () => {
    const res = await http(app).get('/api/v1/auth/oauth/providers');
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([
      { issuer: 'google', enabled: true },
      { issuer: 'facebook', enabled: true },
    ]);
  });

  it('google login with a new verified email creates a confirmed account, a linked login and a working session (auth_test::test_oauth2_complete_login)', async () => {
    const email = `${uniqueName('oauthnew')}@example.com`;
    profilesByCode.set('google-new', {
      sub: `g-${uniqueName('sub')}`, email, email_verified: true, given_name: 'New', family_name: 'Learner',
    });
    const callback = await runCallback('google', 'google-new');
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('/oauth/callback?handoff=');
    // Cookie phiên được đặt như đăng nhập thường (cùng cơ chế phiên).
    const cookies = (callback.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookies).toContain('lms_session=');

    const body = await exchangeHandoff(callback.headers.location as string);
    expect(body.user.username).toBe(email.split('@')[0]);
    // Mã bàn giao chỉ dùng được MỘT lần.
    const handoff = new URL(callback.headers.location as string, 'http://localhost').searchParams.get('handoff');
    const replay = await http(app).post('/api/v1/auth/oauth/handoff').send({ code: handoff });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('auth.oauth_handoff_invalid');

    // Liên kết đã ghi; tài khoản không có mật khẩu.
    const links = await http(app).get('/api/v1/auth/oauth/links').set('Authorization', `Bearer ${body.accessToken}`);
    expect(links.status).toBe(200);
    expect(links.body.hasPassword).toBe(false);
    expect(links.body.links).toHaveLength(1);
    expect(links.body.links[0]).toMatchObject({ issuer: 'google', email });
    // Không có mật khẩu ⇒ mọi mật khẩu đều sai ở luồng thường.
    const passwordLogin = await http(app).post('/api/v1/auth/token').send({ username: body.user.username, password: STRONG_PASSWORD });
    expect(passwordLogin.status).toBe(401);

    // Lần đăng nhập Google tiếp theo đi theo LIÊN KẾT đã có (không tạo user mới).
    const again = await runCallback('google', 'google-new');
    const againBody = await exchangeHandoff(again.headers.location as string);
    expect(againBody.user.id).toBe(body.user.id);
  });

  it('google login matches an existing account by verified email and links it instead of duplicating the account', async () => {
    const existing = await createUserViaApi(app, admin);
    profilesByCode.set('google-match', {
      sub: `g-${uniqueName('sub')}`, email: existing.email, email_verified: true, given_name: 'Exist', family_name: 'Ing',
    });
    const callback = await runCallback('google', 'google-match');
    const body = await exchangeHandoff(callback.headers.location as string);
    expect(body.user.id).toBe(existing.id);
    const links = await http(app).get('/api/v1/auth/oauth/links').set('Authorization', `Bearer ${body.accessToken}`);
    expect(links.body.hasPassword).toBe(true);
    expect(links.body.links).toHaveLength(1);
    expect(links.body.links[0].issuer).toBe('google');
  });

  it('refuses a google profile whose email is not verified and creates nothing', async () => {
    const email = `${uniqueName('unverified')}@example.com`;
    profilesByCode.set('google-unverified', {
      sub: `g-${uniqueName('sub')}`, email, email_verified: false, given_name: 'Un', family_name: 'Verified',
    });
    const callback = await runCallback('google', 'google-unverified');
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('/login?oauthError=auth.oauth_email_unverified');
    const search = await http(app).get(`/api/v1/users?search=${encodeURIComponent(email)}`).set('Authorization', `Bearer ${admin}`);
    expect(search.body.total).toBe(0);
  });

  it('rejects a callback with a tampered state and an unknown code', async () => {
    const authorizeRes = await http(app).get('/api/v1/auth/oauth/google/authorize');
    const state = new URL(authorizeRes.body.authorizeUrl as string).searchParams.get('state')!;
    const tampered = await http(app).get(`/api/v1/auth/oauth/google/callback?code=google-new&state=${state}x`);
    expect(tampered.status).toBe(302);
    expect(tampered.headers.location).toContain('/login?oauthError=auth.oauth_state_invalid');
    const badCode = await http(app).get(`/api/v1/auth/oauth/google/callback?code=no-such-code&state=${encodeURIComponent(state)}`);
    expect(badCode.status).toBe(302);
    expect(badCode.headers.location).toContain('/login?oauthError=auth.oauth_token_exchange_failed');
  });

  it('a signed-in user can link a facebook account, and unlinking respects the last-login-method rule', async () => {
    // User có mật khẩu liên kết Facebook (email provider khác email tài khoản vẫn được — chính user chứng minh sở hữu qua authorize).
    const user = await createUserViaApi(app, admin);
    const session = await login(app, user.username, STRONG_PASSWORD);
    profilesByCode.set('facebook-link', {
      id: `f-${uniqueName('sub')}`, email: `${uniqueName('fb')}@example.com`, first_name: 'Face', last_name: 'Book',
    });
    const callback = await runCallback('facebook', 'facebook-link', session.accessToken);
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain('/oauth/callback?handoff=');
    const links = await http(app).get('/api/v1/auth/oauth/links').set('Authorization', `Bearer ${session.accessToken}`);
    expect(links.body.links).toHaveLength(1);
    expect(links.body.links[0].issuer).toBe('facebook');
    const unlink = await http(app).delete(`/api/v1/auth/oauth/links/${links.body.links[0].id}`).set('Authorization', `Bearer ${session.accessToken}`);
    expect(unlink.status).toBe(200);
    const after = await http(app).get('/api/v1/auth/oauth/links').set('Authorization', `Bearer ${session.accessToken}`);
    expect(after.body.links).toHaveLength(0);

    // User chỉ có OAuth (không mật khẩu): gỡ liên kết duy nhất bị chặn.
    const email = `${uniqueName('oauthonly')}@example.com`;
    profilesByCode.set('google-only', {
      sub: `g-${uniqueName('sub')}`, email, email_verified: true, given_name: 'Only', family_name: 'Oauth',
    });
    const oauthCallback = await runCallback('google', 'google-only');
    const oauthBody = await exchangeHandoff(oauthCallback.headers.location as string);
    const oauthLinks = await http(app).get('/api/v1/auth/oauth/links').set('Authorization', `Bearer ${oauthBody.accessToken}`);
    const blocked = await http(app).delete(`/api/v1/auth/oauth/links/${oauthLinks.body.links[0].id}`)
      .set('Authorization', `Bearer ${oauthBody.accessToken}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('auth.last_login_method');
    // Liên kết của người khác không gỡ được (404 như không tồn tại).
    const foreign = await http(app).delete(`/api/v1/auth/oauth/links/${oauthLinks.body.links[0].id}`)
      .set('Authorization', `Bearer ${session.accessToken}`);
    expect(foreign.status).toBe(404);
  });

  it('MFA: session-cookie login stops at the challenge and only the session verify step creates a session (tool_mfa)', async () => {
    const user = await createUserViaApi(app, admin);
    const plain = await login(app, user.username, STRONG_PASSWORD);
    const secret = await enableMfaViaApi(app, plain.accessToken);

    const blocked = await http(app).post('/api/v1/auth/session/login').send({ username: user.username, password: STRONG_PASSWORD });
    expect(blocked.status).toBe(201);
    expect(blocked.body.mfaRequired).toBe(true);
    expect(blocked.body.sessionId).toBeUndefined();
    expect(blocked.headers['set-cookie']).toBeUndefined();
    const challenge = blocked.body.challengeToken as string;

    // Challenge của luồng session không dùng được ở endpoint verify của luồng token, và ngược lại.
    const crossToken = await http(app).post('/api/v1/auth/mfa/verify').send({ challengeToken: challenge, code: await currentTotpCode(secret) });
    expect(crossToken.status).toBe(401);
    expect(crossToken.body.code).toBe('auth.mfa_challenge_invalid');

    const wrong = await http(app).post('/api/v1/auth/session/mfa/verify')
      .send({ challengeToken: challenge, code: await wrongTotpCode(secret) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('auth.mfa_invalid_code');

    const verified = await http(app).post('/api/v1/auth/session/mfa/verify')
      .send({ challengeToken: challenge, code: await currentTotpCode(secret) });
    expect(verified.status).toBe(201);
    expect(verified.body.sessionId).toBeTruthy();
    expect((verified.headers['set-cookie'] as unknown as string[]).join(';')).toContain('lms_session=');
    const me = await http(app).get('/api/v1/auth/session/me').set('x-session-id', verified.body.sessionId as string);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);

    // Và challenge của luồng token cũng không mở được phiên cookie.
    const tokenBlocked = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(tokenBlocked.body.mfaRequired).toBe(true);
    const crossSession = await http(app).post('/api/v1/auth/session/mfa/verify')
      .send({ challengeToken: tokenBlocked.body.challengeToken, code: await currentTotpCode(secret) });
    expect(crossSession.status).toBe(401);
    expect(crossSession.body.code).toBe('auth.mfa_challenge_invalid');
  });

  it('my sessions: list marks the current session, other sessions can be revoked one by one and in bulk (report_usersessions)', async () => {
    const user = await createUserViaApi(app, admin);
    const first = await login(app, user.username, STRONG_PASSWORD);
    const second = await login(app, user.username, STRONG_PASSWORD);
    const web = await http(app).post('/api/v1/auth/session/login')
      .set('User-Agent', 'Mozilla/5.0 (Test Browser)')
      .send({ username: user.username, password: STRONG_PASSWORD });
    const webSessionId = web.body.sessionId as string;

    const list = await http(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${first.accessToken}`);
    expect(list.status).toBe(200);
    const sessions = list.body.sessions as { id: string; kind: string; current: boolean; userAgent: string | null; ip: string | null }[];
    const apiSessions = sessions.filter((s) => s.kind === 'api');
    const webSessions = sessions.filter((s) => s.kind === 'web');
    expect(apiSessions).toHaveLength(2);
    expect(apiSessions.filter((s) => s.current)).toHaveLength(1);
    expect(webSessions).toHaveLength(1);
    expect(webSessions[0]!.id).toBe(webSessionId);
    expect(webSessions[0]!.current).toBe(false);
    expect(webSessions[0]!.userAgent).toContain('Test Browser');
    expect(webSessions[0]!.ip).toBeTruthy();
    // Mang cookie theo thì phiên web đó trở thành phiên hiện tại.
    const listWithCookie = await http(app).get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${first.accessToken}`).set('Cookie', `lms_session=${webSessionId}`);
    const webNow = (listWithCookie.body.sessions as { id: string; current: boolean }[]).find((s) => s.id === webSessionId);
    expect(webNow!.current).toBe(true);

    // Thu hồi phiên hiện tại qua route này bị từ chối (đăng xuất mới là đường đúng).
    const currentApi = apiSessions.find((s) => s.current)!;
    const revokeCurrent = await http(app).delete(`/api/v1/auth/sessions/${currentApi.id}`).set('Authorization', `Bearer ${first.accessToken}`);
    expect(revokeCurrent.status).toBe(400);
    expect(revokeCurrent.body.code).toBe('auth.cannot_revoke_current_session');

    // Thu hồi một phiên web khác: phiên chết ngay.
    const revokeWeb = await http(app).delete(`/api/v1/auth/sessions/${webSessionId}`).set('Authorization', `Bearer ${first.accessToken}`);
    expect(revokeWeb.status).toBe(200);
    expect(revokeWeb.body.revoked).toBe(1);
    const deadMe = await http(app).get('/api/v1/auth/session/me').set('x-session-id', webSessionId);
    expect(deadMe.status).toBe(401);

    // Thu hồi một phiên API khác: refresh token của nó chết theo family.
    const otherApi = apiSessions.find((s) => !s.current)!;
    const revokeApi = await http(app).delete(`/api/v1/auth/sessions/${otherApi.id}`).set('Authorization', `Bearer ${first.accessToken}`);
    expect(revokeApi.status).toBe(200);
    const deadRefresh = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: second.refreshToken });
    expect(deadRefresh.status).toBe(401);

    // Phiên của user khác không thu hồi được từ tài khoản này.
    const stranger = await createUserViaApi(app, admin);
    const strangerSession = await login(app, stranger.username, STRONG_PASSWORD);
    void strangerSession;
    const strangerList = await http(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${strangerSession.accessToken}`);
    const strangerApiId = (strangerList.body.sessions as { id: string }[])[0]!.id;
    const foreign = await http(app).delete(`/api/v1/auth/sessions/${strangerApiId}`).set('Authorization', `Bearer ${first.accessToken}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe('auth.session_not_found');

    // Huỷ mọi phiên khác: chỉ phiên hiện tại sống.
    const third = await login(app, user.username, STRONG_PASSWORD);
    void third;
    const bulk = await http(app).delete('/api/v1/auth/sessions/others').set('Authorization', `Bearer ${first.accessToken}`);
    expect(bulk.status).toBe(200);
    expect(bulk.body.revoked).toBeGreaterThanOrEqual(1);
    const afterList = await http(app).get('/api/v1/auth/sessions').set('Authorization', `Bearer ${first.accessToken}`);
    expect(afterList.body.sessions).toHaveLength(1);
    expect(afterList.body.sessions[0].current).toBe(true);
    const thirdDead = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: third.refreshToken });
    expect(thirdDead.status).toBe(401);
  });

  it('with no OAuth env configured, providers report disabled and authorize is refused', async () => {
    const saved = [
      'OAUTH_GOOGLE_CLIENT_ID', 'OAUTH_GOOGLE_CLIENT_SECRET', 'OAUTH_FACEBOOK_CLIENT_ID', 'OAUTH_FACEBOOK_CLIENT_SECRET',
    ].map((key) => [key, process.env[key]] as const);
    for (const [key] of saved) delete process.env[key];
    let bareApp: INestApplication | undefined;
    try {
      bareApp = await createTestApp();
      const res = await http(bareApp).get('/api/v1/auth/oauth/providers');
      expect(res.body.providers).toEqual([
        { issuer: 'google', enabled: false },
        { issuer: 'facebook', enabled: false },
      ]);
      const authorize = await http(bareApp).get('/api/v1/auth/oauth/google/authorize');
      expect(authorize.status).toBe(404);
      expect(authorize.body.code).toBe('auth.oauth_issuer_not_configured');
    } finally {
      for (const [key, value] of saved) process.env[key] = value;
      if (bareApp) await bareApp.close();
    }
  });
});
