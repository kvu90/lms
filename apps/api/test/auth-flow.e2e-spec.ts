import { INestApplication } from '@nestjs/common';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * Auth flow tests.
 * Oracle: lib/tests/authlib_test.php (MOODLE_503_STABLE) — test_lockout,
 * test_authenticate_user_login; refresh rotation + reuse detection per
 * report §3.7 (self-built, OAuth security best practice).
 * MFA TOTP oracle: blueprint §2#3 (MFA hook) + Moodle tool_mfa factor_totp
 * semantics — password alone is not enough once a TOTP factor is confirmed.
 */

/** Mã TOTP hiện tại cho secret, sinh bằng chính thư viện otplib đã cài. */
async function currentTotpCode(secret: string): Promise<string> {
  return generate({ secret });
}

/** Một mã 6 số chắc chắn KHÔNG khớp cửa sổ kiểm chứng (±1 bước) của secret. */
async function wrongTotpCode(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const valid = new Set<string>();
  for (const delta of [-30, 0, 30]) valid.add(await generate({ secret, epoch: now + delta }));
  for (const candidate of ['000000', '111111', '222222', '333333']) {
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('no wrong-code candidate available');
}

/** Setup + confirm MFA cho một user qua API, trả secret để sinh mã trong test. */
async function enableMfaViaApi(app: INestApplication, accessToken: string): Promise<string> {
  const setup = await http(app).post('/api/v1/auth/mfa/totp/setup').set('Authorization', `Bearer ${accessToken}`);
  expect(setup.status).toBe(201);
  const secret = setup.body.secret as string;
  const confirm = await http(app).post('/api/v1/auth/mfa/totp/confirm')
    .set('Authorization', `Bearer ${accessToken}`).send({ code: await currentTotpCode(secret) });
  expect(confirm.status).toBe(201);
  expect(confirm.body.mfaEnabled).toBe(true);
  return secret;
}
describe('Auth: login, lockout, refresh rotation, sessions, login-as', () => {
  let app: INestApplication;
  let admin: string;
  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('logs in with correct credentials (token endpoint and passport-local endpoint) and loads the profile', async () => {
    const user = await createUserViaApi(app, admin);
    const viaToken = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(viaToken.status).toBe(201);
    expect(viaToken.body.accessToken).toBeTruthy();
    expect(viaToken.body.refreshToken).toBeTruthy();
    const viaLocal = await http(app).post('/api/v1/auth/login').send({ username: user.username, password: STRONG_PASSWORD });
    expect(viaLocal.status).toBe(201);
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${viaToken.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(user.username);
    expect(me.body.email).toBe(user.email); // own profile always shows own identity fields
  });

  it('rejects a wrong password with 401 Problem Details', async () => {
    const user = await createUserViaApi(app, admin);
    const res = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: 'WrongPass1' });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('auth.invalid_credentials');
  });

  it('locks the account out after the configured number of failed attempts (authlib test_lockout)', async () => {
    const user = await createUserViaApi(app, admin);
    for (let i = 0; i < 5; i++) {
      const res = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: 'WrongPass1' });
      expect(res.status).toBe(401);
    }
    const locked = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('auth.locked_out');
  });

  it('rotates refresh tokens and revokes the whole family on reuse of a rotated-out token', async () => {
    const user = await createUserViaApi(app, admin);
    const first = await login(app, user.username, STRONG_PASSWORD);
    const rotated = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(rotated.status).toBe(201);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);
    // Reuse of the rotated-out token = theft signal ⇒ family revoked.
    const reuse = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('auth.refresh_reuse_detected');
    const afterRevoke = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(afterRevoke.status).toBe(401);
  });

  it('refuses login for suspended users and kills their existing access tokens', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const loginRes = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.code).toBe('auth.account_suspended');
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
  });

  it('enforces the force-password-change flow on first login', async () => {
    const user = await createUserViaApi(app, admin, { forcePasswordChange: true });
    const first = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(first.body.user.forcePasswordChange).toBe(true);
    const change = await http(app).post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${first.body.accessToken}`)
      .send({ currentPassword: STRONG_PASSWORD, newPassword: 'NewPassw0rd!' });
    expect(change.status).toBe(201);
    const second = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: 'NewPassw0rd!' });
    expect(second.status).toBe(201);
    expect(second.body.user.forcePasswordChange).toBe(false);
    // weak new password is rejected by the configured policy
    const weak = await http(app).post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .send({ currentPassword: 'NewPassw0rd!', newPassword: 'weak' });
    expect(weak.status).toBe(400);
  });

  it('web session: login rotates the session id, suspend invalidates the session', async () => {
    const user = await createUserViaApi(app, admin);
    const first = await http(app).post('/api/v1/auth/session/login').send({ username: user.username, password: STRONG_PASSWORD });
    expect(first.status).toBe(201);
    const sid1 = first.body.sessionId as string;
    const me1 = await http(app).get('/api/v1/auth/session/me').set('x-session-id', sid1);
    expect(me1.status).toBe(200);
    // Second login carrying the old id must rotate it (fixation protection).
    const second = await http(app).post('/api/v1/auth/session/login')
      .set('Cookie', `lms_session=${sid1}`).send({ username: user.username, password: STRONG_PASSWORD });
    const sid2 = second.body.sessionId as string;
    expect(sid2).not.toBe(sid1);
    const oldMe = await http(app).get('/api/v1/auth/session/me').set('x-session-id', sid1);
    expect(oldMe.status).toBe(401);
    // Suspension kills the live session.
    await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const suspendedMe = await http(app).get('/api/v1/auth/session/me').set('x-session-id', sid2);
    expect(suspendedMe.status).toBe(401);
  });

  it('login-as: an admin with user:loginas can act as another user; a normal user cannot', async () => {
    const target = await createUserViaApi(app, admin);
    const as = await http(app).post('/api/v1/auth/login-as').set('Authorization', `Bearer ${admin}`).send({ userId: target.id, reason: 'Hỗ trợ kỹ thuật (spec)' });
    expect(as.status).toBe(201);
    expect(as.body.loginAs.byUserId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${as.body.accessToken}`);
    expect(me.body.id).toBe(target.id);
    const plain = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, plain.username, STRONG_PASSWORD);
    const denied = await http(app).post('/api/v1/auth/login-as').set('Authorization', `Bearer ${accessToken}`).send({ userId: target.id, reason: 'thử' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');
  });

  it('login-as: thiếu lý do bị chặn (TENANT-1 #196 — platform vào tenant phải có lý do + audit)', async () => {
    const target = await createUserViaApi(app, admin);
    const noReason = await http(app).post('/api/v1/auth/login-as').set('Authorization', `Bearer ${admin}`).send({ userId: target.id });
    expect(noReason.status).toBe(400);
    const blankReason = await http(app).post('/api/v1/auth/login-as').set('Authorization', `Bearer ${admin}`).send({ userId: target.id, reason: '   ' });
    expect(blankReason.status).toBe(400);
  });

  it('authentication alone grants no admin capability (auth ≠ role assignment)', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${accessToken}`)
      .send({ username: 'nope', email: 'nope@example.com', password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('MFA TOTP: setup → confirm → login stops at MFA → verify admits; disable returns to direct login (tool_mfa factor_totp)', async () => {
    const user = await createUserViaApi(app, admin);
    // Chưa bật MFA: đăng nhập thẳng như cũ, và trạng thái MFA báo chưa bật.
    const plain = await login(app, user.username, STRONG_PASSWORD);
    const statusOff = await http(app).get('/api/v1/auth/mfa/status').set('Authorization', `Bearer ${plain.accessToken}`);
    expect(statusOff.status).toBe(200);
    expect(statusOff.body).toEqual({ enabled: false });

    // Setup: secret + otpauth URL chỉ lộ ở bước này.
    const setup = await http(app).post('/api/v1/auth/mfa/totp/setup').set('Authorization', `Bearer ${plain.accessToken}`);
    expect(setup.status).toBe(201);
    const secret = setup.body.secret as string;
    expect(secret).toBeTruthy();
    expect(setup.body.otpauthUrl).toContain('otpauth://totp/');
    expect(setup.body.otpauthUrl).toContain(secret);

    // Confirm sai mã bị từ chối; đúng mã mới kích hoạt.
    const badConfirm = await http(app).post('/api/v1/auth/mfa/totp/confirm')
      .set('Authorization', `Bearer ${plain.accessToken}`).send({ code: await wrongTotpCode(secret) });
    expect(badConfirm.status).toBe(401);
    expect(badConfirm.body.code).toBe('auth.mfa_invalid_code');
    // Setup chưa confirm thì trạng thái vẫn là chưa bật.
    const statusPending = await http(app).get('/api/v1/auth/mfa/status').set('Authorization', `Bearer ${plain.accessToken}`);
    expect(statusPending.body).toEqual({ enabled: false });
    const confirm = await http(app).post('/api/v1/auth/mfa/totp/confirm')
      .set('Authorization', `Bearer ${plain.accessToken}`).send({ code: await currentTotpCode(secret) });
    expect(confirm.status).toBe(201);
    expect(confirm.body.mfaEnabled).toBe(true);
    const statusOn = await http(app).get('/api/v1/auth/mfa/status').set('Authorization', `Bearer ${plain.accessToken}`);
    expect(statusOn.body).toEqual({ enabled: true });

    // Đăng nhập đúng mật khẩu nhưng bị chặn ở bước MFA: không có cặp token.
    const blocked = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(blocked.status).toBe(201);
    expect(blocked.body.mfaRequired).toBe(true);
    expect(blocked.body.accessToken).toBeUndefined();
    expect(blocked.body.refreshToken).toBeUndefined();
    const challengeToken = blocked.body.challengeToken as string;
    expect(challengeToken).toBeTruthy();

    // Challenge token KHÔNG dùng gọi API thường được.
    const meWithChallenge = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${challengeToken}`);
    expect([401, 403]).toContain(meWithChallenge.status);

    // Verify sai mã → 401; verify đúng mã → cặp token như đăng nhập thường.
    const badVerify = await http(app).post('/api/v1/auth/mfa/verify')
      .send({ challengeToken, code: await wrongTotpCode(secret) });
    expect(badVerify.status).toBe(401);
    expect(badVerify.body.code).toBe('auth.mfa_invalid_code');
    const verified = await http(app).post('/api/v1/auth/mfa/verify')
      .send({ challengeToken, code: await currentTotpCode(secret) });
    expect(verified.status).toBe(201);
    expect(verified.body.accessToken).toBeTruthy();
    expect(verified.body.refreshToken).toBeTruthy();
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${verified.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.id).toBe(user.id);

    // Disable bằng mã đúng ⇒ đăng nhập thẳng trở lại.
    const disable = await http(app).post('/api/v1/auth/mfa/totp/disable')
      .set('Authorization', `Bearer ${verified.body.accessToken}`).send({ code: await currentTotpCode(secret) });
    expect(disable.status).toBe(201);
    expect(disable.body.mfaEnabled).toBe(false);
    const statusAfterDisable = await http(app).get('/api/v1/auth/mfa/status').set('Authorization', `Bearer ${verified.body.accessToken}`);
    expect(statusAfterDisable.body).toEqual({ enabled: false });
    const direct = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(direct.status).toBe(201);
    expect(direct.body.mfaRequired).toBeUndefined();
    expect(direct.body.accessToken).toBeTruthy();
  });

  it('MFA TOTP: admin reset (user:update capability) gỡ MFA cho user mất authenticator; user thường bị từ chối', async () => {
    const user = await createUserViaApi(app, admin);
    const plain = await login(app, user.username, STRONG_PASSWORD);
    await enableMfaViaApi(app, plain.accessToken);

    // User thường không có capability quản trị ⇒ không reset được MFA của người khác.
    const other = await createUserViaApi(app, admin);
    const otherLogin = await login(app, other.username, STRONG_PASSWORD);
    const denied = await http(app).post(`/api/v1/auth/mfa/users/${user.id}/reset`)
      .set('Authorization', `Bearer ${otherLogin.accessToken}`);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');

    // Admin reset ⇒ user đăng nhập thẳng, không bị hỏi MFA nữa.
    const reset = await http(app).post(`/api/v1/auth/mfa/users/${user.id}/reset`).set('Authorization', `Bearer ${admin}`);
    expect(reset.status).toBe(201);
    expect(reset.body.reset).toBe(true);
    const direct = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(direct.status).toBe(201);
    expect(direct.body.mfaRequired).toBeUndefined();
    expect(direct.body.accessToken).toBeTruthy();
  });
});
