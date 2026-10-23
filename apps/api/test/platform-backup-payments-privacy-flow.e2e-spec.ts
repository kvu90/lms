import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createCm, createEnrolInstance, createSection, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';
import { courseContextId, createGroupViaApi, markCmComplete } from './engagement-helpers';
import { EXPECTED_PRIVACY_SUBSYSTEMS } from '../src/modules/privacy/privacy.service';
import { PrivacyService } from '../src/modules/privacy/privacy.service';

/**
 * Platform flow: Backup/Restore, Payments + fee enrol, Privacy.
 * Oracle Moodle 5.3 (đã kiểm chứng live 22/10/2026):
 * - backup/tests/backup_restore_permission_test.php + backup_restore_base_testcase.php
 *   (kế hoạch nhiều bước, restore id mapping — backup/tests/backup_test.php 404 đã ghi nhận)
 * - payment/tests/helper_test.php + generator_test.php (số tiền nguyên, gateway)
 * - privacy/tests/manager_test.php (request lifecycle + phê duyệt) và provider registry §2#28
 */
describe('Platform services: backup→restore equivalence, payment webhook idempotency, privacy completeness', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  it('backup DoD: backup a full course and restore it as a new course — checklist matches, ids are remapped, file is downloadable in the new course', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const section0 = await getFirstSectionId(app, admin, course.id);
    const section1 = await createSection(app, admin, course.id, { name: 'Week 1' });
    const cm = await createCm(app, admin, course.id, section1.id, { name: 'Reading', completion: 1, completionmanual: true });
    void section0;
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Group A');
    await http(app).post(`/api/v1/courses/${course.id}/groups/${group.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: student.id });
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Quiz' });
    await setGrade(app, admin, item.id, student.id, 80);
    await markCmComplete(app, admin, course.id, cm.id, student.id);
    // File trong course context qua Files API.
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const courseCtx = content.body.contextId as string;
    const upload = await http(app).post('/api/v1/files').set('Authorization', `Bearer ${admin}`)
      .field('contextid', String(courseCtx)).field('component', 'core_course').field('filearea', 'summary')
      .attach('file', Buffer.from('backup-file-content'), 'syllabus.txt');
    expect(upload.status).toBe(201);

    const backup = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ courseId: course.id });
    expect(backup.status).toBeLessThan(300);
    expect(backup.body.status).toBe('completed');
    expect(backup.body.archive.format).toBe('lms-backup');
    expect(backup.body.archive.version).toBe(1);
    const steps = await http(app).get(`/api/v1/backup/jobs/${backup.body.id}/steps`).set('Authorization', `Bearer ${admin}`);
    expect((steps.body as { name: string }[]).map((s) => s.name)).toEqual(
      expect.arrayContaining(['courses', 'enrol', 'groups', 'grades', 'completion', 'files']));

    const restore = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'new' });
    expect(restore.status).toBeLessThan(300);
    expect(restore.body.status).toBe('completed');
    const newCourseId = restore.body.targetcourseid as string;
    expect(newCourseId).not.toBe(course.id);

    const checklist = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/checklist`).set('Authorization', `Bearer ${admin}`);
    for (const key of ['sections', 'cms', 'enrolInstances', 'enrolments', 'grades', 'cmCompletion'] as const) {
      expect(checklist.body[key].target, `checklist ${key}`).toBe(checklist.body[key].source);
    }
    expect(checklist.body.gradeItems.target).toBeGreaterThanOrEqual(checklist.body.gradeItems.source - 0);
    // Id mapping: mọi mapping đều trỏ sang id khác gốc (trừ course mapping cũng khác).
    const mappings = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/mappings`).set('Authorization', `Bearer ${admin}`);
    const rows = mappings.body as { itemtype: string; oldid: string; newid: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((m) => m.newid !== m.oldid)).toBe(true);
    expect(rows.some((m) => m.itemtype === 'cm' && m.oldid === cm.id)).toBe(true);
    expect(rows.some((m) => m.itemtype === 'file')).toBe(true);
    // File khôi phục tải được bằng signed URL trong course mới (admin xem).
    const fileMapping = rows.find((m) => m.itemtype === 'file')!;
    const signed = await http(app).post(`/api/v1/files/${fileMapping.newid}/signed-url`).set('Authorization', `Bearer ${admin}`).send({});
    expect(signed.status).toBeLessThan(300);
    const download = await http(app).get(signed.body.url.replace('/api/v1', '/api/v1'));
    expect(download.status).toBe(200);
    expect(download.text).toContain('backup-file-content');
    // Merge mode vào một course đích khác cũng chạy và tăng số cm.
    const target = await createCourse(app, admin, cat.id);
    const merge = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'merge', targetCourseId: target.id });
    expect(merge.body.status).toBe('completed');
    const targetContent = await http(app).get(`/api/v1/courses/${target.id}/content`).set('Authorization', `Bearer ${admin}`);
    const cmCount = (targetContent.body.sections as { modules: unknown[] }[]).reduce((n, s) => n + s.modules.length, 0);
    expect(cmCount).toBeGreaterThanOrEqual(1);
  });

  it('backup anonymize: user ids are scrubbed from the archive enrol/grades/completion data', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const backup = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ courseId: course.id, anonymize: true });
    expect(backup.body.status).toBe('completed');
    const enrolData = backup.body.archive.contributors.enrol as { enrolments: { userid: string | null }[] };
    expect(enrolData.enrolments.length).toBeGreaterThan(0);
    expect(enrolData.enrolments.every((e) => e.userid === null)).toBe(true);
  });

  it('payments DoD: webhook replay does not activate a fee enrolment twice and the payment is immutable; refund is a separate compensating row', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const account = await http(app).post('/api/v1/payments/accounts').set('Authorization', `Bearer ${admin}`).send({ name: `Acct ${Date.now()}`, gateway: 'manual' });
    expect(account.status).toBeLessThan(300);
    const feeInstance = await createEnrolInstance(app, admin, course.id, {
      method: 'fee', cost: 50000, currency: 'VND', paymentAccountId: account.body.id,
    });
    const buyer = await createUserViaApi(app, admin);
    const buyerToken = (await login(app, buyer.username, STRONG_PASSWORD)).accessToken;
    // Chưa trả tiền: self-enrol vào fee instance bị từ chối.
    const early = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${feeInstance.id}/self-enrol`).set('Authorization', `Bearer ${buyerToken}`).send({});
    expect(early.status).toBe(400);
    const before = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${buyerToken}`);
    expect(before.body.active).toBe(false);
    // Tạo payment + webhook thành công.
    const payment = await http(app).post(`/api/v1/payments/fee/${feeInstance.id}`).set('Authorization', `Bearer ${buyerToken}`).send({});
    expect(payment.status).toBeLessThan(300);
    expect(payment.body.amount).toBe(50000);
    expect(payment.body.currency).toBe('VND');
    const txId = `tx-${Date.now()}`;
    const hook = await http(app).post('/api/v1/payments/webhook').send({ gateway: 'manual', externalTransactionId: txId, paymentId: payment.body.id, status: 'succeeded' });
    expect(hook.status).toBeLessThan(300);
    expect(hook.body.status).toBe('succeeded');
    const after = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${buyerToken}`);
    expect(after.body.active).toBe(true);
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    const mine = (enrolments.body as { userid: string }[]).filter((e) => e.userid === buyer.id);
    expect(mine).toHaveLength(1);
    // Replay webhook cùng external tx ⇒ duplicate, enrolment vẫn đúng 1, outbox payment_succeeded chỉ 1 (kiểm qua số enrolment + duplicate flag).
    const replay = await http(app).post('/api/v1/payments/webhook').send({ gateway: 'manual', externalTransactionId: txId, paymentId: payment.body.id, status: 'succeeded' });
    expect(replay.body.duplicate).toBe(true);
    const enrolments2 = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments2.body as { userid: string }[]).filter((e) => e.userid === buyer.id)).toHaveLength(1);
    // Refund là giao dịch bù trừ riêng; payment gốc giữ nguyên amount.
    const refund = await http(app).post(`/api/v1/payments/${payment.body.id}/refund`).set('Authorization', `Bearer ${admin}`).send({ amount: 50000, reason: 'changed mind' });
    expect(refund.status).toBeLessThan(300);
    const after2 = await http(app).get(`/api/v1/payments/${payment.body.id}`).set('Authorization', `Bearer ${admin}`);
    expect(after2.body.amount).toBe(50000);
    expect(after2.body.status).toBe('refunded');
    const refunds = await http(app).get(`/api/v1/payments/${payment.body.id}/refunds`).set('Authorization', `Bearer ${admin}`);
    expect(refunds.body).toHaveLength(1);
  });

  it('privacy completeness: every expected subsystem has a registered provider (registry completeness gate)', async () => {
    const service = app.get(PrivacyService);
    expect(service.missingProviders()).toEqual([]);
    const providers = await http(app).get('/api/v1/privacy/providers').set('Authorization', `Bearer ${admin}`);
    const names = (providers.body as { subsystem: string }[]).map((p) => p.subsystem);
    for (const expected of EXPECTED_PRIVACY_SUBSYSTEMS) expect(names).toContain(expected);
    const completeness = await http(app).get('/api/v1/privacy/completeness').set('Authorization', `Bearer ${admin}`);
    expect(completeness.body.complete).toBe(true);
  });

  it('privacy DoD: export bundles every subsystem, and an approved delete propagates to every registered subsystem', async () => {
    // Dựng dữ liệu cá nhân ở nhiều subsystem cho một user.
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Act', completion: 1, completionmanual: true });
    const instance = await createEnrolInstance(app, admin, course.id);
    const user = await createUserViaApi(app, admin);
    const userToken = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Graded' });
    await setGrade(app, admin, item.id, user.id, 42);
    await markCmComplete(app, admin, course.id, cm.id, user.id);
    // Export request: user tự gửi, admin duyệt ⇒ completed + file manifest qua FilesModule.
    const expReq = await http(app).post('/api/v1/privacy/requests').set('Authorization', `Bearer ${userToken}`).send({ type: 'export' });
    expect(expReq.status).toBeLessThan(300);
    const expDone = await http(app).post(`/api/v1/privacy/requests/${expReq.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'approved' });
    expect(expDone.body.status).toBe('completed');
    for (const s of EXPECTED_PRIVACY_SUBSYSTEMS) expect(expDone.body.result.subsystems).toContain(s);
    const expFiles = await http(app).get(`/api/v1/privacy/requests/${expReq.body.id}/files`).set('Authorization', `Bearer ${admin}`);
    expect(expFiles.body).toHaveLength(1);
    expect(expFiles.body[0].fileid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // Student tự duyệt yêu cầu của mình ⇒ 403 (privacy:manage là của admin).
    const delReq = await http(app).post('/api/v1/privacy/requests').set('Authorization', `Bearer ${userToken}`).send({ type: 'delete' });
    const selfDecide = await http(app).post(`/api/v1/privacy/requests/${delReq.body.id}/decide`).set('Authorization', `Bearer ${userToken}`).send({ decision: 'approved' });
    expect(selfDecide.status).toBe(403);
    const delDone = await http(app).post(`/api/v1/privacy/requests/${delReq.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'approved' });
    expect(delDone.body.status).toBe('completed');
    for (const s of EXPECTED_PRIVACY_SUBSYSTEMS) expect(Object.keys(delDone.body.result.deleted)).toContain(s);
    // Lan đủ subsystem: enrolment, grades, completion của user đều biến mất; user bị soft-delete/ẩn danh.
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userid: string }[]).some((e) => e.userid === user.id)).toBe(false);
    const book = await http(app).get(`/api/v1/courses/${course.id}/gradebook?userid=${user.id}`).set('Authorization', `Bearer ${admin}`);
    const flat = JSON.stringify(book.body);
    expect(flat).not.toContain('"finalgrade":42');
    const profile = await http(app).get(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    // User đã deleted: profile API hoặc trả deleted=true, hoặc username đã bị mangle.
    const deletedFlag = profile.body.deleted === true || String(profile.body.username ?? '').includes('.deleted');
    expect(deletedFlag).toBe(true);
  });

  it('backup extended contributors: question bank (tree + versions), course badges (criteria params remapped) and calendar (course/group events, series, subscription) restore into the new course with new ids', async () => {
    const suffix = `${Date.now()}`;
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const section1 = await createSection(app, admin, course.id, { name: 'Week 1' });
    const cm = await createCm(app, admin, course.id, section1.id, { name: 'Reading BK', completion: 1, completionmanual: true });
    const group = await createGroupViaApi(app, admin, course.id, 'Group BK');
    const courseCtx = await courseContextId(app, admin, course.id);
    // --- Question bank ở context của khoá: cây category 2 cấp + câu hỏi 2 version.
    const parentCat = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Bank parent ${suffix}`, contextid: courseCtx });
    expect(parentCat.status).toBeLessThan(300);
    const childCat = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Bank child ${suffix}`, contextid: courseCtx, parent: parentCat.body.id });
    expect(childCat.status).toBeLessThan(300);
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: childCat.body.id, qtype: 'truefalse', name: 'BK question', questiontext: 'Version one text.', answer: { correct: true } });
    expect(qRes.status).toBeLessThan(300);
    const qid = qRes.body.question.id as string;
    const edit = await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`)
      .send({ questiontext: 'Version two text.', answer: { correct: false } });
    expect(edit.body.entry.latestversion).toBe(2);
    // --- Competency dùng chung mức site (lá competency trỏ vào đây; KHÔNG nằm trong archive).
    const fw = await http(app).post('/api/v1/competencies/frameworks').set('Authorization', `Bearer ${admin}`)
      .send({ shortname: `BKFW ${suffix}`, scale: { values: ['Not competent', 'Competent'], proficient: [1] } });
    expect(fw.status).toBe(201);
    const comp = await http(app).post(`/api/v1/competencies/frameworks/${fw.body.id}/competencies`).set('Authorization', `Bearer ${admin}`)
      .send({ shortname: 'BK teamwork' });
    expect(comp.status).toBe(201);
    // --- Hai badge của khoá: B tham chiếu A (badge), khoá (course), cm (activity) và competency.
    const badgeA = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: `BK Badge A ${suffix}`, type: 2, courseid: course.id, issuername: 'LMS' });
    expect(badgeA.status).toBeLessThan(300);
    await http(app).put(`/api/v1/badges/${badgeA.body.id}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'manual', params: {} }] });
    const badgeB = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: `BK Badge B ${suffix}`, type: 2, courseid: course.id, issuername: 'LMS' });
    expect(badgeB.status).toBeLessThan(300);
    await http(app).put(`/api/v1/badges/${badgeB.body.id}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({
        method: 1,
        criteria: [
          { criteriatype: 'coursecompletion', params: { courseId: course.id } },
          { criteriatype: 'activitycompletion', params: { cmId: cm.id } },
          { criteriatype: 'competency', params: { competencyId: comp.body.id } },
          { criteriatype: 'badge', params: { badgeId: badgeA.body.id } },
        ],
      });
    // --- Calendar: sự kiện khoá, sự kiện nhóm, chuỗi lặp của khoá và subscription của khoá.
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const courseEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: `BK course lecture ${suffix}`, eventtype: 'course', courseid: course.id, timestart: soon });
    expect(courseEv.status).toBe(201);
    const groupEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: `BK group standup ${suffix}`, eventtype: 'group', courseid: course.id, groupid: group.id, timestart: soon });
    expect(groupEv.status).toBe(201);
    const series = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: `BK weekly ${suffix}`, eventtype: 'course', courseid: course.id, timestart: soon, repeat: { freq: 'WEEKLY', count: 2 } });
    expect(series.status).toBe(201);
    const seriesRootId = series.body.event.id as string;
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:bk-feed@lms', 'SUMMARY:BK feed event', 'DTSTART:20270105T090000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const sub = await http(app).post('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${admin}`)
      .send({ name: `BK course feed ${suffix}`, eventtype: 'course', courseid: course.id, icsdata: ics });
    expect(sub.status).toBe(201);

    const backup = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ courseId: course.id });
    expect(backup.body.status).toBe('completed');
    expect(backup.body.scope).toBe('course');
    const steps = await http(app).get(`/api/v1/backup/jobs/${backup.body.id}/steps`).set('Authorization', `Bearer ${admin}`);
    expect((steps.body as { name: string }[]).map((s) => s.name)).toEqual(
      expect.arrayContaining(['questions', 'badges', 'calendar']));
    const contributors = backup.body.archive.contributors as Record<string, Record<string, unknown[]>>;
    expect(contributors.questions!.categories).toHaveLength(2);
    expect(contributors.questions!.questions).toHaveLength(1);
    expect(contributors.questions!.versions).toHaveLength(2);
    // Dữ liệu vận hành KHÔNG vào archive: không usages/attempts, không assertions đã cấp.
    expect(contributors.questions).not.toHaveProperty('usages');
    expect(contributors.questions).not.toHaveProperty('attempts');
    expect(contributors.badges!.badges).toHaveLength(2);
    expect(contributors.badges).not.toHaveProperty('issued');
    expect(contributors.calendar!.events!.length).toBeGreaterThanOrEqual(4);
    expect(contributors.calendar!.subscriptions).toHaveLength(1);

    const restore = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'new' });
    expect(restore.body.status).toBe('completed');
    const newCourseId = restore.body.targetcourseid as string;
    expect(newCourseId).not.toBe(course.id);

    const checklist = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/checklist`).set('Authorization', `Bearer ${admin}`);
    for (const key of ['questionCategories', 'questions', 'questionVersions', 'badges', 'badgeCriteria', 'calendarEvents', 'calendarSubscriptions'] as const) {
      expect(checklist.body[key].target, `checklist ${key}`).toBe(checklist.body[key].source);
      expect(checklist.body[key].source, `checklist ${key} source`).toBeGreaterThan(0);
    }
    const mappings = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/mappings`).set('Authorization', `Bearer ${admin}`);
    const rows = mappings.body as { itemtype: string; oldid: string; newid: string }[];
    expect(rows.every((m) => m.newid !== m.oldid)).toBe(true);
    const mapOf = (itemtype: string, oldid: string) => rows.find((m) => m.itemtype === itemtype && m.oldid === oldid);
    // Question bank: category cha/con, câu hỏi và cả 2 version đều có id mới.
    const newParentCatId = mapOf('question_category', parentCat.body.id)?.newid;
    const newChildCatId = mapOf('question_category', childCat.body.id)?.newid;
    expect(newParentCatId).toBeTruthy();
    expect(newChildCatId).toBeTruthy();
    const newQ = mapOf('question', qid);
    expect(newQ).toBeTruthy();
    expect(rows.filter((m) => m.itemtype === 'question_version')).toHaveLength(2);
    const newCourseCtx = await courseContextId(app, admin, newCourseId);
    const newCats = await http(app).get('/api/v1/questions/categories').query({ contextid: newCourseCtx }).set('Authorization', `Bearer ${admin}`);
    const restoredChild = (newCats.body as { id: string; parent: string | null }[]).find((c) => c.id === newChildCatId);
    expect(restoredChild?.parent).toBe(newParentCatId);
    const restoredQuestions = await http(app).get(`/api/v1/questions/categories/${newChildCatId}/questions`).set('Authorization', `Bearer ${admin}`);
    expect(restoredQuestions.body).toHaveLength(1);
    expect(restoredQuestions.body[0].question.id).toBe(newQ!.newid);
    const restoredVersions = await http(app).get(`/api/v1/questions/${newQ!.newid}/versions`).set('Authorization', `Bearer ${admin}`);
    expect(restoredVersions.body).toHaveLength(2);
    // questiontext nay là tài liệu Tiptap: trích text thuần để so với bản gốc.
    const docText = (doc: { content?: { content?: { text?: string }[] }[] }) =>
      (doc.content ?? []).map((p) => (p.content ?? []).map((n) => n.text ?? '').join('')).join('\n');
    expect(docText(restoredVersions.body[1].questiontext)).toBe('Version two text.');
    // Nội dung chấm của version khôi phục (đáp án + trỏ true/false) đi theo
    // archive: trueanswer trỏ vào dòng đáp án 'True', phía đúng nằm ở fraction
    // (version 2 của câu này có đáp án đúng là False nên True mang fraction 0).
    expect(restoredQuestions.body[0].answers.map((a: { fraction: number }) => a.fraction)).toEqual([0, 1]);
    expect(restoredQuestions.body[0].options.trueanswer).toBe(
      restoredQuestions.body[0].answers.find((a: { id: string; answer: never }) => docText(a.answer) === 'True')?.id,
    );
    // Badges: badge mới thuộc khoá mới; criteria của B trỏ đúng khoá/cm/badge mới, competency giữ nguyên (thực thể site dùng chung).
    const newBadgeAId = mapOf('badge', badgeA.body.id)?.newid;
    const newBadgeBId = mapOf('badge', badgeB.body.id)?.newid;
    expect(newBadgeAId).toBeTruthy();
    expect(newBadgeBId).toBeTruthy();
    const newBadgeB = await http(app).get(`/api/v1/badges/${newBadgeBId}`).set('Authorization', `Bearer ${admin}`);
    expect(newBadgeB.body.courseid).toBe(newCourseId);
    const newCriteria = await http(app).get(`/api/v1/badges/${newBadgeBId}/criteria`).set('Authorization', `Bearer ${admin}`);
    const leaves = newCriteria.body.criteria as { criteriatype: string; params: Record<string, string> }[];
    expect(leaves.find((l) => l.criteriatype === 'coursecompletion')?.params.courseId).toBe(newCourseId);
    expect(leaves.find((l) => l.criteriatype === 'activitycompletion')?.params.cmId).toBe(mapOf('cm', cm.id)?.newid);
    expect(leaves.find((l) => l.criteriatype === 'competency')?.params.competencyId).toBe(comp.body.id);
    expect(leaves.find((l) => l.criteriatype === 'badge')?.params.badgeId).toBe(newBadgeAId);
    // Calendar: mọi sự kiện khôi phục thuộc khoá mới; sự kiện nhóm trỏ nhóm mới; chuỗi lặp nối lại repeatid mới; subscription có mapping.
    const newGroupId = mapOf('group', group.id)?.newid;
    for (const oldEventId of [courseEv.body.event.id, groupEv.body.event.id, seriesRootId]) {
      const mapping = mapOf('calendar_event', oldEventId);
      expect(mapping, `calendar_event mapping for ${oldEventId}`).toBeTruthy();
      const restored = await http(app).get(`/api/v1/calendar/events/${mapping!.newid}`).set('Authorization', `Bearer ${admin}`);
      expect(restored.body.courseid).toBe(newCourseId);
    }
    const restoredGroupEvent = await http(app).get(`/api/v1/calendar/events/${mapOf('calendar_event', groupEv.body.event.id)!.newid}`).set('Authorization', `Bearer ${admin}`);
    expect(restoredGroupEvent.body.groupid).toBe(newGroupId);
    const restoredRoot = await http(app).get(`/api/v1/calendar/events/${mapOf('calendar_event', seriesRootId)!.newid}`).set('Authorization', `Bearer ${admin}`);
    expect(restoredRoot.body.repeatid).toBe(restoredRoot.body.id);
    expect(mapOf('calendar_subscription', sub.body.id)).toBeTruthy();
  });

  it('site-level backup: backup without a course captures the site question bank, site badges and site calendar, and restores them as new site-level data', async () => {
    const suffix = `${Date.now()}-site`;
    const contextsRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contextsRes.body as { id: string; contextlevel: number }[]).find((c) => c.contextlevel === 10)!;
    const siteCat = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Site bank ${suffix}`, contextid: systemCtx.id });
    expect(siteCat.status).toBeLessThan(300);
    const siteQ = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: siteCat.body.id, qtype: 'shortanswer', name: 'Site question', questiontext: 'Capital of France?', answer: { answers: ['Paris'] } });
    expect(siteQ.status).toBeLessThan(300);
    const siteBadge = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Site Badge ${suffix}`, type: 1, issuername: 'LMS HQ' });
    expect(siteBadge.status).toBeLessThan(300);
    await http(app).put(`/api/v1/badges/${siteBadge.body.id}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'manual', params: {} }] });
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const siteEvent = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Site day ${suffix}`, eventtype: 'site', timestart: soon });
    expect(siteEvent.status).toBe(201);

    // Hợp đồng phạm vi: site + courseId bị từ chối; thiếu courseId ở phạm vi course cũng bị từ chối.
    const cat = await createCategory(app, admin);
    const someCourse = await createCourse(app, admin, cat.id);
    const mixed = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ scope: 'site', courseId: someCourse.id });
    expect(mixed.status).toBe(400);
    const missing = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({});
    expect(missing.status).toBe(400);

    const backup = await http(app).post('/api/v1/backup/jobs').set('Authorization', `Bearer ${admin}`).send({ scope: 'site' });
    expect(backup.status).toBeLessThan(300);
    expect(backup.body.status).toBe('completed');
    expect(backup.body.scope).toBe('site');
    expect(backup.body.courseid).toBeNull();
    expect(backup.body.archive.scope).toBe('site');
    expect(backup.body.archive.course).toBeNull();
    const siteContributors = backup.body.archive.contributors as Record<string, unknown>;
    expect(siteContributors.questions).toBeTruthy();
    expect(siteContributors.badges).toBeTruthy();
    expect(siteContributors.calendar).toBeTruthy();
    expect(siteContributors.courses).toBeUndefined();

    // Site backup không nhận khoá đích / chế độ gộp.
    const badRestore = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'merge', targetCourseId: someCourse.id });
    expect(badRestore.status).toBe(400);
    expect(badRestore.body.code).toBe('backup.site_target_forbidden');

    const restore = await http(app).post('/api/v1/backup/restore').set('Authorization', `Bearer ${admin}`)
      .send({ backupJobId: backup.body.id, mode: 'new' });
    expect(restore.body.status).toBe('completed');
    expect(restore.body.scope).toBe('site');
    expect(restore.body.targetcourseid).toBeNull();
    const mappings = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/mappings`).set('Authorization', `Bearer ${admin}`);
    const rows = mappings.body as { itemtype: string; oldid: string; newid: string }[];
    expect(rows.every((m) => m.newid !== m.oldid)).toBe(true);
    const newSiteCatId = rows.find((m) => m.itemtype === 'question_category' && m.oldid === siteCat.body.id)?.newid;
    expect(newSiteCatId).toBeTruthy();
    const newSiteQuestions = await http(app).get(`/api/v1/questions/categories/${newSiteCatId}/questions`).set('Authorization', `Bearer ${admin}`);
    expect(newSiteQuestions.body).toHaveLength(1);
    expect(newSiteQuestions.body[0].question.id).not.toBe(siteQ.body.question.id);
    const newSiteBadgeId = rows.find((m) => m.itemtype === 'badge' && m.oldid === siteBadge.body.id)?.newid;
    expect(newSiteBadgeId).toBeTruthy();
    const newSiteBadge = await http(app).get(`/api/v1/badges/${newSiteBadgeId}`).set('Authorization', `Bearer ${admin}`);
    expect(newSiteBadge.body.type).toBe(1);
    expect(newSiteBadge.body.courseid).toBeNull();
    const newSiteEventId = rows.find((m) => m.itemtype === 'calendar_event' && m.oldid === siteEvent.body.event.id)?.newid;
    expect(newSiteEventId).toBeTruthy();
    const checklist = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/checklist`).set('Authorization', `Bearer ${admin}`);
    expect(checklist.body.questionCategories.target).toBeGreaterThanOrEqual(1);
    expect(checklist.body.badges.target).toBeGreaterThanOrEqual(1);
    expect(checklist.body.calendarEvents.target).toBeGreaterThanOrEqual(1);
  });
});
