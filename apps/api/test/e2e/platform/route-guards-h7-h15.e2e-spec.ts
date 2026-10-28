import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import {
  createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId,
} from '../../support/course-enrolment-helpers';
import { addExamSlot, createExamDraft, createReadyQuestion, pinExam } from '../../support/exam-pin-helpers';
import { courseContextId } from '../../support/engagement-helpers';

/**
 * Vá đợt 4 của rà soát gác quyền #134 (H7–H15): các đường ĐỌC bị sót gác.
 * Mỗi cụm có ca âm (user thường/ngoài khoá bị chặn: 403, riêng cohort +
 * privacy là 404 như không tồn tại, catalogue/list là bị lọc khỏi danh
 * sách) và ca dương (chủ thể / người có capability / người trong khoá
 * chạy như cũ):
 *  H7  backup jobs: đọc đòi backup:backupcourse|restorecourse tại context khoá/system.
 *  H8  usercomp + evidence: chỉ chủ thể hoặc holder planview/usercompetencyreview.
 *  H9  danh sách quiz của khoá: qua cổng truy cập khoá (slots là cấu trúc đề).
 *  H10 cohorts: đòi cohort:view/manage tại context của cohort.
 *  H11 calendar subscriptions: chỉ của chính chủ.
 *  H12 catalogue: khoá/category ẩn chỉ hiện với holder course:viewhiddencourses.
 *  H13 badges evaluate/evaluate-user: chỉ chủ thể hoặc holder badges:awardbadge.
 *  H14 cấu trúc theo khoá (assignments, completion criteria, grades, links): cổng truy cập khoá.
 *  H15 privacy requests: chủ thể/người gửi/privacy:manage; reports metadata: reportbuilder:manage.
 */
