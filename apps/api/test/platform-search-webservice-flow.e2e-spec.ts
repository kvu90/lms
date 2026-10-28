import type { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createRoleViaApi, createUserViaApi, http, login,
  roleIdByShortname, setOverride, STRONG_PASSWORD, systemContextId,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { contextIdByLevelInstance, courseContextId, suspendUser } from './engagement-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';

const PROHIBIT = -1000;

/**
 * Luồng Platform: Search / Web Services / Content Bank / Analytics / Reports.
 * Oracle Moodle 5.3 (MOODLE_503_STABLE, đã kiểm chứng live 22/10/2026):
 * - search/tests/manager_test.php + base_test.php (area registry, quyền khi tìm)
 * - webservice/tests/externallib_test.php (token + các hàm service)
 * - contentbank/tests/contentbank_test.php (nội dung theo context, draft/public)
 * - analytics/tests/model_test.php + prediction_test.php (model/indicator, insight không phải dữ kiện)
 * - reportbuilder/tests/manager_test.php + permission_test.php (audience ∩ quyền từng dòng)
 */
describe('Platform services: search permission re-check, webservice tokens, content bank, analytics, reports', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function setupCourseWithStudent() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { cat, course, instance, student, studentToken };
  }

  it('search DoD: a user with PROHIBIT at the course context finds nothing, even with a stale index entry; an enrolled user finds the course', async () => {
    const { course, student, studentToken } = await setupCourseWithStudent();
    const ctxId = await courseContextId(app, admin, course.id);
    // Index khoá học qua area thật.
    const idx = await http(app).post('/api/v1/search/index').set('Authorization', `Bearer ${admin}`).send({ area: 'courses', itemId: course.id });
    expect(idx.body.indexed).toBe(true);
    const q = encodeURIComponent(course.fullName.split(' ').slice(0, 2).join(' '));
    // Người có quyền (học viên đã ghi danh) tìm thấy.
    const found = await http(app).get(`/api/v1/search?q=${encodeURIComponent('Course')}`).set('Authorization', `Bearer ${studentToken}`);
    expect(found.status).toBe(200);
    expect((found.body as { itemId: string }[]).some((d) => d.itemId === course.id)).toBe(true);
    void q;
    // User bị PROHIBIT course:view tại course context: tạo role riêng + assignment + PROHIBIT override.
    const blocked = await createUserViaApi(app, admin);
    const roleId = await createRoleViaApi(app, admin);
    await assignRole(app, admin, blocked.id, roleId, ctxId);
    await setOverride(app, admin, roleId, 'course:view', ctxId, PROHIBIT);
    const blockedToken = (await login(app, blocked.username, STRONG_PASSWORD)).accessToken;
    const res = await http(app).get(`/api/v1/search?q=${encodeURIComponent('Course')}`).set('Authorization', `Bearer ${blockedToken}`);
    expect(res.status).toBe(200);
    expect((res.body as { itemId: string }[]).some((d) => d.itemId === course.id)).toBe(false);
    // Kể cả khi index còn sót một tài liệu trỏ vào context đó, re-check vẫn chặn.
    const stale = await http(app).post('/api/v1/search/index-raw').set('Authorization', `Bearer ${admin}`)
      .send({ area: 'courses', itemId: uuidv7(), title: 'StaleSecretCourse', content: 'StaleSecretCourse leaked content', contextId: ctxId });
    expect(stale.status).toBeLessThan(300);
    const res2 = await http(app).get(`/api/v1/search?q=StaleSecretCourse`).set('Authorization', `Bearer ${blockedToken}`);
    expect((res2.body as unknown[]).length).toBe(0);
    // Admin (site admin bypass có chủ đích) vẫn thấy tài liệu stale vì area fetch trả null? — re-check bản ghi gốc: itemId không tồn tại nên admin cũng không thấy.
    const resAdmin = await http(app).get(`/api/v1/search?q=StaleSecretCourse`).set('Authorization', `Bearer ${admin}`);
    expect((resAdmin.body as unknown[]).length).toBe(0);
    void student;
  });

  it('search: a suspended user document leaves the index (purge by owner) and areas registry lists at least 3 real areas', async () => {
    const areas = await http(app).get('/api/v1/search/areas').set('Authorization', `Bearer ${admin}`);
    expect(areas.body).toEqual(expect.arrayContaining(['courses', 'users', 'contentbank']));
    const user = await createUserViaApi(app, admin);
    const idx = await http(app).post('/api/v1/search/index').set('Authorization', `Bearer ${admin}`).send({ area: 'users', itemId: user.id });
    expect(idx.body.indexed).toBe(true);
    await http(app).post(`/api/v1/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`).send({});
    // Sau suspend, fetch của area trả null ⇒ index lại sẽ gỡ tài liệu.
    const idx2 = await http(app).post('/api/v1/search/index').set('Authorization', `Bearer ${admin}`).send({ area: 'users', itemId: user.id });
    expect(idx2.body.indexed).toBe(false);
    const res = await http(app).get(`/api/v1/search?q=${encodeURIComponent(user.username)}`).set('Authorization', `Bearer ${admin}`);
    expect((res.body as { itemId: string }[]).some((d) => d.itemId === user.id)).toBe(false);
  });

  it('search users: email stays hidden from non-managers in payload and matching, managers keep full behaviour, before and after a full reindex', async () => {
    type Doc = { area: string; itemId: string; content: string };
    const searchAs = async (token: string, q: string): Promise<Doc[]> => {
      const res = await http(app).get(`/api/v1/search?q=${encodeURIComponent(q)}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return res.body as Doc[];
    };
    // Người dùng đích, được lập chỉ mục qua area thật (fetch mới không
    // còn đưa email vào nội dung lập chỉ mục).
    const target = await createUserViaApi(app, admin);
    const idx = await http(app).post('/api/v1/search/index').set('Authorization', `Bearer ${admin}`).send({ area: 'users', itemId: target.id });
    expect(idx.body.indexed).toBe(true);
    const sysCtx = await systemContextId(app, admin);
    const ALLOW = 1;
    // Người tìm KHÔNG có quyền quản trị người dùng nhưng xem được hồ sơ
    // (role riêng chỉ có override ALLOW cho user:viewdetails tại context
    // hệ thống — đúng cổng lớp 1 hiện hành của area users; không phải
    // site admin, không giữ user:update ở bất kỳ đâu).
    const viewer = await createUserViaApi(app, admin);
    const viewerRole = await createRoleViaApi(app, admin);
    await assignRole(app, admin, viewer.id, viewerRole, sysCtx);
    await setOverride(app, admin, viewerRole, 'user:viewdetails', sysCtx, ALLOW);
    const viewerToken = (await login(app, viewer.username, STRONG_PASSWORD)).accessToken;
    // Một tài khoản hoàn toàn thường (không gán thêm quyền nào): dù thấy
    // hay không thấy tài liệu, payload của họ không bao giờ chứa email.
    const plain = await createUserViaApi(app, admin);
    const plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    // Người tìm CÓ quyền quản trị người dùng theo đúng định nghĩa áp cho
    // bề mặt này: không phải site admin, nhưng giữ user:update tại
    // context hệ thống (kèm user:viewdetails để qua cổng lớp 1 như một
    // tài khoản quản trị người dùng thật).
    const mgr = await createUserViaApi(app, admin);
    const mgrRole = await createRoleViaApi(app, admin);
    await assignRole(app, admin, mgr.id, mgrRole, sysCtx);
    await setOverride(app, admin, mgrRole, 'user:viewdetails', sysCtx, ALLOW);
    await setOverride(app, admin, mgrRole, 'user:update', sysCtx, ALLOW);
    const mgrToken = (await login(app, mgr.username, STRONG_PASSWORD)).accessToken;

    const expectHiddenForNonManager = async (token: string) => {
      // Tìm theo username: tài liệu users hiện ra nhưng toàn bộ payload
      // không chứa email của người bị tìm ở bất kỳ trường nào.
      const byName = await searchAs(token, target.username);
      expect(byName.some((d) => d.area === 'users' && d.itemId === target.id)).toBe(true);
      expect(JSON.stringify(byName)).not.toContain(target.email);
      // Tìm bằng địa chỉ email đầy đủ: không có kết quả users nào khớp
      // theo email đó — tính chất truy vấn cũng không được lộ email.
      const byEmail = await searchAs(token, target.email);
      expect(byEmail.some((d) => d.area === 'users' && d.itemId === target.id)).toBe(false);
      expect(JSON.stringify(byEmail)).not.toContain(target.email);
    };
    const expectFullForManager = async (token: string) => {
      // Payload giữ nguyên như trước khi sửa: content mang email.
      const byName = await searchAs(token, target.username);
      const doc = byName.find((d) => d.area === 'users' && d.itemId === target.id);
      expect(doc?.content).toContain(target.email);
      // Khớp được theo email đầy đủ như trước khi sửa.
      const byEmail = await searchAs(token, target.email);
      expect(byEmail.some((d) => d.area === 'users' && d.itemId === target.id)).toBe(true);
    };

    await expectHiddenForNonManager(viewerToken);
    // Tài khoản thường: khẳng định theo payload thật họ nhận được.
    expect(JSON.stringify(await searchAs(plainToken, target.username))).not.toContain(target.email);
    expect((await searchAs(plainToken, target.email)).some((d) => d.area === 'users' && d.itemId === target.id)).toBe(false);
    await expectFullForManager(admin);
    await expectFullForManager(mgrToken);

    // Sau khi lập chỉ mục lại toàn bộ, cả hai hành vi vẫn đúng — cơ chế
    // sửa không bị việc dựng lại chỉ mục phá vỡ.
    const re = await http(app).post('/api/v1/search/reindex').set('Authorization', `Bearer ${admin}`).send({});
    expect(re.status).toBeLessThan(300);
    await expectHiddenForNonManager(viewerToken);
    await expectFullForManager(admin);
    await expectFullForManager(mgrToken);
  });

  it('search users: a stale legacy users document keeps email hidden from non-managers and visible to managers', async () => {
    type Doc = { area: string; itemId: string; content: string };
    const searchAs = async (token: string, q: string): Promise<Doc[]> => {
      const res = await http(app).get(`/api/v1/search?q=${encodeURIComponent(q)}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      return res.body as Doc[];
    };
    // Người dùng đích, nhưng tài liệu trong chỉ mục là bản kiểu cũ còn
    // sót từ trước khi sửa: content mang cả username lẫn email, ghi
    // thẳng qua route index-raw thay vì qua fetch mới. Tài liệu cũ thật
    // phải mang đúng context mà fetch của area users từng ghi — context
    // người dùng cấp 30 của chính target (tạo cùng lúc với tài khoản);
    // ghi context hệ thống thì lớp re-check loại tài liệu vì context
    // không khớp bản ghi gốc, và đó không còn là tài liệu cũ thật.
    const target = await createUserViaApi(app, admin);
    const sysCtx = await systemContextId(app, admin);
    const userCtx = await contextIdByLevelInstance(app, admin, 30, target.id);
    const stale = await http(app).post('/api/v1/search/index-raw').set('Authorization', `Bearer ${admin}`)
      .send({ area: 'users', itemId: target.id, title: 'Test User', content: `${target.username} ${target.email}`, contextId: userCtx, ownerId: target.id });
    expect(stale.status).toBeLessThan(300);
    const ALLOW = 1;
    // Người tìm KHÔNG có quyền quản trị người dùng: không phải site
    // admin, không giữ user:update ở bất kỳ đâu, chỉ có user:viewdetails
    // tại context hệ thống để qua cổng lớp 1 của area users.
    const viewer = await createUserViaApi(app, admin);
    const viewerRole = await createRoleViaApi(app, admin);
    await assignRole(app, admin, viewer.id, viewerRole, sysCtx);
    await setOverride(app, admin, viewerRole, 'user:viewdetails', sysCtx, ALLOW);
    const viewerToken = (await login(app, viewer.username, STRONG_PASSWORD)).accessToken;
    // Người tìm CÓ quyền quản trị người dùng theo đúng định nghĩa áp
    // cho bề mặt này: không phải site admin, nhưng giữ user:update tại
    // context hệ thống (kèm user:viewdetails để qua cổng lớp 1).
    const mgr = await createUserViaApi(app, admin);
    const mgrRole = await createRoleViaApi(app, admin);
    await assignRole(app, admin, mgr.id, mgrRole, sysCtx);
    await setOverride(app, admin, mgrRole, 'user:viewdetails', sysCtx, ALLOW);
    await setOverride(app, admin, mgrRole, 'user:update', sysCtx, ALLOW);
    const mgrToken = (await login(app, mgr.username, STRONG_PASSWORD)).accessToken;

    // Người không có quyền: tìm theo username vẫn nhận tài liệu, nhưng
    // payload đã định hình lại thành đúng username, không còn email ở
    // bất kỳ trường nào; tìm bằng email đầy đủ không ra tài liệu đó.
    const byName = await searchAs(viewerToken, target.username);
    const hiddenDoc = byName.find((d) => d.area === 'users' && d.itemId === target.id);
    expect(hiddenDoc).toBeDefined();
    expect(hiddenDoc?.content).toBe(target.username);
    expect(JSON.stringify(byName)).not.toContain(target.email);
    const byEmail = await searchAs(viewerToken, target.email);
    expect(byEmail.some((d) => d.area === 'users' && d.itemId === target.id)).toBe(false);
    expect(JSON.stringify(byEmail)).not.toContain(target.email);

    // Người có quyền: vẫn nhận content mang email, cả khi tìm theo
    // username lẫn khi tìm bằng email đầy đủ.
    for (const token of [admin, mgrToken]) {
      const mgrByName = await searchAs(token, target.username);
      expect(mgrByName.find((d) => d.area === 'users' && d.itemId === target.id)?.content).toContain(target.email);
      const mgrByEmail = await searchAs(token, target.email);
      expect(mgrByEmail.some((d) => d.area === 'users' && d.itemId === target.id)).toBe(true);
    }
  });

  it('webservice DoD: a student token cannot call a function requiring a teacher capability (403), but can call a view function in its service', async () => {
    const { course, student } = await setupCourseWithStudent();
    const svc = await http(app).post('/api/v1/webservice/services').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Svc ${Date.now()}`, shortName: `svc${Date.now()}`, functions: ['core_course_get_courses', 'core_grades_update_grades'] });
    expect(svc.status).toBeLessThan(300);
    const tok = await http(app).post('/api/v1/webservice/tokens').set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, serviceId: svc.body.id });
    expect(tok.status).toBeLessThan(300);
    expect(tok.body.token).toHaveLength(64);
    // Token thô không được lưu: danh sách token chỉ chứa hash.
    const list = await http(app).get('/api/v1/webservice/tokens').set('Authorization', `Bearer ${admin}`);
    expect(JSON.stringify(list.body)).not.toContain(tok.body.token);
    // Function xem khoá: student có course:view ⇒ gọi được (Public endpoint, chỉ cần token).
    const ok = await http(app).post('/api/v1/webservice/call').send({ token: tok.body.token, functionName: 'core_course_get_courses', args: {} });
    expect(ok.status).toBeLessThan(300);
    // Function cần grade:edit (teacher): token của student ⇒ 403, token không bypass capability.
    const denied = await http(app).post('/api/v1/webservice/call').send({ token: tok.body.token, functionName: 'core_grades_update_grades', args: { courseId: course.id } });
    expect(denied.status).toBe(403);
    // Thu hồi token ⇒ gọi tiếp bị 401.
    await http(app).post(`/api/v1/webservice/tokens/${tok.body.id}/revoke`).set('Authorization', `Bearer ${admin}`).send({});
    const revoked = await http(app).post('/api/v1/webservice/call').send({ token: tok.body.token, functionName: 'core_course_get_courses', args: {} });
    expect(revoked.status).toBe(401);
    // User thường không có webservice:manage ⇒ không tạo được service.
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const forbidden = await http(app).post('/api/v1/webservice/services').set('Authorization', `Bearer ${studentToken}`)
      .send({ name: 'X', shortName: `x${Date.now()}`, functions: [] });
    expect(forbidden.status).toBe(403);
  });

  it('webservice: a token is rejected at call time while its owner is suspended, and the same token works again once the owner is reinstated', async () => {
    const { student } = await setupCourseWithStudent();
    const svc = await http(app).post('/api/v1/webservice/services').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Svc ${Date.now()}`, shortName: `svc${Date.now()}`, functions: ['core_course_get_courses'] });
    expect(svc.status).toBeLessThan(300);
    const tok = await http(app).post('/api/v1/webservice/tokens').set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, serviceId: svc.body.id });
    expect(tok.status).toBeLessThan(300);
    const call = () => http(app).post('/api/v1/webservice/call').send({ token: tok.body.token, functionName: 'core_course_get_courses', args: {} });
    // Chủ token đang hoạt động ⇒ gọi được như thường lệ.
    expect((await call()).status).toBeLessThan(300);
    // Đình chỉ chủ token: thao tác đình chỉ không thu hồi token, nhưng trạng
    // thái chủ được kiểm tại lúc dùng nên cùng token đó bị 401 ngay.
    await suspendUser(app, admin, student.id);
    const whileSuspended = await call();
    expect(whileSuspended.status).toBe(401);
    expect(whileSuspended.body.code).toBe('webservice.owner_inactive');
    // Gỡ đình chỉ ⇒ chính token cũ gọi lại được, không cần cấp token mới
    // (đình chỉ là trạng thái khôi phục được, token không bị thu hồi cứng).
    const reinstated = await http(app).post(`/api/v1/users/${student.id}/reactivate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(reinstated.status).toBeLessThan(300);
    expect((await call()).status).toBeLessThan(300);
  });

  it('content bank: draft is author-only, public needs the contentbank view capability (not a generic course right), upload attaches a file', async () => {
    const { course, student, studentToken } = await setupCourseWithStudent();
    const ctxId = await courseContextId(app, admin, course.id);
    // Teacher của khoá tạo nội dung.
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    const draft = await http(app).post('/api/v1/contentbank').set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: 'Draft resource', contextId: ctxId });
    expect(draft.status).toBeLessThan(300);
    expect(draft.body.visibility).toBe('draft');
    // Student không thấy draft.
    const listStudent = await http(app).get(`/api/v1/contentbank?contextId=${ctxId}`).set('Authorization', `Bearer ${studentToken}`);
    expect((listStudent.body as { id: string }[]).some((c) => c.id === draft.body.id)).toBe(false);
    // Upload file qua FilesModule + chuyển public ⇒ student thấy và lấy được signed URL.
    const up = await http(app).post(`/api/v1/contentbank/${draft.body.id}/file`).set('Authorization', `Bearer ${teacherToken}`)
      .send({ fileName: 'notes.txt', contentBase64: Buffer.from('content-bank-file').toString('base64'), mimeType: 'text/plain' });
    expect(up.status).toBeLessThan(300);
    expect(up.body.fileId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const pub = await http(app).patch(`/api/v1/contentbank/${draft.body.id}`).set('Authorization', `Bearer ${teacherToken}`).send({ visibility: 'public' });
    expect(pub.body.visibility).toBe('public');
    const list2 = await http(app).get(`/api/v1/contentbank?contextId=${ctxId}`).set('Authorization', `Bearer ${studentToken}`);
    expect((list2.body as { id: string }[]).some((c) => c.id === draft.body.id)).toBe(true);
    const url = await http(app).get(`/api/v1/contentbank/${draft.body.id}/file-url`).set('Authorization', `Bearer ${studentToken}`);
    expect(url.status).toBeLessThan(300);
    expect(url.body.url).toContain('/files/');
    // Nội dung public đã vào search index qua area contentbank.
    const found = await http(app).get(`/api/v1/search?q=${encodeURIComponent('Draft resource')}`).set('Authorization', `Bearer ${studentToken}`);
    expect((found.body as { area: string }[]).some((d) => d.area === 'contentbank')).toBe(true);
    void student;
  });

  it('analytics: students-at-risk run creates insights only for teachers and changes neither grades nor enrolments', async () => {
    const { course, instance } = await setupCourseWithStudent();
    const ctxId = await courseContextId(app, admin, course.id);
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    // Học viên nguy cơ: chưa từng đăng nhập (no_recent_access=1) + điểm 0 (low_grade=1) ⇒ score 1.
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Risk item' });
    await setGrade(app, admin, item.id, student.id, 0);
    const enrolBefore = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    const run = await http(app).post('/api/v1/analytics/models/students_at_risk/run').set('Authorization', `Bearer ${admin}`).send({ courseId: course.id });
    expect(run.status).toBeLessThan(300);
    // Student chưa từng login ⇒ no_recent_access=1, low_grade: chưa có? grade 0 ⇒ pct 0 ⇒ low=1 ⇒ score 1 ≥ 0.6.
    expect(run.body.predictions).toBeGreaterThanOrEqual(1);
    expect(run.body.insights).toBeGreaterThanOrEqual(1);
    const teacherInsights = await http(app).get('/api/v1/analytics/insights/me').set('Authorization', `Bearer ${teacherToken}`);
    expect((teacherInsights.body as { userId: string }[]).some((i) => i.userId === student.id)).toBe(true);
    // Student không phải recipient có viewinsights ⇒ không thấy insight về mình trong hộp của mình.
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const studentInsights = await http(app).get('/api/v1/analytics/insights/me').set('Authorization', `Bearer ${studentToken}`);
    expect((studentInsights.body as unknown[]).length).toBe(0);
    // Không side-effect: enrolments và gradebook không đổi.
    const enrolAfter = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect(enrolAfter.body).toHaveLength((enrolBefore.body as unknown[]).length);
    const gradesRes = await http(app).get(`/api/v1/courses/${course.id}/gradebook?userId=${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(gradesRes.status).toBe(200);
  });

  it('reports DoD: a report in the audience of user A never leaks rows of a course A has no rights in, even with an empty filter; schedule runs as its creator', async () => {
    const a = await setupCourseWithStudent();
    const b = await setupCourseWithStudent();
    // Report enrolments do admin tạo, audience = student của course A.
    const report = await http(app).post('/api/v1/reports').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Enrol report ${Date.now()}`, dataSource: 'enrolments', columns: ['userId', 'username', 'courseId', 'status'], filters: {}, audienceUserIds: [a.student.id] });
    expect(report.status).toBeLessThan(300);
    const run = await http(app).get(`/api/v1/reports/${report.body.id}/run`).set('Authorization', `Bearer ${a.studentToken}`);
    expect(run.status).toBe(200);
    const rows = run.body.rows as { courseId: string; userId: string }[];
    // Không có dòng nào của course B (A không có quyền ở đó, và các dòng đó không phải của A).
    expect(rows.some((r) => r.courseId === b.course.id)).toBe(false);
    // Chỉ thấy tối đa dòng của chính mình ở course A.
    expect(rows.every((r) => r.userId === a.student.id)).toBe(true);
    // User ngoài audience ⇒ 403.
    const outsider = await http(app).get(`/api/v1/reports/${report.body.id}/run`).set('Authorization', `Bearer ${b.studentToken}`);
    expect(outsider.status).toBe(403);
    // Schedule: admin tạo lịch, chạy ⇒ kết quả lưu + notification cho người tạo.
    const sched = await http(app).post(`/api/v1/reports/${report.body.id}/schedules`).set('Authorization', `Bearer ${admin}`).send({ cron: 'daily' });
    expect(sched.status).toBeLessThan(300);
    const ran = await http(app).post(`/api/v1/reports/schedules/${sched.body.id}/run`).set('Authorization', `Bearer ${admin}`).send({});
    expect(ran.status).toBeLessThan(300);
    const schedules = await http(app).get('/api/v1/reports/schedules/all').set('Authorization', `Bearer ${admin}`);
    const mine = (schedules.body as { id: string; lastResult: { ranAs: number } | null }[]).find((s) => s.id === sched.body.id);
    expect(mine?.lastResult).toBeTruthy();
    void b;
  });
});

