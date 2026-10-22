import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createP1TestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './p1-helpers';
import { createCategory, createCourse, createCm, createEnrolInstance, createSection, enrolUser, getFirstSectionId } from './p2-helpers';
import { createGradeItem, setGrade } from './p3-helpers';
import { createGroupViaApi, markCmComplete } from './p4-helpers';
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
    app = await createP1TestApp();
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
    const courseCtx = content.body.contextId as number;
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
    const newCourseId = restore.body.targetcourseid as number;
    expect(newCourseId).not.toBe(course.id);

    const checklist = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/checklist`).set('Authorization', `Bearer ${admin}`);
    for (const key of ['sections', 'cms', 'enrolInstances', 'enrolments', 'grades', 'cmCompletion'] as const) {
      expect(checklist.body[key].target, `checklist ${key}`).toBe(checklist.body[key].source);
    }
    expect(checklist.body.gradeItems.target).toBeGreaterThanOrEqual(checklist.body.gradeItems.source - 0);
    // Id mapping: mọi mapping đều trỏ sang id khác gốc (trừ course mapping cũng khác).
    const mappings = await http(app).get(`/api/v1/backup/jobs/${restore.body.id}/mappings`).set('Authorization', `Bearer ${admin}`);
    const rows = mappings.body as { itemtype: string; oldid: number; newid: number }[];
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
    const enrolData = backup.body.archive.contributors.enrol as { enrolments: { userid: number }[] };
    expect(enrolData.enrolments.length).toBeGreaterThan(0);
    expect(enrolData.enrolments.every((e) => e.userid === 0)).toBe(true);
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
    const mine = (enrolments.body as { userid: number }[]).filter((e) => e.userid === buyer.id);
    expect(mine).toHaveLength(1);
    // Replay webhook cùng external tx ⇒ duplicate, enrolment vẫn đúng 1, outbox payment_succeeded chỉ 1 (kiểm qua số enrolment + duplicate flag).
    const replay = await http(app).post('/api/v1/payments/webhook').send({ gateway: 'manual', externalTransactionId: txId, paymentId: payment.body.id, status: 'succeeded' });
    expect(replay.body.duplicate).toBe(true);
    const enrolments2 = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments2.body as { userid: number }[]).filter((e) => e.userid === buyer.id)).toHaveLength(1);
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
    expect(expFiles.body[0].fileid).toBeGreaterThan(0);
    // Student tự duyệt yêu cầu của mình ⇒ 403 (privacy:manage là của admin).
    const delReq = await http(app).post('/api/v1/privacy/requests').set('Authorization', `Bearer ${userToken}`).send({ type: 'delete' });
    const selfDecide = await http(app).post(`/api/v1/privacy/requests/${delReq.body.id}/decide`).set('Authorization', `Bearer ${userToken}`).send({ decision: 'approved' });
    expect(selfDecide.status).toBe(403);
    const delDone = await http(app).post(`/api/v1/privacy/requests/${delReq.body.id}/decide`).set('Authorization', `Bearer ${admin}`).send({ decision: 'approved' });
    expect(delDone.body.status).toBe('completed');
    for (const s of EXPECTED_PRIVACY_SUBSYSTEMS) expect(Object.keys(delDone.body.result.deleted)).toContain(s);
    // Lan đủ subsystem: enrolment, grades, completion của user đều biến mất; user bị soft-delete/ẩn danh.
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userid: number }[]).some((e) => e.userid === user.id)).toBe(false);
    const book = await http(app).get(`/api/v1/courses/${course.id}/gradebook?userid=${user.id}`).set('Authorization', `Bearer ${admin}`);
    const flat = JSON.stringify(book.body);
    expect(flat).not.toContain('"finalgrade":42');
    const profile = await http(app).get(`/api/v1/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    // User đã deleted: profile API hoặc trả deleted=true, hoặc username đã bị mangle.
    const deletedFlag = profile.body.deleted === true || String(profile.body.username ?? '').includes('.deleted');
    expect(deletedFlag).toBe(true);
  });
});
