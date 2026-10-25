import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';

/**
 * Lát N1 (issue #49): nối dây 3 provider thông báo từng là CÔNG TẮC GIẢ
 * (grade_updated / course_completed / enrol_expiry_warning) + provider
 * tin nhắn mới (message_new) qua NotificationEventsConsumer — consumer
 * quét outbox đã commit rồi gọi MessagingService.notify().
 *
 * Tiêu chí kiểm chứng theo issue:
 *  - Học sinh nhận thông báo THẬT từ sự kiện nghiệp vụ (chấm điểm qua
 *    API, tự đánh dấu hoàn thành khoá, sự kiện cảnh báo hết hạn mà
 *    worker enrol-expiry phát, tin nhắn của liên hệ).
 *  - Nội dung thông báo điểm KHÔNG chứa điểm số ở bất kỳ kênh nào
 *    (luật tối thiểu hoá — chuẩn Canvas).
 *  - Thông báo tin nhắn KHÔNG chứa nội dung tin; nhiều tin trong cùng
 *    conversation gộp thành một thông báo khi còn chưa đọc.
 *  - Trang cài đặt (GET /messages/preferences) chỉ còn provider đã
 *    nối dây, mỗi provider mang phân loại 3 nhóm.
 *
 * Sự kiện enrol_expiry_warning do worker phát được kiểm chứng ở suite
 * worker (enrol-completion-jobs.spec); ở đây chèn đúng sự kiện đó vào
 * outbox để kiểm chứng nửa API: sự kiện → thông báo.
 */
