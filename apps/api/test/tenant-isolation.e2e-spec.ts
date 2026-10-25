import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STRONG_PASSWORD,
  createTestApp,
  createUserViaApi,
  http,
  login,
  roleIdByShortname,
  uniqueName,
} from './identity-access-helpers';

/**
 * TENANT-0 (issue #168) — spec phủ 6 tiêu chí xong của issue:
 *  (1) đọc chéo tenant bằng id đoán → 404 đồng nhất trên các bề mặt đã
 *      phủ (khoá học, danh mục, cohort, bank, liên kết giám hộ, danh
 *      sách user của tenant);
 *  (2) cấu hình ghi ở tenant A không chạm tenant B / platform;
 *  (3) mỗi tenant đúng một bank trường theo kind, hai tenant cùng có;
 *  (4) giáo viên thuộc cả A+B chuyển tenant trong phiên, vai ở mỗi
 *      tenant độc lập (manager ở A không cho quyền quản trị ở B);
 *  (5) RLS: phiên SQL thô đã đặt GUC app.tenant_id (kể cả khi truy vấn
 *      KHÔNG lọc tenant_id) chỉ thấy dữ liệu của tenant đó — chạy dưới
 *      một role phụ không-superuser để RLS thật sự có hiệu lực;
 *  (6) seed: tenant-zero + tenant trường mặc định tồn tại, admin khởi
 *      tạo là thành viên của cả hai.
 *
 * Hai tenant A/B dựng bằng chính API công khai với token admin khởi
 * tạo (platform manager); mọi thao tác trong tenant đi qua chuyển
 * phiên (switch-tenant) như người dùng thật.
 */
