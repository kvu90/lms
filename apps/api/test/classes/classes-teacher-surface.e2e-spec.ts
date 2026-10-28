import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  STRONG_PASSWORD,
  createTestApp,
  createUserViaApi,
  http,
  login,
  roleIdByShortname,
  uniqueName,
} from '../support/identity-access-helpers';
import { createCategory } from '../support/course-enrolment-helpers';

/**
 * CLASS-1 (issue #184) — bề mặt giáo viên trên nền CLASS-0:
 *  (1) GV tự tạo lớp (class:create qua vai editingteacher tại tenant) và
 *      tạo khoá trong lớp; nạp HS theo ĐỊNH DANH khớp email → outcome
 *      matched + ghi danh ACTIVE ở khoá của lớp;
 *  (2) định danh chưa có tài khoản → tạo mới kèm mật khẩu tạm ĐĂNG NHẬP
 *      ĐƯỢC; nạp lại cùng định danh → already_member; thiếu cả email lẫn
 *      SĐT → 400 class.roster_identity_missing;
 *  (3) import JSON rows: báo cáo từng dòng — dòng tốt vào lớp, dòng lỗi
 *      đứng riêng, dòng trùng tính already_member;
 *  (4) import-file multipart + tải file mẫu .xlsx;
 *  (5) phân quyền tại lớp theo EMAIL: gán classgrader → xem được lớp
 *      nhưng nạp roster 403; gán classrostermanager → nạp được; sửa vai
 *      của chủ lớp → 400 class.owner_roles_locked; email không có tài
 *      khoản → 404;
 *  (6) tự báo danh: lớp trống vào thẳng; lớp đã có HS → hàng chờ; duyệt
 *      → vào roster + ACTIVE ở khoá; từ chối → không vào và được xin
 *      lại; joinAutoApprove → vào thẳng; mã sai → 404;
 *  (7) đình chỉ qua roster → hiện ở danh sách đã đình chỉ; thêm lại →
 *      biến mất khỏi danh sách đó và ACTIVE lại ở khoá.
 *  (8) dashboard theo lớp (CLASS-2): gói overview theo quan hệ người
 *      gọi; học sinh chỉ thấy khoá đang ghi danh ACTIVE.
 *  (9) issue #381: đáp số GET /classes kèm bốn cờ quyền suy cho đúng
 *      người gọi (chủ lớp đủ cờ; học viên và đồng GV chấm bài không
 *      cờ quản trị nào) và học viên gọi thẳng POST/PATCH/archive/
 *      DELETE lớp đều 403 — cờ chỉ phục vụ hiển thị, gác thật ở API.
 *  (10) issue #381: roster thu hẹp trường liên hệ — chủ lớp và đồng
 *      GV quản roster nhận email/username đầy đủ; đồng GV chấm bài
 *      và học viên trong lớp chỉ nhận họ tên, hai trường liên hệ bị
 *      làm rỗng ở phía server.
 */
