import { INestApplication } from '@nestjs/common';
import { generate } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';

/**
 * Kiểm thử luồng Auth.
 * Oracle: lib/tests/authlib_test.php (MOODLE_503_STABLE) — test_lockout,
 * test_authenticate_user_login; xoay refresh + phát hiện tái sử dụng theo
 * báo cáo §3.7 (tự xây dựng, thực hành bảo mật OAuth tốt nhất).
 * Oracle MFA TOTP: blueprint §2#3 (MFA hook) + ngữ nghĩa factor_totp của Moodle tool_mfa
 *  — chỉ mật khẩu là chưa đủ khi một nhân tố TOTP đã được xác nhận.
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
describe('Xác thực: đăng nhập, khoá tài khoản, xoay refresh, phiên, login-as', () => {
  let app: INestApplication;
  let admin: string;
  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('đăng nhập bằng thông tin đúng (endpoint token và endpoint passport-local) và tải hồ sơ', async () => {
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
    expect(me.body.email).toBe(user.email); // hồ sơ của chính mình luôn hiển thị các trường định danh của chính mình
  });

  it('từ chối mật khẩu sai bằng 401 Problem Details', async () => {
    const user = await createUserViaApi(app, admin);
    const res = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: 'WrongPass1' });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body.code).toBe('auth.invalid_credentials');
  });

  it('khoá tài khoản sau số lần thất bại đã cấu hình (authlib test_lockout)', async () => {
    const user = await createUserViaApi(app, admin);
    for (let i = 0; i < 5; i++) {
      const res = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: 'WrongPass1' });
      expect(res.status).toBe(401);
    }
    const locked = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(locked.status).toBe(401);
    expect(locked.body.code).toBe('auth.locked_out');
  });

  it('xoay refresh token và thu hồi cả họ khi token đã xoay bị dùng lại', async () => {
    const user = await createUserViaApi(app, admin);
    const first = await login(app, user.username, STRONG_PASSWORD);
    const rotated = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(rotated.status).toBe(201);
    expect(rotated.body.refreshToken).not.toBe(first.refreshToken);
    // Tái sử dụng token đã bị xoay ra = tín hiệu bị đánh cắp ⇒ họ (family) bị thu hồi.
    const reuse = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('auth.refresh_reuse_detected');
    const afterRevoke = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(afterRevoke.status).toBe(401);
  });

  it('từ chối đăng nhập cho người bị đình chỉ và huỷ token truy cập sẵn có của họ', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const loginRes = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(loginRes.status).toBe(403);
    expect(loginRes.body.code).toBe('auth.account_suspended');
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
  });

  it('áp đặt luồng bắt đổi mật khẩu ở lần đăng nhập đầu tiên', async () => {
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
    // mật khẩu mới yếu bị chính sách đã cấu hình từ chối
    const weak = await http(app).post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${second.body.accessToken}`)
      .send({ currentPassword: 'NewPassw0rd!', newPassword: 'weak' });
    expect(weak.status).toBe(400);
  });

  it('phiên web: đăng nhập xoay session id, đình chỉ vô hiệu phiên', async () => {
    const user = await createUserViaApi(app, admin);
    const first = await http(app).post('/api/v1/auth/session/login').send({ username: user.username, password: STRONG_PASSWORD });
    expect(first.status).toBe(201);
    const sid1 = first.body.sessionId as string;
    const me1 = await http(app).get('/api/v1/auth/session/me').set('x-session-id', sid1);
    expect(me1.status).toBe(200);
    // Lần đăng nhập thứ hai mang id cũ phải xoay nó (bảo vệ chống fixation).
    const second = await http(app).post('/api/v1/auth/session/login')
      .set('Cookie', `lms_session=${sid1}`).send({ username: user.username, password: STRONG_PASSWORD });
    const sid2 = second.body.sessionId as string;
    expect(sid2).not.toBe(sid1);
    const oldMe = await http(app).get('/api/v1/auth/session/me').set('x-session-id', sid1);
    expect(oldMe.status).toBe(401);
    // Đình chỉ huỷ phiên đang sống.
    await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const suspendedMe = await http(app).get('/api/v1/auth/session/me').set('x-session-id', sid2);
    expect(suspendedMe.status).toBe(401);
  });

  it('login-as: admin có user:loginas có thể hành động thay người khác; người thường không thể', async () => {
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

  it('chỉ xác thực không cấp năng lực admin nào (auth ≠ gán vai trò)', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${accessToken}`)
      .send({ username: 'nope', email: 'nope@example.com', password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('MFA TOTP: thiết lập → xác nhận → đăng nhập dừng ở MFA → verify cho vào; tắt về lại đăng nhập trực tiếp (tool_mfa factor_totp)', async () => {
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

  it('MFA TOTP: thiết lập lại khi đang bật cần mã hiện tại; lần thử bị từ chối giữ nguyên factor đang hoạt động', async () => {
    const user = await createUserViaApi(app, admin);
    const plain = await login(app, user.username, STRONG_PASSWORD);
    const activeSecret = await enableMfaViaApi(app, plain.accessToken);
    const auth = { Authorization: `Bearer ${plain.accessToken}` };

    // Setup lại không kèm mã hiện tại ⇒ 401 tái xác thực; MFA vẫn bật nguyên.
    const noCode = await http(app).post('/api/v1/auth/mfa/totp/setup').set(auth);
    expect(noCode.status).toBe(401);
    expect(noCode.body.code).toBe('auth.mfa_reauth_required');
    const statusAfterNoCode = await http(app).get('/api/v1/auth/mfa/status').set(auth);
    expect(statusAfterNoCode.body).toEqual({ enabled: true });

    // Setup lại với mã hiện tại sai ⇒ 401 mã không hợp lệ; MFA vẫn bật nguyên,
    // và đăng nhập vẫn bị chặn ở bước MFA với authenticator hiện tại.
    const wrong = await http(app).post('/api/v1/auth/mfa/totp/setup').set(auth)
      .send({ currentCode: await wrongTotpCode(activeSecret) });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('auth.mfa_invalid_code');
    const stillBlocked = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(stillBlocked.body.mfaRequired).toBe(true);
    const verifiedOld = await http(app).post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: stillBlocked.body.challengeToken, code: await currentTotpCode(activeSecret) });
    expect(verifiedOld.status).toBe(201);

    // Setup lại với mã hiện tại đúng ⇒ secret mới ở trạng thái chờ xác nhận.
    const replaced = await http(app).post('/api/v1/auth/mfa/totp/setup').set(auth)
      .send({ currentCode: await currentTotpCode(activeSecret) });
    expect(replaced.status).toBe(201);
    const newSecret = replaced.body.secret as string;
    expect(newSecret).toBeTruthy();
    expect(newSecret).not.toBe(activeSecret);
    const statusPending = await http(app).get('/api/v1/auth/mfa/status').set(auth);
    expect(statusPending.body).toEqual({ enabled: false });

    // Confirm bằng secret mới ⇒ MFA bật lại; authenticator cũ hết giá trị,
    // đăng nhập bị chặn và chỉ mở bằng mã của factor mới.
    const confirm = await http(app).post('/api/v1/auth/mfa/totp/confirm').set(auth)
      .send({ code: await currentTotpCode(newSecret) });
    expect(confirm.status).toBe(201);
    expect(confirm.body.mfaEnabled).toBe(true);
    const blocked = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(blocked.body.mfaRequired).toBe(true);
    const oldCodeVerify = await http(app).post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: blocked.body.challengeToken, code: await currentTotpCode(activeSecret) });
    expect(oldCodeVerify.status).toBe(401);
    expect(oldCodeVerify.body.code).toBe('auth.mfa_invalid_code');
    const verifiedNew = await http(app).post('/api/v1/auth/mfa/verify')
      .send({ challengeToken: blocked.body.challengeToken, code: await currentTotpCode(newSecret) });
    expect(verifiedNew.status).toBe(201);
    expect(verifiedNew.body.accessToken).toBeTruthy();
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