describe('Notification providers wired (N1, issue #49)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  interface Notif { id: string; eventType: string; subject: string; fullMessage: string; contextUrl: string | null; timeRead: string | null }

  async function notificationsOf(token: string): Promise<Notif[]> {
    // Trung tâm v2 (issue #51): danh sách phẳng chuyển sang /notifications/items
    // (GET /notifications nay là danh sách GỘP) — helper bóc .items, assertion giữ nguyên.
    const res = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { items: Notif[] }).items;
  }

  /** Chờ consumer (nhịp quét 500ms) biến sự kiện thành notification thuộc loại cho trước. */
  async function waitForNotification(token: string, eventType: string, timeoutMs = 20000, predicate: (n: Notif) => boolean = () => true): Promise<Notif> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await notificationsOf(token)).find((n) => n.eventType === eventType && predicate(n));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`notification ${eventType} did not arrive within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function setupStudentInCourse() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const token = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { course, instance, student, token };
  }

  it('grade_updated: grading through the API notifies the student once, and the content never contains the score', async () => {
    const { course, student, token } = await setupStudentInCourse();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Bài kiểm tra 15 phút', gradeMax: 100 });
    await setGrade(app, admin, item.id, student.id, 73.5);

    const notif = await waitForNotification(token, 'grade_updated');
    expect(notif.subject).toContain(course.fullName ?? '');
    expect(notif.contextUrl).toBe(`/courses/${course.id}/grades`);
    // Luật tối thiểu hoá: điểm số không xuất hiện trong subject/body.
    expect(notif.subject).not.toContain('73.5');
    expect(notif.fullMessage).not.toContain('73.5');
    expect(notif.fullMessage).toContain('Bài kiểm tra 15 phút');

    // Tính lại tổng (regradeUser phát thêm sự kiện cho item tổng) không
    // sinh thông báo thứ hai: chờ thêm vài nhịp quét rồi đếm lại.
    await new Promise((r) => setTimeout(r, 2500));
    const all = (await notificationsOf(token)).filter((n) => n.eventType === 'grade_updated');
    expect(all).toHaveLength(1);
  });

  it('course_completed: self-marking completion notifies the student', async () => {
    const { course, token } = await setupStudentInCourse();
    const put = await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`)
      .set('Authorization', `Bearer ${admin}`).send({ method: 1, criteria: [{ criteriaType: 'self' }] });
    expect(put.status).toBeLessThan(300);
    const mark = await http(app).post(`/api/v1/courses/${course.id}/completion/self`)
      .set('Authorization', `Bearer ${token}`).send({ complete: true });
    expect(mark.status).toBeLessThan(300);
    expect(mark.body.status).toBe('complete');

    const notif = await waitForNotification(token, 'course_completed');
    expect(notif.contextUrl).toBe(`/courses/${course.id}`);
  });

  it('enrol_expiry_warning: the outbox event the worker sweep emits becomes a real notification', async () => {
    const { course, student, token } = await setupStudentInCourse();
    const timeEnd = new Date(Date.now() + 3 * 24 * 3600_000);
    // Đúng hình dạng sự kiện mà EnrolExpiryProcessor phát (kiểm chứng
    // phía phát ở suite worker): aggregate enrol, kèm courseId/timeEnd.
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('enrol', 'enrol_expiry_warning', $1::jsonb)`,
      [JSON.stringify({ userId: student.id, enrolmentId: '01900000-0000-7000-8000-000000000001', enrolId: '01900000-0000-7000-8000-000000000002', courseId: course.id, timeEnd: timeEnd.toISOString() })],
    );
    const notif = await waitForNotification(token, 'enrol_expiry_warning');
    expect(notif.contextUrl).toBe(`/courses/${course.id}`);
    expect(notif.subject.length).toBeGreaterThan(0);
  });

  it('activity_due_soon: the outbox event the worker due-date sweep emits becomes a real notification deep-linking to the quiz (N5, issue #50)', async () => {
    const { course, student, token } = await setupStudentInCourse();
    const quizId = '01900000-0000-7000-8000-000000000050';
    const timeClose = new Date(Date.now() + 12 * 3600_000);
    // Đúng hình dạng sự kiện mà ActivityDueReminderProcessor phát
    // (kiểm chứng phía phát ở suite worker activity-due-reminder):
    // aggregate activity, payload mang activityName + mốc hạn.
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('activity', 'activity_due_reminder', $1::jsonb)`,
      [JSON.stringify({ userId: student.id, courseId: course.id, quizId, activityType: 'quiz', activityName: 'Bài kiểm tra chương 1', timeClose: timeClose.toISOString() })],
    );
    const notif = await waitForNotification(token, 'activity_due_soon');
    expect(notif.contextUrl).toBe(`/courses/${course.id}/quizzes/${quizId}`);
    expect(notif.subject).toContain('Bài kiểm tra chương 1');
    expect(notif.fullMessage).toContain('Bài kiểm tra chương 1');
    expect(notif.fullMessage).toContain(course.fullName ?? '');
  });

  it('message_new: a contact message notifies the recipient once per conversation while unread, without the message text', async () => {
    const aUser = await createUserViaApi(app, admin);
    const bUser = await createUserViaApi(app, admin);
    const aToken = (await login(app, aUser.username, STRONG_PASSWORD)).accessToken;
    const bToken = (await login(app, bUser.username, STRONG_PASSWORD)).accessToken;
    // Kết bạn qua luồng yêu cầu–chấp nhận (Lớp B #33) để mở cổng liên lạc.
    const req = await http(app).post(`/api/v1/messages/contacts/${bUser.id}`).set('Authorization', `Bearer ${aToken}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${aUser.id}/accept`).set('Authorization', `Bearer ${bToken}`).send({});
    expect(acc.status).toBe(201);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [bUser.id] });
    expect(conv.status).toBeLessThan(300);
    const conversationId = conv.body.id as string;

    const secret = 'NOI-DUNG-BI-MAT-4927';
    const sent = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${aToken}`).send({ text: secret });
    expect(sent.status).toBeLessThan(300);

    const notif = await waitForNotification(bToken, 'message_new');
    expect(notif.subject).not.toContain(secret);
    expect(notif.fullMessage).not.toContain(secret);
    expect(notif.contextUrl).toBe(`/messages?conversation=${conversationId}`);

    // Tin thứ hai trong cùng conversation, khi bản đầu còn chưa đọc:
    // gộp — không sinh thông báo mới.
    const sent2 = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${aToken}`).send({ text: 'tin thứ hai' });
    expect(sent2.status).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 2500));
    const afterSecond = (await notificationsOf(bToken)).filter((n) => n.eventType === 'message_new');
    expect(afterSecond).toHaveLength(1);

    // Đọc hết rồi có tin mới thì lại có thông báo mới.
    const readAll = await http(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${bToken}`).send({});
    expect(readAll.status).toBeLessThan(300);
    const sent3 = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${aToken}`).send({ text: 'tin thứ ba' });
    expect(sent3.status).toBeLessThan(300);
    await waitForNotification(bToken, 'message_new', 20000, (n) => n.timeRead === null);
    const afterThird = (await notificationsOf(bToken)).filter((n) => n.eventType === 'message_new' && n.timeRead === null);
    expect(afterThird).toHaveLength(1);
  });

  it('preferences: every listed provider is wired and carries its 3-group classification — no fake toggles remain', async () => {
    const { token } = await setupStudentInCourse();
    const res = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const groups = new Map<string, string>();
    for (const row of res.body as { provider: string; group: string }[]) groups.set(row.provider, row.group);
    // Tập provider hiện tại = đúng các provider đã nối dây (N1). Thêm
    // provider mới mà chưa nối dây sẽ làm test này đỏ — đó là chủ đích:
    // không để công tắc giả quay lại trang cài đặt.
    expect([...groups.keys()].sort()).toEqual([
      'activity_due_soon', 'badge_awarded', 'calendar_reminder', 'competency_review_requested', 'contact_request',
      'conversation_reported', 'course_completed', 'enrol_expiry_warning', 'enrol_welcome',
      'grade_updated', 'guardian_digest', 'guardian_overdue_alert', 'message_new', 'report_scheduled',
    ]);
    expect(groups.get('grade_updated')).toBe('learning');
    expect(groups.get('course_completed')).toBe('learning');
    expect(groups.get('enrol_expiry_warning')).toBe('learning');
    expect(groups.get('enrol_welcome')).toBe('learning');
    expect(groups.get('activity_due_soon')).toBe('learning');
    // PH-2 (issue #159): hai provider digest phụ huynh đã nối dây qua
    // GuardianDigestConsumer — không phải công tắc giả.
    expect(groups.get('guardian_digest')).toBe('learning');
    expect(groups.get('guardian_overdue_alert')).toBe('learning');
    expect(groups.get('message_new')).toBe('people');
    expect(groups.get('contact_request')).toBe('people');
    expect(groups.get('calendar_reminder')).toBe('system');
    expect(groups.get('report_scheduled')).toBe('system');
  });
});
