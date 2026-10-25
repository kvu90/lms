import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createRoleViaApi, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName } from './identity-access-helpers';

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

  it('hides identity fields (email) from users without site:viewuseridentity, shows them to admins', async () => {
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
    const guest = (list.body.users as { id: string; username: string }[]).find((u) => u.username === 'guest');
    expect(guest).toBeTruthy();
    const del = await http(app).delete(`/api/v1/users/${guest!.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(400);
  });
});

/**
 * Self-service access view (GET /users/me/capabilities).
 * Oracle: Access subsystem (blueprint §2#1 + report §3.3) — capability
 * resolution is the PermissionEvaluator's job; this endpoint only exposes
 * the CALLER's own resolved view (site-admin flag, role assignments with
 * context info, resolved capabilities per related context) so clients
 * render exactly what the user can operate instead of probing endpoints.
 * It takes no user parameter: another user's data is unreachable here.
 */
describe('Users: self-service capabilities view', () => {
  let app: INestApplication;
  let admin: string;
  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  it('a plain user sees their own assignments and resolved capabilities, and nothing of anyone else', async () => {
    const systemId = await systemContextId(app, admin);
    const alice = await createUserViaApi(app, admin);
    const bob = await createUserViaApi(app, admin);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    await assignRole(app, admin, alice.id, studentRole, systemId);
    // Bob gets a distinctive custom role; it must never leak into Alice's view.
    const bobRole = await createRoleViaApi(app, admin);
    await assignRole(app, admin, bob.id, bobRole, systemId);

    const { accessToken } = await login(app, alice.username, STRONG_PASSWORD);
    const res = await http(app).get('/api/v1/users/me/capabilities').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe(alice.id);
    expect(res.body.isSiteAdmin).toBe(false);

    const mine = (res.body.assignments as { roleId: string; contextId: string }[]);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ roleId: studentRole, contextId: systemId });
    expect((res.body.assignments as { roleId: string }[]).some((a) => a.roleId === bobRole)).toBe(false);
    const assignment = (res.body.assignments as { roleShortname: string; contextLevel: number; contextPath: string }[])[0]!;
    expect(assignment.roleShortname).toBe('student');
    expect(assignment.contextLevel).toBe(10);
    expect(assignment.contextPath).toContain(systemId);

    const systemView = (res.body.contexts as { contextId: string; capabilities: string }[])
      .find((c) => c.contextId === systemId);
    expect(systemView).toBeDefined();
    // Student archetype resolves at the system context; admin-only caps do not.
    expect(systemView!.capabilities).toContain('files:view');
    expect(systemView!.capabilities).not.toContain('site:config');
  });

  it('the site admin sees isSiteAdmin=true and the full capability set at the system context', async () => {
    const res = await http(app).get('/api/v1/users/me/capabilities').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.isSiteAdmin).toBe(true);
    const systemView = (res.body.contexts as { contextLevel: number; capabilities: string }[])
      .find((c) => c.contextLevel === 10);
    expect(systemView).toBeDefined();
    expect(systemView!.capabilities).toContain('site:config');
    expect(systemView!.capabilities).toContain('course:view');
  });

  it('requires authentication', async () => {
    const res = await http(app).get('/api/v1/users/me/capabilities');
    expect(res.status).toBe(401);
  });
});

/**
 * Cờ hiện vật học tập trong ảnh chụp quyền (issue #176, nhánh A của dấu
 * chân học tập): huy hiệu đã cấp chưa thu hồi HOẶC kế hoạch học tập của
 * chính mình → true; chỉ có huy hiệu đã thu hồi hoặc không có gì → false.
 * Hàng huy hiệu/kế hoạch chèn trực tiếp bằng SQL (như test outbox phía
 * trên) để không phụ thuộc luồng cấp huy hiệu/tạo kế hoạch qua API.
 */
describe('Users: hasLearnerArtifacts in self-service capabilities view', () => {
  let app: INestApplication;
  let admin: string;
  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function capabilitiesOf(user: { id: string; username: string }): Promise<Record<string, unknown>> {
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).get('/api/v1/users/me/capabilities').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try { return await fn(client); } finally { await client.end(); }
  }

  async function issueBadge(userId: string, revoked: boolean): Promise<void> {
    await withClient(async (client) => {
      const badge = await client.query('insert into badge (name) values ($1) returning id', [`badge-176-${Date.now()}-${Math.random()}`]);
      await client.query(
        'insert into badge_issued (badge_id, user_id, unique_hash, revoked) values ($1, $2, $3, $4)',
        [badge.rows[0].id, userId, `hash-176-${Date.now()}-${Math.random()}`, revoked],
      );
    });
  }

  it('user không có hiện vật nào → false', async () => {
    const user = await createUserViaApi(app, admin);
    expect((await capabilitiesOf(user)).hasLearnerArtifacts).toBe(false);
  });

  it('user có huy hiệu đã cấp chưa thu hồi → true', async () => {
    const user = await createUserViaApi(app, admin);
    await issueBadge(user.id, false);
    expect((await capabilitiesOf(user)).hasLearnerArtifacts).toBe(true);
  });

  it('user chỉ có huy hiệu đã thu hồi → false', async () => {
    const user = await createUserViaApi(app, admin);
    await issueBadge(user.id, true);
    expect((await capabilitiesOf(user)).hasLearnerArtifacts).toBe(false);
  });

  it('user có kế hoạch học tập của chính mình → true', async () => {
    const user = await createUserViaApi(app, admin);
    await withClient(async (client) => {
      await client.query('insert into learning_plans (name, user_id) values ($1, $2)', ['Kế hoạch 176', user.id]);
    });
    expect((await capabilitiesOf(user)).hasLearnerArtifacts).toBe(true);
  });
});
