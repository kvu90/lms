import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, createReadyQuestion, pinExam } from './exam-pin-helpers';
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
    const pinId = '01900000-0000-7000-8000-000000000050';
    const timeClose = new Date(Date.now() + 12 * 3600_000);
    // Đúng hình dạng sự kiện mà ActivityDueReminderProcessor phát
    // (kiểm chứng phía phát ở suite worker activity-due-reminder):
    // aggregate activity, payload mang activityName + mốc hạn.
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('activity', 'activity_due_reminder', $1::jsonb)`,
      [JSON.stringify({ userId: student.id, courseId: course.id, pinId, activityType: 'quiz', activityName: 'Bài kiểm tra chương 1', timeClose: timeClose.toISOString() })],
    );
    const notif = await waitForNotification(token, 'activity_due_soon');
    expect(notif.contextUrl).toBe(`/courses/${course.id}/exams/${pinId}`);
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
    // NB-7: danh sách tuỳ chọn theo loại là bề mặt của nhân sự — học
    // sinh chỉ nhận phần tối thiểu (spec riêng notifications-admin-policy).
    // Audience theo vai (issue #288): danh sách ĐẦY ĐỦ cả registry chỉ
    // còn ở bề mặt của site admin (context admin phủ mọi phía người
    // nhận); nhân sự thuần chỉ thấy phía của mình — phần lọc theo vai
    // có spec riêng (notifications-preferences-v2). Ca này kiểm tính
    // "không công tắc giả" trên toàn registry nên đọc bằng admin.
    const res = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    // Mô hình v2 (NB-2, issue #174): một dòng cho mỗi provider kèm
    // nhãn/mô tả từ registry — không còn trường channel/state.
    const rows = res.body as { provider: string; group: string; label: { vi: string; en: string }; description: { vi: string; en: string } }[];
    for (const row of rows) {
      expect(row.label.vi.length).toBeGreaterThan(0);
      expect(row.label.en.length).toBeGreaterThan(0);
      expect(row.description.vi.length).toBeGreaterThan(0);
      expect(row).not.toHaveProperty('state');
      expect(row).not.toHaveProperty('channel');
    }
    const groups = new Map<string, string>();
    for (const row of rows) groups.set(row.provider, row.group);
    // Tập provider hiện tại = đúng các provider đã nối dây (N1). Thêm
    // provider mới mà chưa nối dây sẽ làm test này đỏ — đó là chủ đích:
    // không để công tắc giả quay lại trang cài đặt.
    expect([...groups.keys()].sort()).toEqual([
      'activity_due_soon', 'admin_announcement', 'assignment_assigned', 'assignment_returned', 'assignment_submitted', 'badge_awarded',
      'calendar_reminder', 'competency_review_requested', 'contact_request',
      'conversation_reported', 'course_completed', 'enrol_expiry_warning', 'enrol_welcome',
      'grade_updated', 'guardian_digest', 'guardian_overdue_alert', 'message_new', 'quiz_attempt_finished',
      'quiz_available', 'report_scheduled',
    ]);
    // NB-2: admin_announcement là provider thông báo quản trị/an toàn
    // (loại bắt buộc thứ hai của P2), phát qua POST /notifications/send.
    expect(groups.get('admin_announcement')).toBe('system');
    expect(groups.get('grade_updated')).toBe('learning');
    expect(groups.get('course_completed')).toBe('learning');
    expect(groups.get('enrol_expiry_warning')).toBe('learning');
    expect(groups.get('enrol_welcome')).toBe('learning');
    expect(groups.get('activity_due_soon')).toBe('learning');
    // NB-1 (issue #174): năm provider vòng đời Bài tập/Quiz đã nối dây
    // qua cùng consumer — không phải công tắc giả.
    expect(groups.get('assignment_assigned')).toBe('learning');
    expect(groups.get('assignment_submitted')).toBe('learning');
    expect(groups.get('assignment_returned')).toBe('learning');
    expect(groups.get('quiz_available')).toBe('learning');
    expect(groups.get('quiz_attempt_finished')).toBe('learning');
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

/**
 * NB-1 (issue #174): nối dây sự kiện vòng đời Bài tập/Quiz hai chiều.
 * Mọi luồng đi qua API THẬT (tạo bài tập/quiz, nộp bài, chấm + trả
 * bài) để sự kiện outbox là sự kiện thật của module nguồn; riêng
 * quiz_attempt_finished và activity_due_reminder dạng bài tập được
 * chèn đúng hình dạng payload mà quiz/worker phát (kiểm chứng phía
 * phát ở suite worker + spec quiz), vì dựng một lượt làm bài có câu
 * tự luận trong e2e này quá nặng so với điểm cần chứng minh.
 *
 * Tiêu chí theo hồ sơ rà soát #174:
 *  - GV nhận thông báo nộp bài GỘP theo bài tập (một bản chưa đọc,
 *    số lượng chờ chấm cập nhật tại chỗ — P5) + thông báo lượt thi
 *    cần chấm tay gộp theo quiz.
 *  - HS nhận đủ: bài tập mới giao, xác nhận đã nộp, bài được trả
 *    (nội dung KHÔNG chứa điểm), quiz mới mở, nhắc hạn bài tập.
 *  - Người tắt tuỳ chọn popup của một provider thì không nhận loại đó.
 */
describe('Notification providers wired (NB-1, issue #174)', () => {
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
    const res = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { items: Notif[] }).items;
  }

  async function waitForNotification(token: string, eventType: string, timeoutMs = 20000, predicate: (n: Notif) => boolean = () => true): Promise<Notif> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await notificationsOf(token)).find((n) => n.eventType === eventType && predicate(n));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`notification ${eventType} did not arrive within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /**
   * Chờ consumer chốt kết quả phân phối kênh popup của một sự kiện cho
   * một người nhận — tín hiệu đối soát hoàn tất của lượt fan-out — rồi
   * trả trạng thái chốt ('delivered' khi thông báo được sinh,
   * 'skipped-preference' khi tuỳ chọn của người nhận đã chặn).
   *
   * Căn cứ: notify() luôn ghi đúng một dòng notification_dispatch_log
   * cho kênh popup ở cả hai kết quả trên, và consumer xử lý các sự
   * kiện outbox theo đúng thứ tự seq (mỗi sự kiện xử lý xong cho mọi
   * người nhận mới sang sự kiện kế). Dòng log của (người nhận ×
   * provider × subject của sự kiện) xuất hiện nghĩa là lượt xử lý của
   * sự kiện đó — và mọi sự kiện trước nó — đã chốt xong cho người
   * nhận này. Khẳng định PHỦ ĐỊNH (người nhận không có thông báo của
   * sự kiện) phải chờ tín hiệu này thay cho sleep cố định: đếm sau
   * tín hiệu là đếm trên trạng thái đã chốt, không còn cửa sổ xử lý
   * dở khiến ca đỏ ngẫu nhiên như lần đỏ CI đã ghi ở issue #219.
   */
  async function waitForPopupDispatchOutcome(userId: string, provider: string, subject: string, timeoutMs = 20000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await pg.query(
        `select status from notification_dispatch_log
          where user_id = $1 and provider = $2 and channel = 'popup' and subject = $3
          order by created_at desc limit 1`,
        [userId, provider, subject],
      );
      if (rows.rows.length > 0) return (rows.rows[0] as { status: string }).status;
      if (Date.now() > deadline) throw new Error(`dispatch outcome ${provider} for user ${userId} did not settle within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  interface ClassCtx {
    course: { id: string; fullName?: string };
    sectionId: string;
    teacherId: string;
    teacherToken: string;
    student: { id: string; username: string };
    studentToken: string;
    student2: { id: string; username: string };
    student2Token: string;
  }

  /** Một lớp: GV (editingteacher tại context khoá) + 2 HS ghi danh. */
  async function setupClass(): Promise<ClassCtx> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacherToken = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const student2 = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student2.id);
    const student2Token = (await login(app, student2.username, STRONG_PASSWORD)).accessToken;
    return { course, sectionId, teacherId: teacherUser.id, teacherToken, student, studentToken, student2, student2Token };
  }

  async function seedQuestion(ctx: ClassCtx): Promise<string> {
    return createReadyQuestion(app, ctx.teacherToken, 'Câu NB-1');
  }

  async function createAssignment(ctx: ClassCtx, name: string, overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    const res = await http(app).post(`/api/v1/courses/${ctx.course.id}/assignments`).set('Authorization', `Bearer ${ctx.teacherToken}`)
      .send({ sectionId: ctx.sectionId, name, grade: 10, ...overrides });
    if (res.status !== 200 && res.status !== 201) throw new Error(`create assignment failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string };
  }

  async function submitAssignment(token: string, assignmentId: string, content: string): Promise<void> {
    const up = await http(app).post(`/api/v1/assignments/${assignmentId}/submission/files`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(content), 'bai-lam.jpg');
    expect(up.status).toBe(201);
    const sub = await http(app).post(`/api/v1/assignments/${assignmentId}/submission/submit`).set('Authorization', `Bearer ${token}`);
    expect(sub.status).toBe(201);
  }

  it('assignment_created: enrolled students are notified about the new assignment; a student who disabled the provider is not', async () => {
    const ctx = await setupClass();
    const assignment = await createAssignment(ctx, 'Bài tập NB-1 số 1');
    const notif = await waitForNotification(ctx.studentToken, 'assignment_assigned');
    expect(notif.contextUrl).toBe(`/courses/${ctx.course.id}/assignments/${assignment.id}`);
    expect(notif.subject).toContain('Bài tập NB-1 số 1');

    // HS2 có tuỳ chọn popup của assignment_assigned đang TẮT (mô hình
    // v2, NB-2) → bài tập sau không báo nữa. Từ NB-7 học sinh không còn
    // tự đặt tuỳ chọn theo loại qua API (server chặn 403 — spec riêng
    // notifications-admin-policy), nên ở đây gieo thẳng hàng tuỳ chọn
    // vào DB: ca kiểm này chỉ nhắm luật "notify() tôn trọng tuỳ chọn đã
    // lưu", không nhắm bề mặt API.
    await pg.query(
      `insert into user_preferences (user_id, name, value)
       values ($1, 'message_provider_assignment_assigned_popup_v2', '0')
       on conflict (user_id, name) do update set value = excluded.value`,
      [ctx.student2.id],
    );
    const assignment2 = await createAssignment(ctx, 'Bài tập NB-1 số 2');
    const notif2 = await waitForNotification(ctx.studentToken, 'assignment_assigned', 20000,
      (n) => n.contextUrl === `/courses/${ctx.course.id}/assignments/${assignment2.id}`);
    expect(notif2).toBeTruthy();
    // Chờ consumer chốt kết quả phân phối sự kiện bài số 2 cho CHÍNH
    // HS2 trước khi đếm (issue #219): thông báo của HS1 hiện chỉ chứng
    // minh lượt fan-out đã chạy tới HS1, chưa chứng minh đã chốt cho
    // HS2. Sleep cố định 2.500ms ở đây trước đây không gắn với tín
    // hiệu hoàn tất nào và ca đã đỏ ngẫu nhiên ở CI; nay chờ dispatch
    // log kênh popup của HS2 trên đúng sự kiện này — kết quả chốt
    // phải là bị chặn theo tuỳ chọn đã tắt.
    const outcome = await waitForPopupDispatchOutcome(ctx.student2.id, 'assignment_assigned', notif2.subject);
    expect(outcome).toBe('skipped-preference');
    // HS2 đã nhận thông báo của bài số 1 (trước khi tắt) — ca kiểm là
    // bài số 2 không tới nữa.
    const student2Notifs = (await notificationsOf(ctx.student2Token)).filter((n) => n.eventType === 'assignment_assigned');
    expect(student2Notifs).toHaveLength(1);
    expect(student2Notifs.filter((n) => n.contextUrl === `/courses/${ctx.course.id}/assignments/${assignment2.id}`)).toHaveLength(0);
  });

  it('assignment_submitted: the student gets a receipt and the teacher gets ONE grouped notification whose count updates in place (P5)', async () => {
    const ctx = await setupClass();
    const assignment = await createAssignment(ctx, 'Bài tập nộp NB-1');

    await submitAssignment(ctx.studentToken, assignment.id, 'bai-lam-hs-1');
    const receipt = await waitForNotification(ctx.studentToken, 'assignment_submitted',
      20000, (n) => n.subject.includes('Đã nộp bài'));
    expect(receipt.contextUrl).toBe(`/courses/${ctx.course.id}/assignments/${assignment.id}`);
    const teacherFirst = await waitForNotification(ctx.teacherToken, 'assignment_submitted',
      20000, (n) => n.fullMessage.includes('Có 1 bài nộp'));
    expect(teacherFirst.contextUrl).toBe(`/courses/${ctx.course.id}/assignments/${assignment.id}`);

    await submitAssignment(ctx.student2Token, assignment.id, 'bai-lam-hs-2');
    // Bản gộp của GV được CẬP NHẬT số lượng tại chỗ — vẫn đúng 1 bản.
    await waitForNotification(ctx.teacherToken, 'assignment_submitted',
      20000, (n) => n.fullMessage.includes('Có 2 bài nộp'));
    const teacherAll = (await notificationsOf(ctx.teacherToken)).filter((n) => n.eventType === 'assignment_submitted');
    expect(teacherAll).toHaveLength(1);
    // HS2 cũng có xác nhận nộp của chính mình.
    const receipt2 = await waitForNotification(ctx.student2Token, 'assignment_submitted',
      20000, (n) => n.subject.includes('Đã nộp bài'));
    expect(receipt2).toBeTruthy();
  });

  it('assignment_returned: the student is notified that the work was returned, with no score in the content', async () => {
    const ctx = await setupClass();
    const assignment = await createAssignment(ctx, 'Bài tập trả NB-1');
    await submitAssignment(ctx.studentToken, assignment.id, 'bai-lam-tra');
    const graded = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacherToken}`)
      .send({ grade: 8.5, feedbackStrengths: 'Trình bày rõ ràng.', feedbackWeaknesses: 'Còn thiếu bước biến đổi.', feedbackProgress: 'Tiến bộ rõ.' });
    expect(graded.status).toBe(201);
    const released = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacherToken}`);
    expect(released.status).toBe(201);

    const notif = await waitForNotification(ctx.studentToken, 'assignment_returned');
    expect(notif.contextUrl).toBe(`/courses/${ctx.course.id}/assignments/${assignment.id}`);
    // Luật tối thiểu hoá: điểm số không nằm trong thông báo trả bài —
    // điểm đi đường grade_updated với contextUrl trang điểm riêng.
    expect(notif.subject).not.toContain('8.5');
    expect(notif.fullMessage).not.toContain('8.5');
    const gradeNotif = await waitForNotification(ctx.studentToken, 'grade_updated');
    expect(gradeNotif.contextUrl).toBe(`/courses/${ctx.course.id}/grades`);
  });

  it('exam_pinned: enrolled students are notified about the newly pinned exam', async () => {
    const ctx = await setupClass();
    const draft = await createExamDraft(app, ctx.teacherToken, 'Kiểm tra NB-1');
    const qid = await seedQuestion(ctx);
    await addExamSlot(app, ctx.teacherToken, draft, { questionId: qid });
    const pin = await pinExam(app, ctx.teacherToken, ctx.course.id, draft, { sectionId: ctx.sectionId });
    const pinId = pin.id as string;
    const notif = await waitForNotification(ctx.studentToken, 'quiz_available');
    expect(notif.contextUrl).toBe(`/courses/${ctx.course.id}/exams/${pinId}`);
    expect(notif.subject).toContain('Kiểm tra NB-1');
  });

  it('exam_pinned: re-pinning the same exam surfaces quiz_available grouped (no duplicate while unread)', async () => {
    const ctx = await setupClass();
    const draft = await createExamDraft(app, ctx.teacherToken, 'Kiểm tra triển khai đề NB-1');
    const qid = await seedQuestion(ctx);
    await addExamSlot(app, ctx.teacherToken, draft, { questionId: qid });
    const pin = await pinExam(app, ctx.teacherToken, ctx.course.id, draft, { sectionId: ctx.sectionId });
    const pinId = pin.id as string;
    const pinUrl = `/courses/${ctx.course.id}/exams/${pinId}`;

    // Sự kiện ghim đầu tiên đã sinh bản quiz_available; HS đọc xong.
    const first = await waitForNotification(ctx.studentToken, 'quiz_available',
      20000, (n) => n.contextUrl === pinUrl);
    const read = await http(app).post(`/api/v1/notifications/${first.id}/read`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(read.status).toBeLessThan(300);

    // Đúng hình dạng sự kiện quiz.service phát khi ghim đề (lần ghim
    // thứ hai của cùng đề vào cùng khoá — sự kiện hợp nhất #226).
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('exam', 'exam_pinned', $1::jsonb)`,
      [JSON.stringify({
        examId: draft, examVersionId: pin.versionId, pinId, courseId: ctx.course.id, actorId: ctx.teacherId,
      })],
    );
    // Bản cũ đã đọc → sự kiện ghim sinh bản MỚI (nếu consumer bỏ qua
    // exam_pinned thì chờ này hết hạn và ca kiểm đỏ).
    const second = await waitForNotification(ctx.studentToken, 'quiz_available',
      20000, (n) => n.contextUrl === pinUrl && n.id !== first.id && n.timeRead === null);
    expect(second.subject).toContain('Kiểm tra triển khai đề NB-1');
    const all = (await notificationsOf(ctx.studentToken)).filter((n) => n.eventType === 'quiz_available' && n.contextUrl === pinUrl);
    expect(all).toHaveLength(2);
    expect(all.filter((n) => n.timeRead === null)).toHaveLength(1);
  });

  it('quiz_attempt_finished: teachers get one grouped notification only for manual-grading, non-preview attempts', async () => {
    const ctx = await setupClass();
    const draft = await createExamDraft(app, ctx.teacherToken, 'Kiểm tra chấm tay NB-1');
    const qid = await seedQuestion(ctx);
    await addExamSlot(app, ctx.teacherToken, draft, { questionId: qid });
    const pin = await pinExam(app, ctx.teacherToken, ctx.course.id, draft, { sectionId: ctx.sectionId });
    const quizId = pin.id as string;

    // Một lượt làm thật ở trạng thái needsgrading (chèn đúng khuôn
    // suite worker) để số lượng chờ chấm trong nội dung gộp là 1.
    const usageRows = await pg.query(
      `insert into question_usages (component, user_id) values ('mod_quiz', $1) returning id`, [ctx.student.id]);
    const usageId = (usageRows.rows[0] as { id: string }).id;
    const attemptRows = await pg.query(
      `insert into exam_attempts (pin_id, user_id, attempt_number, usage_id, state, preview) values ($1, $2, 1, $3, 'needsgrading', false) returning id`,
      [quizId, ctx.student.id, usageId]);
    const attemptId = (attemptRows.rows[0] as { id: string }).id;

    async function emitFinished(overrides: Record<string, unknown>) {
      await pg.query(
        `insert into outbox_events (aggregate, type, payload) values ('quiz', 'quiz_attempt_finished', $1::jsonb)`,
        [JSON.stringify({
          pinId: quizId, courseId: ctx.course.id, attemptId, usageId, userId: ctx.student.id,
          attemptNumber: 1, preview: false, sumGrades: 0, needsGrading: true,
          closedDueToTimeLimit: false, actorId: ctx.student.id, ...overrides,
        })],
      );
    }

    await emitFinished({});
    const notif = await waitForNotification(ctx.teacherToken, 'quiz_attempt_finished',
      20000, (n) => n.fullMessage.includes('1 lượt làm bài'));
    expect(notif.contextUrl).toBe(`/courses/${ctx.course.id}/exams/${quizId}/results`);

    // Sự kiện trùng (cùng trạng thái) + lượt tự chấm hết + lượt
    // preview: không sinh thêm bản nào cho GV.
    await emitFinished({});
    await emitFinished({ needsGrading: false });
    await emitFinished({ preview: true });
    await new Promise((r) => setTimeout(r, 3000));
    const all = (await notificationsOf(ctx.teacherToken)).filter((n) => n.eventType === 'quiz_attempt_finished');
    expect(all).toHaveLength(1);
  });

  it('activity_due_soon: an assignment reminder event deep-links to the assignment page (NB-1 worker contract)', async () => {
    const ctx = await setupClass();
    const dueDate = new Date(Date.now() + 12 * 3600_000);
    const assignment = await createAssignment(ctx, 'Bài tập sắp hạn NB-1', { dueDate: dueDate.toISOString() });
    // Đúng hình dạng sự kiện ActivityDueReminderProcessor phát cho
    // bài tập (kiểm chứng phía phát ở suite worker): activityType
    // 'assign' + assignmentId, mốc hạn ở timeClose.
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('activity', 'activity_due_reminder', $1::jsonb)`,
      [JSON.stringify({
        userId: ctx.student.id, courseId: ctx.course.id, assignmentId: assignment.id,
        activityType: 'assign', activityName: 'Bài tập sắp hạn NB-1', timeClose: dueDate.toISOString(),
      })],
    );
    const notif = await waitForNotification(ctx.studentToken, 'activity_due_soon',
      20000, (n) => n.contextUrl === `/courses/${ctx.course.id}/assignments/${assignment.id}`);
    expect(notif.subject).toContain('Bài tập sắp hạn NB-1');
  });
});
