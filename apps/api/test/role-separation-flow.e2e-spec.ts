import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoleSeparationService } from '../src/modules/access/role-separation.service';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, hasCapability, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';

/**
 * Tách vai giáo viên/học viên theo ngữ cảnh (issue #425).
 *
 * Quyết định áp dụng (viết trọn vẹn): vai trò phải rõ ràng theo ngữ
 * cảnh — trong khoá một tài khoản ghi danh học thì tài khoản đó thuần
 * là học viên của khoá đó; trong khoá mình dạy thì thuần giáo viên.
 * Đường giáo viên tham gia khoá/lớp KHÁC được giữ (hai tập khoá không
 * giao nhau). Điều bị cấm tuyệt đối là LẪN VAI CÙNG MỘT KHOÁ/LỚP: một
 * tài khoản đồng thời có cấp quyền giảng dạy bao phủ một khoá và ghi
 * danh học viên đang hoạt động trong chính khoá đó (hoặc lớp chứa
 * khoá đó).
 *
 * Định nghĩa dùng chung duy nhất ở RoleSeparationService (tầng
 * Access):
 * - Kiểm (a): tồn tại gán vai archetype editingteacher/teacher KHÔNG
 *   do ghi danh cấp (component <> 'enrol') tại một context trên
 *   đường tổ tiên của context khoá (trừ context hệ thống).
 * - Kiểm (b): tồn tại user_enrolments status = 0 qua một enrol
 *   instance của khoá mà vai cấp kèm không thuộc archetype giảng dạy.
 *
 * Các ca dưới đây khoá hành vi ở BA funnel ghi danh và chốt chiều
 * ngược:
 *  1. Funnel 1 — ghi danh tay giáo viên vào chính khoá mình dạy qua
 *     EnrolService.enrolUserInternal: bị từ chối
 *     `access.role_context_conflict`, không tạo ghi danh, không gán
 *     vai học viên.
 *  2. Funnel 2 — thêm roster lớp bằng EMAIL của chính chủ lớp qua
 *     GroupsService.addCohortMember: bị từ chối cùng mã; chủ lớp
 *     không vào cohort, không có ghi danh ở khoá của lớp; học sinh
 *     thường vẫn nạp được (đối chứng dương).
 *  3. Đối chứng giữ đường tham gia: giáo viên ghi danh vào khoá
 *     KHÔNG liên quan vẫn thành công và ở khoá đó chỉ là học viên
 *     (không có grade:viewall).
 *  4. Chiều ngược — gán vai giảng dạy tại context khoá và context
 *     lớp cho học viên đang học đang hoạt động trong khoá bị bao
 *     phủ: bị từ chối cùng mã; gán cho người không có ghi danh như
 *     vậy vẫn thành công (đối chứng dương).
 *  5. Funnel 3 — restore backup chứa ghi danh của người đang dạy
 *     khoá đích: restore hoàn tất, ghi danh vi phạm bị bỏ qua và
 *     được đếm vào chi tiết bước restore
 *     (skippedRoleConflictEnrolments = 1), ghi danh hợp lệ trong
 *     cùng backup vẫn được khôi phục.
 *  6. Đường kích hoạt lại ghi danh đã đình chỉ: gán vai giảng dạy
 *     trong lúc ghi danh đang đình chỉ là hợp lệ (ghi danh chưa hoạt
 *     động), nhưng kích hoạt lại sau đó bị từ chối cùng mã và ghi
 *     danh giữ nguyên trạng thái đình chỉ.
 *  7. Kiểm toán chỉ đọc: dữ kiện lẫn vai dựng thẳng vào DB (mô
 *     phỏng dữ kiện có sẵn trước khi có chốt) được phân loại vào
 *     NHÓM CÙNG KHOÁ; tài khoản dạy khoá này học khoá khác vào
 *     NHÓM KHÁC KHOÁ; lượt kiểm toán không ghi bất kỳ dữ kiện nào.
 */
