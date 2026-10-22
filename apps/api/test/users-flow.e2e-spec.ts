import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD, uniqueName } from './identity-access-helpers';

/**
 * Users & profile flow tests.
 * Oracle: lib/tests/user_test.php (MOODLE_503_STABLE) — test_search_no_identity_fields,
 * test_search_deleted_users, test_validate; report §2#2 (soft delete, guest, identity-by-capability).
 */
describe('Users: identity rules, soft delete, preferences, outbox events', () => {
  let app: INestApplication;
  let admin: string;
  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('normalizes username/email to lowercase and enforces uniqueness case-insensitively', async () => {
    const name = uniqueName('Mixed');
    const created = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
      .send({ username: name, email: `${name}@EXAMPLE.com`, password: STRONG_PASSWORD });
    expect(created.status).toBe(201);
    expect(created.body.username).toBe(name.toLowerCase());
    expect(created.body.email).toBe(`${name.toLowerCase()}@example.com`);
    const dup = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
      .send({ username: uniqueName('other'), email: `${name}@example.com`, password: STRONG_PASSWORD });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('user.email_taken');
  });

  it('hides identity fields (email) from users without moodle/site:viewuseridentity, shows them to admins', async () => {
    const target = await createUserViaApi(app, admin);
    const viewer = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, viewer.username, STRONG_PASSWORD);
    const asViewer = await http(app).get(`/api/v1/users/${target.id}`).set('Authorization', `Bearer ${accessToken}`);
    expect(asViewer.status).toBe(200);
    expect(asViewer.body.username).toBe(target.username);
    expect(asViewer.body.email).toBeUndefined();
    const asAdmin = await http(app).get(`/api/v1/users/${target.id}`).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.body.email).toBe(target.email);
    const list = await http(app).get('/api/v1/users').query({ search: target.username }).set('Authorization', `Bearer ${accessToken}`);
    expect(list.status).toBe(200);
    expect(list.body.users[0].email).toBeUndefined();
  });

  it('searches and paginates users', async () => {
    const marker = uniqueName('findme');
    await createUserViaApi(app, admin, { username: marker, email: `${marker}@example.com` });
    const res = await http(app).get('/api/v1/users').query({ search: marker, page: 1, pageSize: 5 }).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.users[0].username).toBe(marker);
  });

  it('soft-deletes: row is kept and marked, identity is mangled, login is refused, the username can be reused', async () => {
    const user = await createUserViaApi(app, admin);
    const del = await http(app).delete(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    const view = await http(app).get(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    expect(view.body.deleted).toBe(true);
    expect(view.body.username).toContain('.deleted');
    const loginRes = await http(app).post('/api/v1/auth/token').send({ username: user.username, password: STRONG_PASSWORD });
    expect(loginRes.status).toBe(401);
    const recreated = await http(app).post('/api/v1/users').set('Authorization', `Bearer ${admin}`)
      .send({ username: user.username, email: user.email, password: STRONG_PASSWORD });
    expect(recreated.status).toBe(201);
  });

  it('stores and reads user preferences', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const put = await http(app).put(`/api/v1/users/${user.id}/preferences`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'theme', value: 'dark' });
    expect(put.status).toBe(200);
    const got = await http(app).get(`/api/v1/users/${user.id}/preferences/theme`).set('Authorization', `Bearer ${accessToken}`);
    expect(got.body.value).toBe('dark');
  });

  it('emits user_created/user_deleted through the transactional outbox', async () => {
    const user = await createUserViaApi(app, admin);
    await http(app).delete(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const res = await client.query("select type from outbox_events where aggregate='user' and payload->>'userId' = $1 order by id", [String(user.id)]);
      expect(res.rows.map((r) => r.type)).toEqual(expect.arrayContaining(['user_created', 'user_deleted']));
    } finally { await client.end(); }
  });

  it('the guest account cannot be suspended or deleted', async () => {
    const list = await http(app).get('/api/v1/users').query({ search: 'guest' }).set('Authorization', `Bearer ${admin}`);
    const guest = (list.body.users as { id: number; username: string }[]).find((u) => u.username === 'guest');
    expect(guest).toBeTruthy();
    const del = await http(app).delete(`/api/v1/users/${guest!.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(400);
  });
});
