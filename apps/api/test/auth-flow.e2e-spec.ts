import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * Auth flow tests.
 * Oracle: lib/tests/authlib_test.php (MOODLE_503_STABLE) — test_lockout,
 * test_authenticate_user_login; refresh rotation + reuse detection per
 * report §3.7 (self-built, OAuth security best practice).
 */
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

  it('login-as: an admin with moodle/user:loginas can act as another user; a normal user cannot', async () => {
    const target = await createUserViaApi(app, admin);
    const as = await http(app).post('/api/v1/auth/login-as').set('Authorization', `Bearer ${admin}`).send({ userid: target.id });
    expect(as.status).toBe(201);
    expect(as.body.loginAs.byUserId).toBeGreaterThan(0);
    const me = await http(app).get('/api/v1/users/me').set('Authorization', `Bearer ${as.body.accessToken}`);
    expect(me.body.id).toBe(target.id);
    const plain = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, plain.username, STRONG_PASSWORD);
    const denied = await http(app).post('/api/v1/auth/login-as').set('Authorization', `Bearer ${accessToken}`).send({ userid: target.id });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('access.capability_denied');
  });

  it('authentication alone grants no admin capability (auth ≠ role assignment)', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${accessToken}`)
      .send({ username: 'nope', email: 'nope@example.com', password: STRONG_PASSWORD });
    expect(res.status).toBe(403);
  });
});