describe('tenant isolation (TENANT-0, #168)', () => {
  let app: INestApplication;
  let adminZero = '';
  let adminA = '';
  let adminB = '';
  let tenantA = '';
  let tenantB = '';
  let categoryA = '';
  let courseA = '';
  let cohortA = '';
  let courseB = '';
  let categoryB = '';
  let cohortB = '';
  let bankSchoolA = '';
  let bankSchoolB = '';
  let linkA = '';
  let linkB = '';
  let teacherId = '';
  let teacherUsername = '';
  let memberAOnlyUsername = '';
  let teacherTokenA = '';
  let teacherRefreshA = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as never;
  };

  beforeAll(async () => {
    app = await createTestApp();
    const adminLogin = await login(app, 'admin', 'Admin123!');
    adminZero = adminLogin.accessToken;
    const adminId = adminLogin.userId;

    const slugA = `ta-${uniqueName('a').toLowerCase()}`;
    const slugB = `tb-${uniqueName('b').toLowerCase()}`;
    const createdA = await must(await http(app).post('/api/v1/tenants').set(auth(adminZero)).send({ name: 'Trường A (spec)', slug: slugA, kind: 'school' }), 'create tenant A') as { id: string };
    const createdB = await must(await http(app).post('/api/v1/tenants').set(auth(adminZero)).send({ name: 'Trường B (spec)', slug: slugB, kind: 'school' }), 'create tenant B') as { id: string };
    tenantA = createdA.id;
    tenantB = createdB.id;

    const teacher = await createUserViaApi(app, adminZero);
    teacherId = teacher.id;
    teacherUsername = teacher.username;
    const memberAOnly = await createUserViaApi(app, adminZero);
    memberAOnlyUsername = memberAOnly.username;
    const memberAOnlyId = memberAOnly.id;
    const guardianAUser = await createUserViaApi(app, adminZero);
    const studentAUser = await createUserViaApi(app, adminZero);
    const guardianBUser = await createUserViaApi(app, adminZero);
    const studentBUser = await createUserViaApi(app, adminZero);

    const addMember = async (tenantId: string, userId: string) => {
      await must(await http(app).post(`/api/v1/tenants/${tenantId}/members`).set(auth(adminZero)).send({ userId }), 'add member');
    };
    // Admin tự thêm mình vào cả hai tenant để chuyển phiên làm việc.
    for (const uid of [teacherId, memberAOnlyId, guardianAUser.id, studentAUser.id, adminId]) await addMember(tenantA, uid);
    for (const uid of [teacherId, guardianBUser.id, studentBUser.id, adminId]) await addMember(tenantB, uid);

    // TENANT-1 (#196, điểm N2): trong cây tenant KHÔNG còn lối tắt
    // site admin — admin muốn làm việc trong tenant A/B phải có vai
    // thật neo tại context tenant như mọi người. Phía platform gán
    // vai manager cho admin tại context của cả hai tenant TRƯỚC khi
    // gieo nội dung (đúng mô hình vận hành: tenant admin giữ vai
    // manager tại context tenant).
    const allContexts = await must(await http(app).get('/api/v1/access/contexts').set(auth(adminZero)), 'list contexts') as { id: string; contextLevel: number; instanceId: string }[];
    const tenantCtxA = allContexts.find((c) => c.contextLevel === 20 && c.instanceId === tenantA);
    const tenantCtxB = allContexts.find((c) => c.contextLevel === 20 && c.instanceId === tenantB);
    if (!tenantCtxA || !tenantCtxB) throw new Error('tenant contexts missing');
    const managerRole = await roleIdByShortname(app, adminZero, 'manager');
    for (const ctx of [tenantCtxA, tenantCtxB]) {
      await must(await http(app).post('/api/v1/access/assignments').set(auth(adminZero)).send({
        userId: adminId, roleId: managerRole, contextId: ctx.id,
      }), 'assign admin manager in tenant');
    }

    const switchTo = async (token: string, tenantId: string): Promise<string> => {
      const pair = await must(await http(app).post(`/api/v1/auth/switch-tenant/${tenantId}`).set(auth(token)), 'switch tenant') as { accessToken: string };
      return pair.accessToken;
    };
    adminA = await switchTo(adminZero, tenantA);
    adminB = await switchTo(adminA, tenantB);
    // adminZero đã bị thu hồi bởi lần chuyển đầu; đăng nhập lại cho các ca platform.
    adminZero = (await login(app, 'admin', 'Admin123!')).accessToken;

    const seedTenantContent = async (token: string, marker: string) => {
      const category = await must(await http(app).post('/api/v1/courses/categories').set(auth(token)).send({ name: `Danh mục ${marker}` }), 'create category') as { id: string };
      const course = await must(await http(app).post('/api/v1/courses').set(auth(token)).send({
        fullName: `Khoá ${marker}`, shortName: uniqueName('C').toUpperCase(), category: category.id,
      }), 'create course') as { id: string };
      const cohort = await must(await http(app).post('/api/v1/cohorts').set(auth(token)).send({ name: `Cohort ${marker}`, categoryId: category.id }), 'create cohort') as { id: string };
      return { categoryId: category.id, courseId: course.id, cohortId: cohort.id };
    };
    const inA = await seedTenantContent(adminA, 'A');
    categoryA = inA.categoryId; courseA = inA.courseId; cohortA = inA.cohortId;
    const inB = await seedTenantContent(adminB, 'B');
    categoryB = inB.categoryId; courseB = inB.courseId; cohortB = inB.cohortId;

    const linkInA = await must(await http(app).post('/api/v1/guardian-links').set(auth(adminA)).send({
      guardianUserId: guardianAUser.id, studentUserId: studentAUser.id, relationship: 'cha',
    }), 'create guardian link A') as { id: string };
    linkA = linkInA.id;
    const linkInB = await must(await http(app).post('/api/v1/guardian-links').set(auth(adminB)).send({
      guardianUserId: guardianBUser.id, studentUserId: studentBUser.id, relationship: 'mẹ',
    }), 'create guardian link B') as { id: string };
    linkB = linkInB.id;

    const schoolBankOf = async (token: string) => {
      const banks = await must(await http(app).get('/api/v1/question-banks').set(auth(token)), 'list banks') as { id: string; scope: string; tenantId: string | null }[];
      const school = banks.filter((b) => b.scope === 'school');
      expect(school).toHaveLength(1);
      return school[0]!;
    };
    bankSchoolA = (await schoolBankOf(adminA)).id;
    bankSchoolB = (await schoolBankOf(adminB)).id;

    // Vai manager của giáo viên CHỈ ở context tenant A (tiêu chí 4).
    await must(await http(app).post('/api/v1/access/assignments').set(auth(adminZero)).send({
      userId: teacherId, roleId: managerRole, contextId: tenantCtxA.id,
    }), 'assign manager in tenant A');

    const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
    teacherTokenA = teacherLogin.accessToken;
    teacherRefreshA = teacherLogin.refreshToken;
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  it('(6) seed: có tenant-zero + tenant mặc định, admin là thành viên cả hai', async () => {
    const tenants = await must(await http(app).get('/api/v1/tenants').set(auth(adminZero)), 'list tenants') as { slug: string }[];
    const slugs = tenants.map((t) => t.slug);
    expect(slugs).toContain('trang-chinh');
    expect(slugs).toContain('truong-mac-dinh');
    const mine = await must(await http(app).get('/api/v1/auth/tenants').set(auth(adminZero)), 'my tenants') as { slug: string }[];
    const mineSlugs = mine.map((t) => t.slug);
    expect(mineSlugs).toContain('trang-chinh');
    expect(mineSlugs).toContain('truong-mac-dinh');
  });

  it('(1) đọc chéo tenant bằng id đoán → 404 đồng nhất', async () => {
    // Giáo viên đang ở phiên tenant A (đăng nhập mặc định về A).
    const course = await http(app).get(`/api/v1/courses/${courseB}`).set(auth(teacherTokenA));
    expect(course.status).toBe(404);
    const category = await http(app).get(`/api/v1/courses/categories/${categoryB}`).set(auth(teacherTokenA));
    expect(category.status).toBe(404);
    const cohort = await http(app).get(`/api/v1/cohorts/${cohortB}`).set(auth(teacherTokenA));
    expect(cohort.status).toBe(404);
    const bank = await http(app).get(`/api/v1/question-banks/${bankSchoolB}`).set(auth(teacherTokenA));
    expect(bank.status).toBe(404);
    // Danh sách trong phiên A không chứa tài nguyên B.
    const courses = await must(await http(app).get('/api/v1/courses').set(auth(teacherTokenA)), 'list courses A') as { id: string }[];
    expect(courses.map((c) => c.id)).toContain(courseA);
    expect(courses.map((c) => c.id)).not.toContain(courseB);
    // Liên kết giám hộ của B không lộ trong phiên A; thu hồi chéo → 404.
    const links = await must(await http(app).get('/api/v1/guardian-links').set(auth(adminA)), 'list links A') as { id: string }[];
    expect(links.map((l) => l.id)).toContain(linkA);
    expect(links.map((l) => l.id)).not.toContain(linkB);
    const revoke = await http(app).delete(`/api/v1/guardian-links/${linkB}`).set(auth(adminA));
    expect(revoke.status).toBe(404);
    // Người chỉ thuộc A không xem được danh sách user của B.
    const memberToken = (await login(app, memberAOnlyUsername, STRONG_PASSWORD)).accessToken;
    const usersB = await http(app).get(`/api/v1/tenants/${tenantB}/users`).set(auth(memberToken));
    expect(usersB.status).toBe(403);
  });

  it('(2) cấu hình tenant A đổi không chạm B và platform', async () => {
    const put = await http(app).put('/api/v1/site-config/tenant-settings/core/fullname').set(auth(adminA)).send({ value: 'Trường A (spec)' });
    expect(put.status).toBe(200);
    const inA = await must(await http(app).get('/api/v1/site-config/tenant-settings').set(auth(adminA)), 'tenant settings A') as { name: string; value: unknown; source: string }[];
    expect(inA.find((s) => s.name === 'fullname')?.value).toBe('Trường A (spec)');
    expect(inA.find((s) => s.name === 'fullname')?.source).toBe('database');
    const inB = await must(await http(app).get('/api/v1/site-config/tenant-settings').set(auth(adminB)), 'tenant settings B') as { name: string; value: unknown }[];
    expect(inB.find((s) => s.name === 'fullname')?.value).not.toBe('Trường A (spec)');
    const platform = await must(await http(app).get('/api/v1/site-config').set(auth(adminZero)), 'platform settings') as { name: string; value: unknown }[];
    expect(platform.find((s) => s.name === 'fullname')?.value).not.toBe('Trường A (spec)');
    // Setting chỉ-platform không ghi đè được từ tenant (400, code site_config.platform_only).
    const platformOnly = await http(app).put('/api/v1/site-config/tenant-settings/core/sitepolicy').set(auth(adminA)).send({ value: 'x' });
    expect(platformOnly.status).toBe(400);
    expect((platformOnly.body as { code?: string }).code).toBe('site_config.platform_only');
  });

  it('(3) mỗi tenant đúng một bank trường; bank platform tenant_id NULL', async () => {
    expect(bankSchoolA).not.toBe(bankSchoolB);
    const banksA = await must(await http(app).get('/api/v1/question-banks').set(auth(adminA)), 'banks A') as { scope: string; tenantId: string | null }[];
    expect(banksA.find((b) => b.scope === 'school')?.tenantId).toBe(tenantA);
    const banksB = await must(await http(app).get('/api/v1/question-banks').set(auth(adminB)), 'banks B') as { scope: string; tenantId: string | null }[];
    expect(banksB.find((b) => b.scope === 'school')?.tenantId).toBe(tenantB);
    const banksPlatform = await must(await http(app).get('/api/v1/question-banks').set(auth(adminZero)), 'banks platform session') as { scope: string; tenantId: string | null }[];
    const platformBank = banksPlatform.find((b) => b.scope === 'platform');
    expect(platformBank).toBeDefined();
    expect(platformBank?.tenantId).toBeNull();
  });

  it('(4) chuyển tenant trong phiên; vai manager ở A không lan sang B', async () => {
    const current = await must(await http(app).get('/api/v1/tenants/current').set(auth(teacherTokenA)), 'current tenant') as { id: string };
    expect(current.id).toBe(tenantA);
    // Ở A: xem được danh sách thành viên A nhờ vai manager tại context tenant A.
    const membersA = await http(app).get(`/api/v1/tenants/${tenantA}/members`).set(auth(teacherTokenA));
    expect(membersA.status).toBe(200);
    // Chuyển sang B: phiên mới mang tenant B, nhưng KHÔNG có vai quản trị ở B.
    const pair = await must(await http(app).post(`/api/v1/auth/switch-tenant/${tenantB}`).set(auth(teacherTokenA)), 'teacher switch to B') as { accessToken: string };
    const currentB = await must(await http(app).get('/api/v1/tenants/current').set(auth(pair.accessToken)), 'current tenant B') as { id: string };
    expect(currentB.id).toBe(tenantB);
    const membersB = await http(app).get(`/api/v1/tenants/${tenantB}/members`).set(auth(pair.accessToken));
    expect(membersB.status).toBe(403);
    // Phiên cũ bị chốt theo claim: access token cũ vẫn mang tenant A
    // (đúng vòng đời token ngắn hạn hiện hữu), nhưng refresh token của
    // family cũ đã bị thu hồi — không gia hạn tiếp được ở tenant cũ.
    const staleCurrent = await must(await http(app).get('/api/v1/tenants/current').set(auth(teacherTokenA)), 'current with old token') as { id: string };
    expect(staleCurrent.id).toBe(tenantA);
    const staleRefresh = await http(app).post('/api/v1/auth/refresh').send({ refreshToken: teacherRefreshA });
    expect(staleRefresh.status).toBe(401);
  });

  it('(5) RLS: phiên tenant đặt GUC chỉ thấy dữ liệu tenant đó dù không lọc', async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const role = `tenant_spec_${Date.now().toString(36)}`;
    try {
      await pg.query(`CREATE ROLE ${role} NOLOGIN`);
      await pg.query(`GRANT SELECT ON course, course_categories TO ${role}`);
      await pg.query('BEGIN');
      await pg.query(`SET ROLE ${role}`);
      await pg.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const inA = await pg.query<{ id: string }>('SELECT id FROM course WHERE id = ANY($1)', [[courseA, courseB]]);
      expect(inA.rows.map((r) => r.id)).toEqual([courseA]);
      const catsA = await pg.query<{ id: string }>('SELECT id FROM course_categories WHERE id = ANY($1)', [[categoryA, categoryB]]);
      expect(catsA.rows.map((r) => r.id)).toEqual([categoryA]);
      await pg.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
      const inB = await pg.query<{ id: string }>('SELECT id FROM course WHERE id = ANY($1)', [[courseA, courseB]]);
      expect(inB.rows.map((r) => r.id)).toEqual([courseB]);
      // Đường platform tường minh (cờ phiên) mới thấy cả hai.
      await pg.query(`SELECT set_config('app.platform', 'on', true)`);
      const all = await pg.query<{ id: string }>('SELECT id FROM course WHERE id = ANY($1)', [[courseA, courseB]]);
      expect(all.rows.map((r) => r.id).sort()).toEqual([courseA, courseB].sort());
      await pg.query('COMMIT');
    } finally {
      await pg.query('ROLLBACK').catch(() => undefined);
      await pg.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await pg.end();
    }
  });

  it('(7) N2 (TENANT-1): site admin là thành viên nhưng KHÔNG có vai trong cây tenant → bị chặn như người thường', async () => {
    // Một site admin thứ hai: manager tại context HỆ THỐNG (quyền
    // platform đầy đủ) + thành viên của tenant A, nhưng không một gán
    // vai nào neo trong cây A.
    const support = await createUserViaApi(app, adminZero);
    const contexts = await must(await http(app).get('/api/v1/access/contexts').set(auth(adminZero)), 'list contexts') as { id: string; contextLevel: number; instanceId: string | null }[];
    const systemCtx = contexts.find((c) => c.contextLevel === 10);
    if (!systemCtx) throw new Error('system context missing');
    const managerRole = await roleIdByShortname(app, adminZero, 'manager');
    await must(await http(app).post('/api/v1/access/assignments').set(auth(adminZero)).send({
      userId: support.id, roleId: managerRole, contextId: systemCtx.id,
    }), 'assign support system manager');
    await must(await http(app).post(`/api/v1/tenants/${tenantA}/members`).set(auth(adminZero)).send({ userId: support.id }), 'add support to tenant A');

    const supportLogin = await login(app, support.username, STRONG_PASSWORD);
    const pair = await must(await http(app).post(`/api/v1/auth/switch-tenant/${tenantA}`).set(auth(supportLogin.accessToken)), 'support switch to A') as { accessToken: string };
    // Trong cây A: lối tắt site admin đã tắt — các bề mặt check
    // capability TẠI context trong cây (category:manage tại context
    // tenant/context danh mục) chặn thẳng tay dù actor là site
    // admin, vì không có vai neo tại chỗ.
    const createCat = await http(app).post('/api/v1/courses/categories').set(auth(pair.accessToken)).send({ name: 'Danh mục N2 không được phép' });
    expect(createCat.status).toBe(403);
    const patchCat = await http(app).patch(`/api/v1/courses/categories/${categoryA}`).set(auth(pair.accessToken)).send({ name: 'Đổi tên trái phép' });
    expect(patchCat.status).toBe(403);
    // Ngoài cây tenant, cùng tài khoản vẫn là site admin nguyên vẹn:
    // quản trị tenant từ phía platform (nhánh platform của
    // assertTenantViewer, thiết kế TENANT-0) vẫn mở như cũ.
    const tenants = await http(app).get('/api/v1/tenants').set(auth(supportLogin.accessToken));
    expect(tenants.status).toBe(200);
    const membersFromPlatform = await http(app).get(`/api/v1/tenants/${tenantA}/members`).set(auth(supportLogin.accessToken));
    expect(membersFromPlatform.status).toBe(200);
  });

  it('(8) fail-closed + N3 (TENANT-1): SQL thô không GUC hoặc GUC rỗng → 0 dòng, không lỗi; notifications cách ly theo GUC', async () => {
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const marker = `tenant_spec_${Date.now().toString(36)}`;
    // Hai notification của cùng giáo viên, mỗi cái thuộc một tenant.
    await pg.query(
      `insert into notifications (user_id_to, subject, full_message, small_message, component, event_type, tenant_id)
       values ($1, $2, 'x', 'x', 'core_spec', 'tenant_spec', $3), ($1, $4, 'x', 'x', 'core_spec', 'tenant_spec', $5)`,
      [teacherId, `${marker}-A`, tenantA, `${marker}-B`, tenantB],
    );
    const role = `tenant_spec_fc_${Date.now().toString(36)}`;
    try {
      await pg.query(`CREATE ROLE ${role} NOLOGIN`);
      await pg.query(`GRANT SELECT ON course, notifications TO ${role}`);
      await pg.query('BEGIN');
      await pg.query(`SET ROLE ${role}`);
      // Không đặt GUC nào: fail-closed — 0 dòng, KHÔNG lỗi.
      const noGuc = await pg.query<{ id: string }>('SELECT id FROM course WHERE id = ANY($1)', [[courseA, courseB]]);
      expect(noGuc.rows).toEqual([]);
      const noGucNotif = await pg.query<{ subject: string }>(
        `SELECT subject FROM notifications WHERE event_type = 'tenant_spec' AND subject LIKE $1`, [`${marker}%`]);
      expect(noGucNotif.rows).toEqual([]);
      // GUC rỗng '': N3 — không được ném lỗi ép kiểu uuid, vẫn 0 dòng.
      await pg.query(`SELECT set_config('app.tenant_id', '', true)`);
      const emptyGuc = await pg.query<{ id: string }>('SELECT id FROM course WHERE id = ANY($1)', [[courseA, courseB]]);
      expect(emptyGuc.rows).toEqual([]);
      // GUC tenant A: chỉ notification của A lộ ra ở tầng SQL.
      await pg.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const notifA = await pg.query<{ subject: string }>(
        `SELECT subject FROM notifications WHERE event_type = 'tenant_spec' AND subject LIKE $1`, [`${marker}%`]);
      expect(notifA.rows.map((r) => r.subject)).toEqual([`${marker}-A`]);
      await pg.query('COMMIT');
    } finally {
      await pg.query('ROLLBACK').catch(() => undefined);
      await pg.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await pg.end();
    }
  });

  it('(9) notifications chéo tenant ở bề mặt API (TENANT-1): phiên A chỉ thấy thông báo của A, phiên B chỉ thấy của B', async () => {
    // Dùng lại hai notification đã gieo ở ca (8) cho giáo viên.
    const teacherLogin = await login(app, teacherUsername, STRONG_PASSWORD);
    const itemsIn = async (token: string) => {
      const res = await must(await http(app).get('/api/v1/notifications/items?eventType=tenant_spec&limit=50').set(auth(token)), 'notification items') as { items: { subject: string }[] };
      return res.items.map((i) => i.subject);
    };
    const inA = await itemsIn(teacherLogin.accessToken);
    expect(inA.some((s) => s.endsWith('-A'))).toBe(true);
    expect(inA.some((s) => s.endsWith('-B'))).toBe(false);
    const pairB = await must(await http(app).post(`/api/v1/auth/switch-tenant/${tenantB}`).set(auth(teacherLogin.accessToken)), 'teacher switch to B') as { accessToken: string };
    const inB = await itemsIn(pairB.accessToken);
    expect(inB.some((s) => s.endsWith('-B'))).toBe(true);
    expect(inB.some((s) => s.endsWith('-A'))).toBe(false);
  });
});