describe('class teacher surface (CLASS-1, #184)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin = '';
  let teacher = '';
  let teacherId = '';
  let coTeacher = '';
  let coTeacherId = '';
  let coTeacherEmail = '';
  let rosterMgr = '';
  let rosterMgrId = '';
  let knownStudent = '';
  let knownStudentId = '';
  let knownStudentEmail = '';
  let joinerA = '';
  let joinerAId = '';
  let joinerB = '';
  let joinerBId = '';
  let joinerCId = '';
  let categoryId = '';
  let classId = '';
  let courseId = '';
  let joinCode = '';

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const must = async (res: { status: number; body: unknown }, what: string) => {
    if (res.status < 200 || res.status >= 300) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as never;
  };

  async function cohortUeStatus(courseId: string, userId: string): Promise<number | undefined> {
    const rows = await pg.query<{ status: number }>(
      `select ue.status from user_enrolments ue join enrol e on e.id = ue.enrol_id
        where e.course_id = $1 and e.enrol = 'cohort' and ue.user_id = $2`,
      [courseId, userId],
    );
    return rows.rows[0]?.status;
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = (await login(app, 'admin', 'Admin123!')).accessToken;

    const teacherUser = await createUserViaApi(app, admin);
    teacherId = teacherUser.id;
    const coUser = await createUserViaApi(app, admin);
    coTeacherId = coUser.id;
    coTeacherEmail = coUser.email;
    const mgrUser = await createUserViaApi(app, admin);
    rosterMgrId = mgrUser.id;
    const known = await createUserViaApi(app, admin, { firstName: 'Biết', lastName: 'Đã' });
    knownStudentId = known.id;
    knownStudentEmail = known.email;
    const ja = await createUserViaApi(app, admin);
    joinerAId = ja.id;
    const jb = await createUserViaApi(app, admin);
    joinerBId = jb.id;
    const jc = await createUserViaApi(app, admin);
    joinerCId = jc.id;

    teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    coTeacher = (await login(app, coUser.username, STRONG_PASSWORD)).accessToken;
    rosterMgr = (await login(app, mgrUser.username, STRONG_PASSWORD)).accessToken;
    knownStudent = (await login(app, known.username, STRONG_PASSWORD)).accessToken;
    joinerA = (await login(app, ja.username, STRONG_PASSWORD)).accessToken;
    joinerB = (await login(app, jb.username, STRONG_PASSWORD)).accessToken;

    const current = await must(await http(app).get('/api/v1/tenants/current').set(auth(admin)), 'current tenant') as { id: string };
    for (const userId of [teacherId, coTeacherId, rosterMgrId, knownStudentId, joinerAId, joinerBId, joinerCId]) {
      await http(app).post(`/api/v1/tenants/${current.id}/members`).set(auth(admin)).send({ userId });
    }
    // GV tạo được lớp của mình: vai editingteacher tại context tenant
    // mang archetype có class:create (đúng đường GV thật trên seed).
    const tenantCtx = await pg.query<{ id: string }>('select id from context where context_level = 20 and instance_id = $1', [current.id]);
    const editingTeacherRoleId = await roleIdByShortname(app, admin, 'editingteacher');
    await must(
      await http(app).post('/api/v1/access/assignments').set(auth(admin))
        .send({ userId: teacherId, roleId: editingTeacherRoleId, contextId: tenantCtx.rows[0]!.id }),
      'assign editingteacher at tenant',
    );

    categoryId = (await createCategory(app, admin)).id;
  });

  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  it('(1) GV tự tạo lớp + khoá trong lớp; nạp HS theo email khớp tài khoản có sẵn → matched + ACTIVE ở khoá', async () => {
    const cls = await must(
      await http(app).post('/api/v1/classes').set(auth(teacher)).send({ name: uniqueName('Lớp CLASS-1') }),
      'teacher creates class',
    ) as { id: string };
    classId = cls.id;

    const course = await must(
      await http(app).post('/api/v1/courses').set(auth(teacher)).send({
        fullName: uniqueName('Khoá trong lớp'), shortName: uniqueName('K'), category: categoryId, classId,
      }),
      'create course in class',
    ) as { id: string };
    courseId = course.id;

    const added = await must(
      await http(app).post(`/api/v1/classes/${classId}/roster/identity`).set(auth(teacher))
        .send({ fullName: 'Đã Biết', email: knownStudentEmail }),
      'add by identity (email match)',
    ) as { outcome: string; userId: string; temporaryPassword: string | null };
    expect(added.outcome).toBe('matched');
    expect(added.userId).toBe(knownStudentId);
    expect(added.temporaryPassword).toBeNull();
    expect(await cohortUeStatus(courseId, knownStudentId)).toBe(0);
  });

  it('(2) định danh mới → created + mật khẩu tạm đăng nhập được; nạp lại → already_member; thiếu định danh → 400', async () => {
    const email = `${uniqueName('hs')}@example.com`;
    const created = await must(
      await http(app).post(`/api/v1/classes/${classId}/roster/identity`).set(auth(teacher))
        .send({ fullName: 'Học Sinh Mới', email, phone: '0901234999' }),
      'add by identity (create)',
    ) as { outcome: string; username: string; temporaryPassword: string | null };
    expect(created.outcome).toBe('created');
    expect(created.temporaryPassword).toBeTruthy();
    const session = await login(app, created.username, created.temporaryPassword!);
    expect(session.accessToken).toBeTruthy();

    const again = await must(
      await http(app).post(`/api/v1/classes/${classId}/roster/identity`).set(auth(teacher))
        .send({ fullName: 'Học Sinh Mới', email }),
      'add same identity again',
    ) as { outcome: string };
    expect(again.outcome).toBe('already_member');

    const noIdentity = await http(app).post(`/api/v1/classes/${classId}/roster/identity`).set(auth(teacher))
      .send({ fullName: 'Không Định Danh' });
    expect(noIdentity.status).toBe(400);
    expect((noIdentity.body as { code?: string }).code).toBe('class.roster_identity_missing');
  });

  it('(3) import rows: báo cáo từng dòng — tốt vào lớp, trùng tính already, lỗi đứng riêng', async () => {
    const newEmail = `${uniqueName('import')}@example.com`;
    const report = await must(
      await http(app).post(`/api/v1/classes/${classId}/roster/import`).set(auth(teacher)).send({
        rows: [
          { fullName: 'Dòng Tốt', email: newEmail },
          { fullName: 'Dòng Trùng', email: knownStudentEmail },
          { fullName: 'Dòng Lỗi' },
        ],
      }),
      'import rows',
    ) as {
      total: number; added: number; created: number; alreadyMembers: number; failed: number;
      results: { row: number; status: string; error: string | null }[];
    };
    expect(report.total).toBe(3);
    expect(report.added).toBe(1);
    expect(report.created).toBe(1);
    expect(report.alreadyMembers).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results.map((r) => r.status)).toEqual(['added_created', 'already_member', 'error']);
    expect(report.results[2]!.error).toBe('class.roster_identity_missing');
  });

  it('(4) tải file mẫu .xlsx + import-file multipart đọc đúng các dòng của sheet', async () => {
    const template = await http(app).get('/api/v1/classes/roster-template').set(auth(teacher));
    expect(template.status).toBe(200);
    expect(String(template.headers['content-type'])).toContain('spreadsheetml');

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Danh sách học sinh');
    sheet.addRow(['Họ tên', 'Số điện thoại', 'Email', 'Ngày sinh']);
    const fileEmail = `${uniqueName('file')}@example.com`;
    sheet.addRow(['Từ File Một', '', fileEmail, '']);
    sheet.addRow(['Từ File Hai', '0907777888', '', '']);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const report = await http(app).post(`/api/v1/classes/${classId}/roster/import-file`).set(auth(teacher))
      .attach('file', buffer, 'roster.xlsx');
    expect(report.status, JSON.stringify(report.body)).toBe(201);
    const body = report.body as { total: number; added: number; failed: number };
    expect(body.total).toBe(2);
    expect(body.added).toBe(2);
    expect(body.failed).toBe(0);
  });

  it('(5) phân quyền theo email: grader xem được nhưng nạp roster 403; roster manager nạp được; chủ lớp bị khoá sửa vai', async () => {
    const view = await must(
      await http(app).post(`/api/v1/classes/${classId}/staff`).set(auth(teacher))
        .send({ email: coTeacherEmail, roles: ['classgrader'] }),
      'assign grader by email',
    ) as { staff: { userId: string; roles: string[] }[] };
    expect(view.staff.find((s) => s.userId === coTeacherId)?.roles).toEqual(['classgrader']);

    const graderView = await http(app).get(`/api/v1/classes/${classId}`).set(auth(coTeacher));
    expect(graderView.status).toBe(200);
    const graderAdd = await http(app).post(`/api/v1/classes/${classId}/roster/identity`).set(auth(coTeacher))
      .send({ fullName: 'Không Được', email: `${uniqueName('nope')}@example.com` });
    expect(graderAdd.status).toBe(403);

    await must(
      await http(app).post(`/api/v1/classes/${classId}/staff`).set(auth(teacher))
        .send({ userId: rosterMgrId, roles: ['classrostermanager'] }),
      'assign roster manager',
    );
    const mgrAdd = await http(app).post(`/api/v1/classes/${classId}/roster/identity`).set(auth(rosterMgr))
      .send({ fullName: 'Mgr Thêm', email: `${uniqueName('mgr')}@example.com` });
    expect(mgrAdd.status).toBe(201);

    const ownerEdit = await http(app).post(`/api/v1/classes/${classId}/staff`).set(auth(teacher))
      .send({ userId: teacherId, roles: [] });
    expect(ownerEdit.status).toBe(400);
    expect((ownerEdit.body as { code?: string }).code).toBe('class.owner_roles_locked');

    const ghost = await http(app).post(`/api/v1/classes/${classId}/staff`).set(auth(teacher))
      .send({ email: `${uniqueName('ghost')}@example.com`, roles: ['classgrader'] });
    expect(ghost.status).toBe(404);
  });

  it('(6) tự báo danh: lớp trống vào thẳng, lớp có HS vào hàng chờ; duyệt/từ chối đúng luật; tự duyệt vào thẳng; mã sai 404', async () => {
    // Lớp thứ hai, đang trống roster.
    const cls2 = await must(
      await http(app).post('/api/v1/classes').set(auth(teacher))
        .send({ name: uniqueName('Lớp tự báo danh') }),
      'create join class',
    ) as { id: string };
    const patched = await must(
      await http(app).patch(`/api/v1/classes/${cls2.id}`).set(auth(teacher)).send({ allowSelfReport: true }),
      'enable self report',
    ) as { joinCode: string | null };
    expect(patched.joinCode).toBeTruthy();
    joinCode = patched.joinCode!;

    const preview = await must(
      await http(app).get(`/api/v1/classes/join-preview?code=${joinCode}`).set(auth(joinerA)),
      'preview join',
    ) as { name: string };
    expect(preview.name).toBeTruthy();

    const first = await must(
      await http(app).post('/api/v1/classes/join').set(auth(joinerA)).send({ joinCode }),
      'first joiner joins empty class',
    ) as { outcome: string };
    expect(first.outcome).toBe('joined');

    const second = await must(
      await http(app).post('/api/v1/classes/join').set(auth(joinerB)).send({ joinCode }),
      'second joiner waits',
    ) as { outcome: string };
    expect(second.outcome).toBe('pending');
    const rosterBefore = await must(await http(app).get(`/api/v1/classes/${cls2.id}/roster`).set(auth(teacher)), 'roster before approve') as { userId: string }[];
    expect(rosterBefore.map((m) => m.userId)).not.toContain(joinerBId);

    const requests = await must(
      await http(app).get(`/api/v1/classes/${cls2.id}/join-requests`).set(auth(teacher)),
      'list join requests',
    ) as { id: string; userId: string; status: string }[];
    const pendingB = requests.find((r) => r.userId === joinerBId && r.status === 'pending');
    expect(pendingB).toBeTruthy();
    await must(
      await http(app).post(`/api/v1/classes/${cls2.id}/join-requests/${pendingB!.id}/approve`).set(auth(teacher)).send({}),
      'approve B',
    );
    const rosterAfter = await must(await http(app).get(`/api/v1/classes/${cls2.id}/roster`).set(auth(teacher)), 'roster after approve') as { userId: string }[];
    expect(rosterAfter.map((m) => m.userId)).toContain(joinerBId);

    // C xin vào → chờ → bị từ chối → vẫn ngoài roster, xin lại được.
    const cJoin = await must(await http(app).post('/api/v1/classes/join').set(auth(knownStudent)).send({ joinCode }), 'C joins') as { outcome: string };
    expect(cJoin.outcome).toBe('pending');
    const requests2 = await must(await http(app).get(`/api/v1/classes/${cls2.id}/join-requests`).set(auth(teacher)), 'list requests 2') as { id: string; userId: string; status: string }[];
    const pendingC = requests2.find((r) => r.userId === knownStudentId && r.status === 'pending');
    await must(await http(app).post(`/api/v1/classes/${cls2.id}/join-requests/${pendingC!.id}/reject`).set(auth(teacher)).send({}), 'reject C');
    const rosterFinal = await must(await http(app).get(`/api/v1/classes/${cls2.id}/roster`).set(auth(teacher)), 'roster after reject') as { userId: string }[];
    expect(rosterFinal.map((m) => m.userId)).not.toContain(knownStudentId);
    const cAgain = await must(await http(app).post('/api/v1/classes/join').set(auth(knownStudent)).send({ joinCode }), 'C joins again') as { outcome: string };
    expect(cAgain.outcome).toBe('pending');

    const bad = await http(app).post('/api/v1/classes/join').set(auth(joinerA)).send({ joinCode: 'MA-KHONG-CO-123' });
    expect(bad.status).toBe(404);

    // Lớp bật tự duyệt: vào thẳng kể cả đã có học sinh.
    const cls3 = await must(
      await http(app).post('/api/v1/classes').set(auth(teacher)).send({ name: uniqueName('Lớp tự duyệt') }),
      'create auto-approve class',
    ) as { id: string };
    const patched3 = await must(
      await http(app).patch(`/api/v1/classes/${cls3.id}`).set(auth(teacher)).send({ allowSelfReport: true, joinAutoApprove: true }),
      'enable auto approve',
    ) as { joinCode: string | null };
    await must(await http(app).post('/api/v1/classes/join').set(auth(joinerA)).send({ joinCode: patched3.joinCode }), 'A joins auto class');
    const bAuto = await must(await http(app).post('/api/v1/classes/join').set(auth(joinerB)).send({ joinCode: patched3.joinCode }), 'B joins auto class') as { outcome: string };
    expect(bAuto.outcome).toBe('joined');
  });

  it('(7) đình chỉ qua roster → hiện ở danh sách đã đình chỉ; thêm lại → kích hoạt lại (ACTIVE ở khoá, mất khỏi danh sách đình chỉ)', async () => {
    const removed = await http(app).delete(`/api/v1/classes/${classId}/roster/${knownStudentId}`).set(auth(teacher));
    expect(removed.status).toBe(200);
    expect(await cohortUeStatus(courseId, knownStudentId)).toBe(1);

    const suspended = await must(
      await http(app).get(`/api/v1/classes/${classId}/roster/suspended`).set(auth(teacher)),
      'list suspended',
    ) as { userId: string }[];
    expect(suspended.map((m) => m.userId)).toContain(knownStudentId);

    await must(await http(app).post(`/api/v1/classes/${classId}/roster`).set(auth(teacher)).send({ userId: knownStudentId }), 'reactivate');
    expect(await cohortUeStatus(courseId, knownStudentId)).toBe(0);
    const suspendedAfter = await must(
      await http(app).get(`/api/v1/classes/${classId}/roster/suspended`).set(auth(teacher)),
      'list suspended after reactivate',
    ) as { userId: string }[];
    expect(suspendedAfter.map((m) => m.userId)).not.toContain(knownStudentId);
  });

  it('(8) dashboard theo lớp (CLASS-2): gói overview đúng theo quan hệ của người gọi; học sinh chỉ thấy khoá mình đang ghi danh ACTIVE', async () => {
    type Overview = {
      class: { id: string; joinCode: string | null };
      viewerRole: string;
      canManageRoster: boolean;
      canShare: boolean;
      rosterCount: number;
      courses: { id: string }[];
    };

    // Chủ lớp: vai owner, đủ cờ quản trị, thấy mọi khoá trong lớp và
    // tổng số học sinh đúng bằng roster thật.
    const ownerView = await must(
      await http(app).get(`/api/v1/classes/${classId}/overview`).set(auth(teacher)),
      'owner overview',
    ) as Overview;
    expect(ownerView.viewerRole).toBe('owner');
    expect(ownerView.canManageRoster).toBe(true);
    expect(ownerView.canShare).toBe(true);
    expect(ownerView.courses.map((c) => c.id)).toContain(courseId);
    const rosterNow = await must(
      await http(app).get(`/api/v1/classes/${classId}/roster`).set(auth(teacher)),
      'roster for count check',
    ) as unknown[];
    expect(ownerView.rosterCount).toBe(rosterNow.length);
    expect(Object.keys(ownerView).sort()).toEqual(['canManageRoster', 'canShare', 'class', 'courses', 'rosterCount', 'viewerRole']);

    // Đồng GV được gán vai chấm bài ở ca (5): vai staff, không quản
    // roster, vẫn thấy mọi khoá của lớp để điều hướng.
    const staffView = await must(
      await http(app).get(`/api/v1/classes/${classId}/overview`).set(auth(coTeacher)),
      'co-teacher overview',
    ) as Overview;
    expect(staffView.viewerRole).toBe('staff');
    expect(staffView.canManageRoster).toBe(false);
    expect(staffView.canShare).toBe(false);
    expect(staffView.courses.map((c) => c.id)).toContain(courseId);

    // Học sinh trong roster: vai member, không cờ quản trị nào, mã
    // vào lớp bị ẩn, và chỉ thấy đúng khoá mình đang ghi danh ACTIVE.
    const memberView = await must(
      await http(app).get(`/api/v1/classes/${classId}/overview`).set(auth(knownStudent)),
      'student overview',
    ) as Overview;
    expect(memberView.viewerRole).toBe('member');
    expect(memberView.canManageRoster).toBe(false);
    expect(memberView.canShare).toBe(false);
    expect(memberView.class.joinCode).toBeNull();
    expect(memberView.courses.map((c) => c.id)).toEqual([courseId]);

    // Đình chỉ học sinh ở CHÍNH khoá đó (qua phương thức cohort) →
    // khoá biến mất khỏi gói của học sinh dù em vẫn còn trong roster;
    // kích hoạt lại thì khoá trở lại. Đây là bất biến "chỉ khoá đang
    // học" của dashboard phía học sinh.
    const instances = await must(
      await http(app).get(`/api/v1/courses/${courseId}/enrol/instances`).set(auth(teacher)),
      'list enrol instances',
    ) as { id: string; enrol: string }[];
    const cohortInstance = instances.find((i) => i.enrol === 'cohort');
    expect(cohortInstance).toBeDefined();
    await must(
      await http(app).post(`/api/v1/courses/${courseId}/enrol/instances/${cohortInstance!.id}/users/${knownStudentId}/suspend`).set(auth(teacher)),
      'suspend student in course',
    );
    const suspendedView = await must(
      await http(app).get(`/api/v1/classes/${classId}/overview`).set(auth(knownStudent)),
      'student overview after course suspend',
    ) as Overview;
    expect(suspendedView.viewerRole).toBe('member');
    expect(suspendedView.courses).toEqual([]);
    await must(
      await http(app).post(`/api/v1/courses/${courseId}/enrol/instances/${cohortInstance!.id}/users/${knownStudentId}/reactivate`).set(auth(teacher)),
      'reactivate student in course',
    );
    const restoredView = await must(
      await http(app).get(`/api/v1/classes/${classId}/overview`).set(auth(knownStudent)),
      'student overview after reactivate',
    ) as Overview;
    expect(restoredView.courses.map((c) => c.id)).toEqual([courseId]);

    // Người ngoài lớp (tài khoản mới, chưa từng có quan hệ gì với
    // lớp này): 404 như mọi đường đọc của lớp, không lộ sự tồn tại
    // của lớp.
    const outsiderUser = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsiderUser.username, STRONG_PASSWORD)).accessToken;
    const outsider = await http(app).get(`/api/v1/classes/${classId}/overview`).set(auth(outsiderToken));
    expect(outsider.status).toBe(404);
  });

  it('(9) danh sách lớp kèm cờ quyền theo người gọi (issue #381); học viên gọi các mutation của lớp đều 403', async () => {
    type ListItem = {
      id: string; canCreate: boolean; canUpdate: boolean; canDelete: boolean; canManageRoster: boolean;
    };

    // Chủ lớp: đủ cả bốn cờ cho lớp của mình.
    const ownerList = await must(await http(app).get('/api/v1/classes').set(auth(teacher)), 'owner class list') as ListItem[];
    const ownerItem = ownerList.find((c) => c.id === classId);
    expect(ownerItem).toBeTruthy();
    expect(ownerItem).toMatchObject({ canCreate: true, canUpdate: true, canDelete: true, canManageRoster: true });

    // Học sinh trong roster: thấy lớp của mình nhưng mọi cờ quản trị
    // (kể cả khả năng tạo lớp ở cấp tenant) đều false.
    const memberList = await must(await http(app).get('/api/v1/classes').set(auth(knownStudent)), 'member class list') as ListItem[];
    const memberItem = memberList.find((c) => c.id === classId);
    expect(memberItem).toBeTruthy();
    expect(memberItem).toMatchObject({ canCreate: false, canUpdate: false, canDelete: false, canManageRoster: false });

    // Đồng GV chỉ có vai chấm bài: thấy lớp, không cờ quản trị nào.
    const graderList = await must(await http(app).get('/api/v1/classes').set(auth(coTeacher)), 'grader class list') as ListItem[];
    const graderItem = graderList.find((c) => c.id === classId);
    expect(graderItem).toBeTruthy();
    expect(graderItem).toMatchObject({ canCreate: false, canUpdate: false, canDelete: false, canManageRoster: false });

    // Cờ chỉ là hiển thị — gác thật ở API không đổi: học viên gọi
    // thẳng cả bốn mutation của lớp đều bị chặn 403.
    const create = await http(app).post('/api/v1/classes').set(auth(knownStudent)).send({ name: uniqueName('Lớp của học viên') });
    expect(create.status).toBe(403);
    const patch = await http(app).patch(`/api/v1/classes/${classId}`).set(auth(knownStudent)).send({ name: 'Đổi tên lén' });
    expect(patch.status).toBe(403);
    const archive = await http(app).post(`/api/v1/classes/${classId}/archive`).set(auth(knownStudent)).send({});
    expect(archive.status).toBe(403);
    const remove = await http(app).delete(`/api/v1/classes/${classId}`).set(auth(knownStudent));
    expect(remove.status).toBe(403);
  });

  it('(10) roster thu hẹp trường liên hệ theo quyền quản roster (issue #381)', async () => {
    type RosterEntry = { userId: string; firstName: string; lastName: string; username: string; email: string };

    // Chủ lớp: đáp số đầy đủ như trước — email/username của học sinh có mặt.
    const ownerRoster = await must(await http(app).get(`/api/v1/classes/${classId}/roster`).set(auth(teacher)), 'owner roster') as RosterEntry[];
    const ownerEntry = ownerRoster.find((m) => m.userId === knownStudentId);
    expect(ownerEntry).toBeTruthy();
    expect(ownerEntry!.email).toBe(knownStudentEmail);
    expect(ownerEntry!.username).toBeTruthy();

    // Đồng GV được gán vai quản roster ở ca (5): cũng nhận đáp số đầy đủ.
    const mgrRoster = await must(await http(app).get(`/api/v1/classes/${classId}/roster`).set(auth(rosterMgr)), 'roster manager roster') as RosterEntry[];
    expect(mgrRoster.find((m) => m.userId === knownStudentId)?.email).toBe(knownStudentEmail);

    // Đồng GV chỉ có vai chấm bài (không quản roster): đọc được danh
    // sách theo tên nhưng email/username của mọi dòng đều bị làm rỗng.
    const graderRoster = await must(await http(app).get(`/api/v1/classes/${classId}/roster`).set(auth(coTeacher)), 'grader roster') as RosterEntry[];
    expect(graderRoster.length).toBeGreaterThan(0);
    for (const entry of graderRoster) {
      expect(entry.email).toBe('');
      expect(entry.username).toBe('');
    }
    const graderEntry = graderRoster.find((m) => m.userId === knownStudentId);
    expect(graderEntry).toBeTruthy();
    expect(`${graderEntry!.lastName} ${graderEntry!.firstName}`).toBe('Đã Biết');

    // Học sinh trong lớp: vẫn đọc được danh sách bạn học theo tên,
    // không dòng nào kèm trường liên hệ.
    const memberRoster = await must(await http(app).get(`/api/v1/classes/${classId}/roster`).set(auth(knownStudent)), 'member roster') as RosterEntry[];
    expect(memberRoster.map((m) => m.userId)).toContain(knownStudentId);
    for (const entry of memberRoster) {
      expect(entry.email).toBe('');
      expect(entry.username).toBe('');
    }
  });
});