describe('Route guards đợt 4 (H7–H15, #134)', () => {
  let app: INestApplication;
  let admin: string;
  let courseId: string;
  let hiddenCourseId: string;
  let hiddenCategoryId: string;
  let quizId: string;
  let cohortId: string;
  let badgeId: string;
  let frameworkId: string;
  let competencyId: string;
  let usercompId: string;
  let teacher: string;
  let student: string;
  let studentId: string;
  let outsider: string;
  let outsiderId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const cat = await createCategory(app, admin);
    const hiddenCat = await createCategory(app, admin, { name: `Hidden cat ${Date.now()}` });
    hiddenCategoryId = hiddenCat.id;
    const hideCat = await http(app).patch(`/api/v1/courses/categories/${hiddenCat.id}`)
      .set('Authorization', `Bearer ${admin}`).send({ visible: false });
    expect(hideCat.status).toBeLessThan(300);

    const course = await createCourse(app, admin, cat.id);
    courseId = course.id;
    const hiddenCourse = await createCourse(app, admin, cat.id);
    hiddenCourseId = hiddenCourse.id;
    const hideCourse = await http(app).patch(`/api/v1/courses/${hiddenCourse.id}`)
      .set('Authorization', `Bearer ${admin}`).send({ visible: false });
    expect(hideCourse.status).toBeLessThan(300);

    // Giáo viên tại context khoá + học sinh ghi danh + người ngoài khoá.
    const ctxId = await courseContextId(app, admin, courseId);
    const teacherUser = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacherUser.id, teacherRole, ctxId);
    teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    const studentUser = await createUserViaApi(app, admin);
    studentId = studentUser.id;
    const instance = await createEnrolInstance(app, admin, courseId);
    await enrolUser(app, admin, courseId, instance.id, studentUser.id);
    student = (await login(app, studentUser.username, STRONG_PASSWORD)).accessToken;

    const outsiderUser = await createUserViaApi(app, admin);
    outsiderId = outsiderUser.id;
    outsider = (await login(app, outsiderUser.username, STRONG_PASSWORD)).accessToken;

    const sectionId = await getFirstSectionId(app, admin, courseId);
    const gQuestion = await createReadyQuestion(app, admin, 'Guard question');
    const gDraft = await createExamDraft(app, admin, 'Guard quiz', 10);
    await addExamSlot(app, admin, gDraft, { questionId: gQuestion });
    const quiz = await pinExam(app, admin, courseId, gDraft, { sectionId });
    quizId = quiz.id as string;

    const cohort = await http(app).post('/api/v1/cohorts')
      .set('Authorization', `Bearer ${admin}`).send({ name: `Guard cohort ${Date.now()}` });
    expect(cohort.status).toBe(201);
    cohortId = cohort.body.id as string;

    const badge = await http(app).post('/api/v1/badges')
      .set('Authorization', `Bearer ${admin}`).send({ name: `Guard badge ${Date.now()}`, type: 1, issuerName: 'LMS HQ' });
    expect(badge.status).toBeLessThan(300);
    badgeId = badge.body.id as string;

    // Framework + competency; học sinh tự nộp evidence → có usercomp.
    const fw = await http(app).post('/api/v1/competencies/frameworks')
      .set('Authorization', `Bearer ${admin}`)
      .send({ shortName: `FW guard ${Date.now()}`, scale: { values: ['Not competent', 'Competent'], proficient: [1] } });
    expect(fw.status).toBe(201);
    frameworkId = fw.body.id as string;
    const comp = await http(app).post(`/api/v1/competencies/frameworks/${fw.body.id}/competencies`)
      .set('Authorization', `Bearer ${admin}`).send({ shortName: 'Guard competency' });
    expect(comp.status).toBe(201);
    competencyId = comp.body.id as string;
    const ev = await http(app).post('/api/v1/competencies/evidence')
      .set('Authorization', `Bearer ${student}`)
      .send({ userId: studentId, competencyId, description: 'Portfolio của học sinh', sendForReview: false });
    expect(ev.status).toBeLessThan(300);
    usercompId = (ev.body.usercomp as { id: string }).id;
  });
  afterAll(async () => { await app.close(); });

  it('H12: catalogue lọc khoá ẩn + cây category cắt nhánh ẩn với người thường, admin thấy đủ', async () => {
    const list = await http(app).get('/api/v1/courses').set('Authorization', `Bearer ${outsider}`);
    expect(list.status).toBe(200);
    const ids = (list.body as { id: string }[]).map((c) => c.id);
    expect(ids).toContain(courseId);
    expect(ids).not.toContain(hiddenCourseId);
    const adminList = await http(app).get('/api/v1/courses').set('Authorization', `Bearer ${admin}`);
    expect((adminList.body as { id: string }[]).map((c) => c.id)).toContain(hiddenCourseId);

    type Node = { id: string; children?: Node[] };
    const flatten = (nodes: Node[]): string[] => nodes.flatMap((n) => [n.id, ...flatten(n.children ?? [])]);
    const tree = await http(app).get('/api/v1/courses/categories/tree').set('Authorization', `Bearer ${outsider}`);
    expect(tree.status).toBe(200);
    expect(flatten(tree.body as Node[])).not.toContain(hiddenCategoryId);
    const adminTree = await http(app).get('/api/v1/courses/categories/tree').set('Authorization', `Bearer ${admin}`);
    expect(flatten(adminTree.body as Node[])).toContain(hiddenCategoryId);
  });

  it('H9: danh sách lần ghim của khoá — người ngoài 403, học sinh + giáo viên 200', async () => {
    const denied = await http(app).get(`/api/v1/courses/${courseId}/exam-pins`).set('Authorization', `Bearer ${outsider}`);
    expect(denied.status).toBe(403);
    const asStudent = await http(app).get(`/api/v1/courses/${courseId}/exam-pins`).set('Authorization', `Bearer ${student}`);
    expect(asStudent.status).toBe(200);
    expect((asStudent.body as { id: string }[]).map((q) => q.id)).toContain(quizId);
    const asTeacher = await http(app).get(`/api/v1/courses/${courseId}/exam-pins`).set('Authorization', `Bearer ${teacher}`);
    expect(asTeacher.status).toBe(200);
  });

  it('H14: assignments + completion criteria + grades structure + competency links theo khoá — người ngoài 403, người trong khoá 200', async () => {
    // #224: bề mặt điểm tổng hợp (categories/letters/scales/outcomes)
    // đã gỡ hẳn — danh sách chỉ còn các route điểm theo bài còn sống.
    const courseScoped = [
      `/api/v1/courses/${courseId}/assignments`,
      `/api/v1/courses/${courseId}/completion/criteria`,
      `/api/v1/courses/${courseId}/grade-items`,
      `/api/v1/courses/${courseId}/gradebook/report`,
      `/api/v1/competencies/courses/${courseId}/links`,
    ];
    for (const path of courseScoped) {
      const denied = await http(app).get(path).set('Authorization', `Bearer ${outsider}`);
      expect(denied.status, path).toBe(403);
      const allowed = await http(app).get(path).set('Authorization', `Bearer ${teacher}`);
      expect(allowed.status, path).toBe(200);
    }
    // Route điểm tổng hợp mức site không còn tồn tại (404 kể cả admin).
    const removed = await http(app).get('/api/v1/grades/outcomes').set('Authorization', `Bearer ${admin}`);
    expect(removed.status).toBe(404);
    // Rule của framework: user thường 403, admin 200.
    const ruleDenied = await http(app).get(`/api/v1/competencies/frameworks/${frameworkId}/competencies/${competencyId}/rule`)
      .set('Authorization', `Bearer ${outsider}`);
    expect(ruleDenied.status).toBe(403);
    const ruleAllowed = await http(app).get(`/api/v1/competencies/frameworks/${frameworkId}/competencies/${competencyId}/rule`)
      .set('Authorization', `Bearer ${admin}`);
    expect(ruleAllowed.status).toBe(200);
  });

  it('H8: usercomp + evidence của học sinh — người ngoài 403, chính chủ + admin 200', async () => {
    const denied = await http(app).get(`/api/v1/competencies/usercomp/user/${studentId}`).set('Authorization', `Bearer ${outsider}`);
    expect(denied.status).toBe(403);
    const own = await http(app).get(`/api/v1/competencies/usercomp/user/${studentId}`).set('Authorization', `Bearer ${student}`);
    expect(own.status).toBe(200);
    expect((own.body as { id: string }[]).map((u) => u.id)).toContain(usercompId);
    const asAdmin = await http(app).get(`/api/v1/competencies/usercomp/user/${studentId}`).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
    const evDenied = await http(app).get(`/api/v1/competencies/usercomp/${usercompId}/evidence`).set('Authorization', `Bearer ${outsider}`);
    expect(evDenied.status).toBe(403);
    const evOwn = await http(app).get(`/api/v1/competencies/usercomp/${usercompId}/evidence`).set('Authorization', `Bearer ${student}`);
    expect(evOwn.status).toBe(200);
    expect((evOwn.body as unknown[]).length).toBeGreaterThan(0);
  });

  it('H10: cohorts — người thường không thấy trong danh sách và 404 khi đọc thẳng, admin 200', async () => {
    const list = await http(app).get('/api/v1/cohorts').set('Authorization', `Bearer ${outsider}`);
    expect(list.status).toBe(200);
    expect((list.body as { id: string }[]).map((c) => c.id)).not.toContain(cohortId);
    const denied = await http(app).get(`/api/v1/cohorts/${cohortId}`).set('Authorization', `Bearer ${outsider}`);
    expect(denied.status).toBe(404);
    const asAdmin = await http(app).get(`/api/v1/cohorts/${cohortId}`).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
  });

  it('H11: calendar subscriptions chỉ trả của chính chủ', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LMS//Guard//EN',
      'BEGIN:VEVENT', 'UID:guard-sub-1', 'DTSTAMP:20260101T000000Z',
      'DTSTART:20260102T000000Z', 'DTEND:20260102T010000Z', 'SUMMARY:Guard event',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const adminSubName = `Admin feed ${Date.now()}`;
    const adminSub = await http(app).post('/api/v1/calendar/subscriptions')
      .set('Authorization', `Bearer ${admin}`).send({ name: adminSubName, eventType: 'site', icsData: ics });
    expect(adminSub.status).toBe(201);
    const ownSubName = `Outsider feed ${Date.now()}`;
    // Subscription cá nhân (eventType 'user') — loại 'site' vốn đã đòi
    // calendar:managesubscriptions ở đường tạo, không thuộc phạm vi H11.
    const ownSub = await http(app).post('/api/v1/calendar/subscriptions')
      .set('Authorization', `Bearer ${outsider}`).send({ name: ownSubName, eventType: 'user', icsData: ics });
    expect(ownSub.status).toBe(201);
    const list = await http(app).get('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${outsider}`);
    expect(list.status).toBe(200);
    const names = (list.body as { name: string }[]).map((s) => s.name);
    expect(names).toContain(ownSubName);
    expect(names).not.toContain(adminSubName);
    const adminList = await http(app).get('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${admin}`);
    expect((adminList.body as { name: string }[]).map((s) => s.name)).toContain(adminSubName);
  });

  it('H7: backup jobs — người thường bị lọc khỏi danh sách và 403 khi đọc thẳng, admin đọc được', async () => {
    const job = await http(app).post('/api/v1/backup/jobs')
      .set('Authorization', `Bearer ${admin}`).send({ courseId });
    expect(job.status).toBeLessThan(300);
    const jobId = job.body.id as string;
    const list = await http(app).get('/api/v1/backup/jobs').set('Authorization', `Bearer ${outsider}`);
    expect(list.status).toBe(200);
    expect((list.body as { id: string }[]).map((j) => j.id)).not.toContain(jobId);
    for (const path of [`/api/v1/backup/jobs/${jobId}`, `/api/v1/backup/jobs/${jobId}/steps`, `/api/v1/backup/jobs/${jobId}/mappings`, `/api/v1/backup/jobs/${jobId}/checklist`]) {
      const denied = await http(app).get(path).set('Authorization', `Bearer ${outsider}`);
      expect(denied.status, path).toBe(403);
    }
    const adminList = await http(app).get('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`);
    expect((adminList.body as { id: string }[]).map((j) => j.id)).toContain(jobId);
    const adminJob = await http(app).get(`/api/v1/backup/jobs/${jobId}`).set('Authorization', `Bearer ${admin}`);
    expect(adminJob.status).toBe(200);
  });

  it('H15: privacy request chỉ chủ thể/privacy:manage đọc được, người ngoài 404', async () => {
    const owner = await createUserViaApi(app, admin);
    const ownerToken = (await login(app, owner.username, STRONG_PASSWORD)).accessToken;
    const req = await http(app).post('/api/v1/privacy/requests')
      .set('Authorization', `Bearer ${ownerToken}`).send({ type: 'export' });
    expect(req.status).toBeLessThan(300);
    const reqId = req.body.id as string;
    const denied = await http(app).get(`/api/v1/privacy/requests/${reqId}`).set('Authorization', `Bearer ${outsider}`);
    expect(denied.status).toBe(404);
    const filesDenied = await http(app).get(`/api/v1/privacy/requests/${reqId}/files`).set('Authorization', `Bearer ${outsider}`);
    expect(filesDenied.status).toBe(404);
    const own = await http(app).get(`/api/v1/privacy/requests/${reqId}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(own.status).toBe(200);
    const asAdmin = await http(app).get(`/api/v1/privacy/requests/${reqId}`).set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
  });

  it('H15: reports metadata + kích hoạt lịch — user thường 403, admin 200', async () => {
    const report = await http(app).post('/api/v1/reports')
      .set('Authorization', `Bearer ${admin}`)
      .send({ name: `Guard report ${Date.now()}`, dataSource: 'enrolments', columns: ['userId', 'courseId'], filters: {}, audienceUserIds: [] });
    expect(report.status).toBeLessThan(300);
    const reportId = report.body.id as string;
    const sched = await http(app).post(`/api/v1/reports/${reportId}/schedules`)
      .set('Authorization', `Bearer ${admin}`).send({ cron: 'daily' });
    expect(sched.status).toBeLessThan(300);
    for (const path of ['/api/v1/reports', `/api/v1/reports/${reportId}`, '/api/v1/reports/datasources', '/api/v1/reports/schedules/all']) {
      const denied = await http(app).get(path).set('Authorization', `Bearer ${outsider}`);
      expect(denied.status, path).toBe(403);
    }
    const runDenied = await http(app).post(`/api/v1/reports/schedules/${sched.body.id}/run`)
      .set('Authorization', `Bearer ${outsider}`).send({});
    expect(runDenied.status).toBe(403);
    const adminList = await http(app).get('/api/v1/reports').set('Authorization', `Bearer ${admin}`);
    expect(adminList.status).toBe(200);
    expect((adminList.body as { id: string }[]).map((r) => r.id)).toContain(reportId);
  });

  it('H13: badges evaluate/evaluate-user — ép cho người khác 403, cho chính mình + admin 200', async () => {
    const denied = await http(app).post(`/api/v1/badges/${badgeId}/evaluate`)
      .set('Authorization', `Bearer ${outsider}`).send({ userId: studentId });
    expect(denied.status).toBe(403);
    const selfEval = await http(app).post(`/api/v1/badges/${badgeId}/evaluate`)
      .set('Authorization', `Bearer ${outsider}`).send({ userId: outsiderId });
    expect(selfEval.status).toBeLessThan(300);
    const adminEval = await http(app).post(`/api/v1/badges/${badgeId}/evaluate`)
      .set('Authorization', `Bearer ${admin}`).send({ userId: studentId });
    expect(adminEval.status).toBeLessThan(300);
    const deniedAll = await http(app).post('/api/v1/badges/evaluate-user')
      .set('Authorization', `Bearer ${outsider}`).send({ userId: studentId });
    expect(deniedAll.status).toBe(403);
    const selfAll = await http(app).post('/api/v1/badges/evaluate-user')
      .set('Authorization', `Bearer ${outsider}`).send({ userId: outsiderId });
    expect(selfAll.status).toBeLessThan(300);
    const adminAll = await http(app).post('/api/v1/badges/evaluate-user')
      .set('Authorization', `Bearer ${admin}`).send({ userId: studentId });
    expect(adminAll.status).toBeLessThan(300);
  });
});