describe('Role separation by context (#425)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin: string;
  let categoryId: string;
  let studentRoleId: string;
  let editingTeacherRoleId: string;
  let teacherRoleId: string;

  // Định danh dùng chung giữa các ca (ca kiểm toán ở cuối đọc lại
  // trạng thái của các ca trước).
  let ownCourseTeacherId: string;
  let crossCourseTeacherId: string;
  let classOwnerId: string;

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = await adminToken(app);
    categoryId = (await createCategory(app, admin)).id;
    studentRoleId = await roleIdByShortname(app, admin, 'student');
    editingTeacherRoleId = await roleIdByShortname(app, admin, 'editingteacher');
    teacherRoleId = await roleIdByShortname(app, admin, 'teacher');
  });
  afterAll(async () => {
    await pg.end();
    await app.close();
  });

  async function courseContextId(courseId: string): Promise<string> {
    const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set('Authorization', `Bearer ${admin}`);
    expect(content.status).toBe(200);
    return content.body.contextId as string;
  }

  async function contextIdByLevelInstance(level: number, instanceId: string): Promise<string> {
    const rows = await pg.query<{ id: string }>(
      'select id from context where context_level = $1 and instance_id = $2',
      [level, instanceId],
    );
    if (!rows.rows[0]) throw new Error(`context not found for level ${level} instance ${instanceId}`);
    return rows.rows[0].id;
  }

  interface AssignmentRow { id: string; roleId: string; component: string; itemId: string | null }

  async function assignmentsOf(userId: string, contextId: string): Promise<AssignmentRow[]> {
    const res = await http(app).get('/api/v1/access/assignments')
      .query({ userId, contextId }).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as AssignmentRow[];
  }

  async function enrolmentCount(courseId: string, userId: string): Promise<number> {
    const rows = await pg.query<{ n: string }>(
      `select count(*)::text as n from user_enrolments ue join enrol e on e.id = ue.enrol_id
        where e.course_id = $1 and ue.user_id = $2`,
      [courseId, userId],
    );
    return Number(rows.rows[0]!.n);
  }

  it('funnel 1: manual enrolment of a teacher into their own course is rejected and leaves no enrolment or learner role', async () => {
    const teacher = await createUserViaApi(app, admin);
    ownCourseTeacherId = teacher.id;
    const course = await createCourse(app, admin, categoryId);
    const ctxId = await courseContextId(course.id);
    await assignRole(app, admin, teacher.id, editingTeacherRoleId, ctxId);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });

    const blocked = await http(app)
      .post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/enrol`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ userId: teacher.id });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('access.role_context_conflict');

    // Không bản ghi ghi danh, không dòng gán vai học viên nào được tạo.
    expect(await enrolmentCount(course.id, teacher.id)).toBe(0);
    const rows = await assignmentsOf(teacher.id, ctxId);
    expect(rows.filter((a) => a.roleId === studentRoleId)).toHaveLength(0);

    const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`)
      .set('Authorization', `Bearer ${teacherLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: false, active: false });
  });

  it('funnel 2: adding the class owner to their own roster by email is rejected; a regular student is still added', async () => {
    const owner = await createUserViaApi(app, admin);
    classOwnerId = owner.id;
    const ownerLogin = await login(app, owner.username, STRONG_PASSWORD);
    const ownerToken = ownerLogin.accessToken;

    // Chủ lớp phải là thành viên tenant và giữ vai editingteacher tại
    // context tenant — đúng đường giáo viên thật tạo lớp của mình.
    const current = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${admin}`);
    const tenantId = current.body.id as string;
    await http(app).post(`/api/v1/tenants/${tenantId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: owner.id });
    const tenantCtxId = await contextIdByLevelInstance(20, tenantId);
    await assignRole(app, admin, owner.id, editingTeacherRoleId, tenantCtxId);

    const cls = await http(app).post('/api/v1/classes').set('Authorization', `Bearer ${ownerToken}`).send({ name: `Role separation class ${Date.now().toString(36)}` });
    expect(cls.status).toBe(201);
    const classId = cls.body.id as string;
    const course = await http(app).post('/api/v1/courses').set('Authorization', `Bearer ${ownerToken}`).send({
      fullName: 'Course in owner class', shortName: `rs${Date.now().toString(36)}`, category: categoryId, classId,
    });
    expect(course.status).toBe(201);
    const courseId = course.body.id as string;

    // Email của chính chủ lớp khớp tài khoản có sẵn — chốt funnel 2
    // phải chặn trước khi dòng thành viên cohort được tạo.
    const blocked = await http(app).post(`/api/v1/classes/${classId}/roster/identity`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fullName: 'Class Owner', email: owner.email });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('access.role_context_conflict');

    const cohort = await pg.query<{ cohort_id: string }>('select cohort_id from classes where id = $1', [classId]);
    const memberRows = await pg.query(
      'select 1 from cohort_members where cohort_id = $1 and user_id = $2',
      [cohort.rows[0]!.cohort_id, owner.id],
    );
    expect(memberRows.rowCount).toBe(0);
    expect(await enrolmentCount(courseId, owner.id)).toBe(0);

    // Đối chứng dương: học sinh thường nạp bằng email vẫn vào lớp và
    // được ghi danh xuống khoá của lớp.
    const student = await createUserViaApi(app, admin);
    const added = await http(app).post(`/api/v1/classes/${classId}/roster/identity`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ fullName: 'Regular Student', email: student.email });
    expect(added.status).toBe(201);
    expect(added.body.outcome).toBe('matched');
    expect(added.body.userId).toBe(student.id);
    const studentMember = await pg.query(
      'select 1 from cohort_members where cohort_id = $1 and user_id = $2',
      [cohort.rows[0]!.cohort_id, student.id],
    );
    expect(studentMember.rowCount).toBe(1);
  });

  it('a teacher may still enrol as a learner in an unrelated course, and there holds no teaching surface', async () => {
    const teacher = await createUserViaApi(app, admin);
    crossCourseTeacherId = teacher.id;
    const taught = await createCourse(app, admin, categoryId);
    const taughtCtx = await courseContextId(taught.id);
    await assignRole(app, admin, teacher.id, editingTeacherRoleId, taughtCtx);

    const learned = await createCourse(app, admin, categoryId);
    const learnedCtx = await courseContextId(learned.id);
    const instance = await createEnrolInstance(app, admin, learned.id, { method: 'manual' });
    await enrolUser(app, admin, learned.id, instance.id, teacher.id);

    // Ở khoá đang học: thuần học viên — không grade:viewall, nhưng
    // vào được nội dung khoá theo tư cách người học.
    expect(await hasCapability(app, admin, teacher.id, 'grade:viewall', learnedCtx)).toBe(false);
    const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${learned.id}/enrolments/me`)
      .set('Authorization', `Bearer ${teacherLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
    const content = await http(app).get(`/api/v1/courses/${learned.id}/content`)
      .set('Authorization', `Bearer ${teacherLogin.accessToken}`);
    expect(content.status).toBe(200);
  });

  it('reverse gate: assigning a teaching role at course or class context to an active learner of a covered course is rejected', async () => {
    const course = await createCourse(app, admin, categoryId);
    const ctxId = await courseContextId(course.id);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const learner = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, learner.id);

    const blockedCourse = await http(app).post('/api/v1/access/assignments')
      .set('Authorization', `Bearer ${admin}`)
      .send({ userId: learner.id, roleId: editingTeacherRoleId, contextId: ctxId });
    expect(blockedCourse.status).toBe(400);
    expect(blockedCourse.body.code).toBe('access.role_context_conflict');
    expect((await assignmentsOf(learner.id, ctxId)).filter((a) => a.roleId === editingTeacherRoleId)).toHaveLength(0);

    // Biến thể context lớp: học viên đang học ở một khoá thuộc lớp
    // không nhận được vai giảng dạy tại context của chính lớp đó.
    const cls = await http(app).post('/api/v1/classes').set('Authorization', `Bearer ${admin}`).send({ name: `Reverse gate class ${Date.now().toString(36)}` });
    expect(cls.status).toBe(201);
    const classId = cls.body.id as string;
    const classCourse = await createCourse(app, admin, categoryId, { classId });
    const classInstance = await createEnrolInstance(app, admin, classCourse.id, { method: 'manual' });
    const classLearner = await createUserViaApi(app, admin);
    await enrolUser(app, admin, classCourse.id, classInstance.id, classLearner.id);
    const classCtxId = await contextIdByLevelInstance(45, classId);
    const blockedClass = await http(app).post('/api/v1/access/assignments')
      .set('Authorization', `Bearer ${admin}`)
      .send({ userId: classLearner.id, roleId: teacherRoleId, contextId: classCtxId });
    expect(blockedClass.status).toBe(400);
    expect(blockedClass.body.code).toBe('access.role_context_conflict');

    // Đối chứng dương: người không có ghi danh học viên đang hoạt
    // động trong khoá bị bao phủ vẫn nhận vai giảng dạy bình thường.
    const fresh = await createUserViaApi(app, admin);
    const ok = await http(app).post('/api/v1/access/assignments')
      .set('Authorization', `Bearer ${admin}`)
      .send({ userId: fresh.id, roleId: editingTeacherRoleId, contextId: ctxId });
    expect(ok.status).toBe(201);
  });

  it('funnel 3: restore skips the enrolment of a user who teaches the target course, restores the valid one, and records the skip in the step detail', async () => {
    const source = await createCourse(app, admin, categoryId);
    const instance = await createEnrolInstance(app, admin, source.id, { method: 'manual' });
    const conflicting = await createUserViaApi(app, admin);
    const valid = await createUserViaApi(app, admin);
    await enrolUser(app, admin, source.id, instance.id, conflicting.id);
    await enrolUser(app, admin, source.id, instance.id, valid.id);

    // Người thứ nhất dạy khoá ĐÍCH (chỉ dạy ở đích, học ở nguồn —
    // hai khoá khác nhau nên gán vai này hợp lệ).
    const target = await createCourse(app, admin, categoryId);
    const targetCtx = await courseContextId(target.id);
    await assignRole(app, admin, conflicting.id, editingTeacherRoleId, targetCtx);

    const backup = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ courseId: source.id });
    expect(backup.status).toBeLessThan(300);
    expect(backup.body.status).toBe('completed');

    const restore = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'merge', targetCourseId: target.id });
    expect(restore.status).toBeLessThan(300);
    expect(restore.body.status).toBe('completed');

    const steps = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/steps`).set('Authorization', `Bearer ${admin}`);
    const enrolStep = (steps.body as { name: string; detail: { skippedRoleConflictEnrolments?: number } | null }[])
      .find((s) => s.name === 'enrol');
    expect(enrolStep).toBeDefined();
    expect(enrolStep!.detail?.skippedRoleConflictEnrolments).toBe(1);

    // Ghi danh vi phạm không được tạo ở khoá đích; ghi danh hợp lệ
    // trong cùng backup vẫn khôi phục đầy đủ.
    expect(await enrolmentCount(target.id, conflicting.id)).toBe(0);
    expect(await enrolmentCount(target.id, valid.id)).toBe(1);
    const validLogin = await login(app, valid.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${target.id}/enrolments/me`)
      .set('Authorization', `Bearer ${validLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
  });

  it('reactivation: reactivating a suspended enrolment after a teaching assignment at the same course is rejected and the enrolment stays suspended', async () => {
    const course = await createCourse(app, admin, categoryId);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const learner = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, learner.id);
    // Đình chỉ ghi danh: từ thời điểm này ghi danh không còn "đang
    // hoạt động" theo định nghĩa kiểm (b).
    const suspend = await http(app)
      .post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${learner.id}/suspend`)
      .set('Authorization', `Bearer ${admin}`);
    expect(suspend.status).toBe(201);
    // Gán vai giảng dạy tại context khoá: hợp lệ ở thời điểm này vì
    // chốt chiều ngược chỉ xét ghi danh đang hoạt động.
    await assignRole(app, admin, learner.id, editingTeacherRoleId, await courseContextId(course.id));
    // Kích hoạt lại sẽ biến ghi danh thành ghi danh học viên đang
    // hoạt động trong chính khoá người dùng đang dạy → bị từ chối.
    const reactivate = await http(app)
      .post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${learner.id}/reactivate`)
      .set('Authorization', `Bearer ${admin}`);
    expect(reactivate.status).toBe(400);
    expect(reactivate.body.code).toBe('access.role_context_conflict');
    const rows = await pg.query(
      'select status from user_enrolments where enrol_id = $1 and user_id = $2',
      [instance.id, learner.id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.status).toBe(1);
  });

  it('audit: pre-existing same-course data is classified as violation, cross-course as valid, and the audit writes nothing', async () => {
    // Dữ kiện lẫn vai CÙNG khoá dựng thẳng vào DB — mô phỏng trạng
    // thái có sẵn từ trước khi có chốt chặn (đường ghi API hiện nay
    // không tạo nổi trạng thái này nữa).
    const legacy = await createUserViaApi(app, admin);
    const course = await createCourse(app, admin, categoryId);
    const ctxId = await courseContextId(course.id);
    await assignRole(app, admin, legacy.id, editingTeacherRoleId, ctxId);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    await pg.query('insert into user_enrolments (enrol_id, user_id, status) values ($1, $2, 0)', [instance.id, legacy.id]);

    const service = app.get(RoleSeparationService, { strict: false });
    const countBefore = await pg.query<{ n: string }>(
      'select (select count(*) from user_enrolments) + (select count(*) from role_assignments) as n',
    );
    const report = await service.auditRoleConflicts();
    const countAfter = await pg.query<{ n: string }>(
      'select (select count(*) from user_enrolments) + (select count(*) from role_assignments) as n',
    );
    expect(countAfter.rows[0]!.n).toBe(countBefore.rows[0]!.n);

    const legacyEntry = report.sameCourse.find((e) => e.userId === legacy.id);
    expect(legacyEntry).toBeDefined();
    expect(legacyEntry!.conflictingCourseIds).toContain(course.id);
    expect(report.crossCourse.some((e) => e.userId === legacy.id)).toBe(false);

    // Giáo viên của ca 3 (dạy khoá này, học khoá khác) thuộc nhóm
    // hợp lệ; giáo viên ca 1 và chủ lớp ca 2 (chỉ dạy, không học)
    // không xuất hiện trong cả hai nhóm.
    expect(report.crossCourse.some((e) => e.userId === crossCourseTeacherId)).toBe(true);
    expect(report.sameCourse.some((e) => e.userId === crossCourseTeacherId)).toBe(false);
    expect(report.sameCourse.some((e) => e.userId === ownCourseTeacherId)).toBe(false);
    expect(report.crossCourse.some((e) => e.userId === ownCourseTeacherId)).toBe(false);
    expect(report.sameCourse.some((e) => e.userId === classOwnerId)).toBe(false);
    expect(report.crossCourse.some((e) => e.userId === classOwnerId)).toBe(false);
  });
});
