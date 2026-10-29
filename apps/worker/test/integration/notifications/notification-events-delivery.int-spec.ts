import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  assignments, assignSubmissions, enrol, message, messageConversationMembers, messageConversations,
  messageUsersBlocked, notifications, notificationDispatchLog, outboxEvents, userEnrolments,
  userPreferences,
} from '@lms/db';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Consumer thông báo sự kiện ở worker (issue con #520 của #491) —
 * mười bốn ca hành vi vốn ở e2e phía API chuyển nguyên sang tầng
 * này, đi qua ĐƯỜNG THẬT của production: chèn dòng sự kiện outbox
 * đúng hình dạng phía phát vẫn ghi → relay outbox duy nhất đóng dấu
 * `publishedAt` và định tuyến vào hàng đợi `notification-events` →
 * `NotificationEventsProcessor` (chống trùng theo outboxId) →
 * `NotificationEventsHandlerService` tra DB và phát qua bề mặt
 * dùng chung `NotificationDeliveryService.notify`.
 *
 * Ánh xạ ca (nguồn cũ → spec này), giữ nguyên khẳng định nghiệp vụ:
 *  - `notifications-providers-flow.e2e-spec.ts` (API): grade_updated
 *    (nội dung không chứa điểm số; item tổng không sinh bản thứ hai),
 *    course_completed, enrol_expiry_warning, activity_due_soon dạng
 *    đề, message_new (gộp theo conversation khi còn chưa đọc, nội
 *    dung không chứa text tin), assignment_created (+ người tắt tuỳ
 *    chọn thì không nhận), assignment_submitted (bản gộp P5 cập
 *    nhật số chờ chấm tại chỗ), assignment_returned (không điểm),
 *    exam_pinned, exam_pinned ghim lại (gộp khi chưa đọc, sinh bản
 *    mới sau khi đã đọc), quiz_attempt_finished (chỉ needsGrading,
 *    không preview, gộp), activity_due_soon dạng bài tập.
 *  - `notifications-course-overrides.e2e-spec.ts` (API): ca tắt
 *    tiếng theo khoá — thông báo thường bị chặn + dispatch log
 *    'skipped-course-mute', khoá khác vẫn tới, hai loại P3 (điểm
 *    mới, sắp hết hạn ghi danh) của chính khoá bị mute vẫn tới, gỡ
 *    mute khôi phục.
 *  - `messaging-conversation-state.e2e-spec.ts` (API): cổng tắt
 *    tiếng conversation của `message_new` — thành viên đã tắt
 *    tiếng không nhận, thành viên đã chặn người gửi không nhận,
 *    bỏ tắt tiếng thì thông báo trở lại.
 *
 * Khác biệt bề mặt duy nhất so với e2e cũ: dữ kiện (khoá, ghi danh,
 * item điểm, bài tập, lần ghim, conversation) được dựng bằng SQL
 * qua kết nối quản trị của harness thay vì qua API, và khẳng định
 * đọc ở tầng DB thay vì qua endpoint danh sách thông báo — đúng
 * tiền lệ chuyển ca của issue #518. Sự kiện được chèn đúng hình
 * dạng payload mà phía phát thật ghi (đã đối chiếu tại mã nguồn
 * của từng phía phát).
 *
 * Cách ly bể digest email dùng chung: mọi người nhận fixture đặt
 * tần suất email `immediate` cho cả chín provider có kênh email —
 * nếu để mặc định theo nhóm ('daily'), dispatch email của các ca
 * này sẽ nằm chờ `digest-queued` trong DB dùng chung và làm lệch
 * khẳng định toàn cục của spec email; với `immediate`, dispatch vẫn
 * đi trọn đường thật và chốt bằng dispatch log.
 */
describe('Worker notification events delivery (chuyển consumer ở #520)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let eventsQueue: Queue;
  let fixtureTenantId = '';
  const suffix = Date.now();
  const DAY = 24 * 3600_000;
  const HOUR = 3600_000;

  const uid = (n: number) => `01900000-0000-7000-8000-${String(520000 + n * 37 + (suffix % 991)).padStart(12, '0')}`;

  /** Chín provider có kênh email của consumer thông báo sự kiện. */
  const EMAIL_PROVIDERS = [
    'grade_updated', 'enrol_expiry_warning', 'activity_due_soon', 'assignment_assigned',
    'assignment_submitted', 'assignment_returned', 'quiz_available', 'quiz_attempt_finished',
    'message_new',
  ];

  async function execRows<T>(query: SQL): Promise<T[]> {
    const result = (await db.execute(query)) as unknown as { rows: T[] };
    return result.rows;
  }

  async function makeUser(id: string, firstName = 'An', lastName = 'Nguyễn Văn') {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${id}, ${`ne520-${id.slice(-6)}-${suffix}`}, ${`ne520-${id.slice(-6)}-${suffix}@x.io`}, ${firstName}, ${lastName}, false, false) on conflict (id) do nothing`);
    for (const provider of EMAIL_PROVIDERS) {
      await db.insert(userPreferences).values({
        userId: id, name: `message_provider_${provider}_email_v2`, value: 'immediate',
      }).onConflictDoNothing();
    }
  }

  /** Lớp fixture cho tenant worker-fixture (khoá dạy thật phải có class_id — cùng khuôn các spec worker khác). */
  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await execRows<{ id: string }>(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cls = await execRows<{ id: string }>(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${coh[0]!.id}) returning id`);
    return cls[0]!.id;
  }

  async function makeCourse(name: string, visible = true): Promise<string> {
    const cat = await execRows<{ id: string }>(sql`insert into course_categories (name, path, tenant_id) values (${`ne520-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const short = `ne520${suffix}${Math.floor(Math.random() * 1e9)}`;
    const rows = await execRows<{ id: string }>(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${cat[0]!.id}, (select tenant_id from course_categories where id = ${cat[0]!.id}), ${name}, ${short}, ${visible}, ${await fixtureClassId()}) returning id`);
    return rows[0]!.id;
  }

  async function enrolStudent(courseId: string, userId: string): Promise<void> {
    const [inst] = await db.insert(enrol).values({ courseId, enrol: 'manual', status: 0 }).returning();
    await db.insert(userEnrolments).values({
      enrolId: inst!.id as string, userId, status: 0, timeStart: new Date(Date.now() - DAY),
    });
  }

  /** Gán vai editingteacher cho giáo viên tại context của khoá (path context hợp lệ như production). */
  async function makeTeacher(courseId: string, teacherId: string): Promise<void> {
    await db.execute(sql`insert into context (id, context_level, instance_id, path, depth)
      select '01990000-0000-7000-8000-0000000000a1', 10, null, '/01990000-0000-7000-8000-0000000000a1', 1
      where not exists (select 1 from context where context_level = 10 and instance_id is null)`);
    const sys = await execRows<{ id: string }>(sql`select id from context where context_level = 10 and instance_id is null limit 1`);
    const ctx = await execRows<{ id: string }>(sql`insert into context (context_level, instance_id, path, depth) values (50, ${courseId}, '', 2) returning id`);
    const courseCtxId = ctx[0]!.id;
    await db.execute(sql`update context set path = ${`/${sys[0]!.id}/${courseCtxId}`} where id = ${courseCtxId}`);
    const shortName = `ne520teach${suffix}`;
    await db.execute(sql`insert into role (name, short_name, archetype, sort_order) values ('Teacher', ${shortName}, 'editingteacher', 3) on conflict (short_name) do nothing`);
    const role = await execRows<{ id: string }>(sql`select id from role where short_name = ${shortName}`);
    await db.execute(sql`insert into role_assignments (role_id, user_id, context_id) values (${role[0]!.id}, ${teacherId}, ${courseCtxId})`);
  }

  /** Section + course module hiển thị cho một khoá; trả cmId. Section 0 của khoá là duy nhất nên lượt dựng module thứ hai cho cùng khoá dùng lại section đã có. */
  async function makeModule(courseId: string, component: string): Promise<string> {
    await db.execute(sql`insert into course_sections (course, section) values (${courseId}, 0) on conflict (course, section) do nothing`);
    const sec = await execRows<{ id: string }>(sql`select id from course_sections where course = ${courseId} and section = 0`);
    const cm = await execRows<{ id: string }>(sql`insert into course_modules (course, section, component, visible) values (${courseId}, ${sec[0]!.id}, ${component}, true) returning id`);
    return cm[0]!.id;
  }

  async function makeAssignment(courseId: string, name: string): Promise<string> {
    const cmId = await makeModule(courseId, 'mod_assign');
    const [row] = await db.insert(assignments).values({ course: courseId, cmId, name, dueDate: null }).returning();
    return row!.id as string;
  }

  /** Bank → đề → version → lần ghim tối thiểu bằng SQL như các fixture worker khác; time_close để trống để lượt quét hạn không chen vào. */
  async function makePin(courseId: string, examName: string): Promise<string> {
    const cmId = await makeModule(courseId, 'mod_quiz');
    const bank = await execRows<{ id: string }>(sql`insert into question_banks (name, bank_kind, scope, context_id, created_by, tenant_id) values ('NE520 bank', 'exam', 'personal', ${uid(900)}, ${uid(900)}, ${fixtureTenantId}) returning id`);
    const exam = await execRows<{ id: string }>(sql`insert into exams (bank_id, created_by, status) values (${bank[0]!.id}, ${uid(900)}, 'ready') returning id`);
    const ver = await execRows<{ id: string }>(sql`insert into exam_versions (exam_id, version, name, created_by) values (${exam[0]!.id}, 1, ${examName}, ${uid(900)}) returning id`);
    const pin = await execRows<{ id: string }>(sql`insert into exam_pins (exam_id, exam_version_id, course_id, cm_id, time_close, variants, created_by) values (${exam[0]!.id}, ${ver[0]!.id}, ${courseId}, ${cmId}, null, '[]'::jsonb, ${uid(900)}) returning id`);
    return pin[0]!.id;
  }

  /** Chèn một dòng sự kiện outbox đúng hình dạng phía phát; trả outboxId để chờ job. */
  async function emit(aggregate: string, type: string, payload: Record<string, unknown>): Promise<string> {
    const [row] = await db.insert(outboxEvents).values({
      aggregate, type, tenantId: fixtureTenantId, payload,
    }).returning({ id: outboxEvents.id });
    return row!.id as string;
  }

  /** Chờ job của một dòng outbox trên hàng đợi notification-events đạt trạng thái completed. */
  async function waitJobCompleted(outboxId: string, timeoutMs = 90000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await eventsQueue.getJob(outboxId);
      if (job && (await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job sự kiện ${outboxId} chưa completed sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  interface NotifRow {
    id: string; subject: string; fullMessage: string; contextUrl: string | null;
    tenantId: string | null; timeRead: Date | null;
  }

  async function notificationsOf(userId: string, eventType: string): Promise<NotifRow[]> {
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.userIdTo, userId), eq(notifications.eventType, eventType),
    ));
    return rows as NotifRow[];
  }

  /** Chờ ít nhất một thông báo khớp điều kiện xuất hiện cho người nhận. */
  async function waitNotification(
    userId: string, eventType: string,
    predicate: (n: NotifRow) => boolean = () => true, timeoutMs = 90000,
  ): Promise<NotifRow> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await notificationsOf(userId, eventType)).find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`thông báo ${eventType} cho ${userId} không tới sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function waitDispatchLog(userId: string, provider: string, status: string, timeoutMs = 90000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await db.select().from(notificationDispatchLog).where(and(
        eq(notificationDispatchLog.userId, userId),
        eq(notificationDispatchLog.provider, provider),
        eq(notificationDispatchLog.status, status),
      ));
      if (rows.length > 0) return;
      if (Date.now() > deadline) throw new Error(`dispatch log ${provider}/${status} cho ${userId} không xuất hiện sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const tenantRows = await execRows<{ id: string }>(sql`select id from tenants where slug = 'worker-fixture'`);
    fixtureTenantId = tenantRows[0]!.id;
    eventsQueue = context.get<Queue>(getQueueToken('notification-events'));
  });
  afterAll(async () => { await harness.close(); });

  it('grade_updated: học sinh nhận đúng một thông báo điểm mới không chứa điểm số; sự kiện cho item tổng không sinh bản thứ hai', async () => {
    const student = uid(1); const teacher = uid(2);
    await makeUser(student); await makeUser(teacher);
    const courseId = await makeCourse('NE520 Khoá điểm');
    await enrolStudent(courseId, student);
    const item = await execRows<{ id: string }>(sql`insert into grade_items (course_id, item_name, item_type, grade_max, posting_policy) values (${courseId}, 'Bài kiểm tra 15 phút', 'manual', 100, 'auto') returning id`);
    const itemId = item[0]!.id;
    await db.execute(sql`insert into grade_grades (item_id, user_id, final_grade, updated_at) values (${itemId}, ${student}, 73.5, now())`);

    const eventId = await emit('grades', 'grade_updated', {
      courseId, itemId, userId: student, rawGrade: 73.5, finalGrade: 73.5, actorId: teacher,
    });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'grade_updated');
    expect(notifs).toHaveLength(1);
    const notif = notifs[0]!;
    expect(notif.subject).toContain('NE520 Khoá điểm');
    expect(notif.fullMessage).toContain('Bài kiểm tra 15 phút');
    expect(notif.subject).not.toContain('73.5');
    expect(notif.fullMessage).not.toContain('73.5');
    expect(notif.contextUrl).toBe(`/courses/${courseId}/grades`);
    expect(notif.tenantId).toBe(fixtureTenantId);

    // Sự kiện tính lại tổng (item tổng của khoá) bị cổng loại item
    // chặn: job hoàn thành mà không sinh thông báo thứ hai.
    const totalItem = await execRows<{ id: string }>(sql`insert into grade_items (course_id, item_name, item_type, grade_max, posting_policy) values (${courseId}, 'Tổng khoá', 'course', 100, 'auto') returning id`);
    const totalEventId = await emit('grades', 'grade_updated', {
      courseId, itemId: totalItem[0]!.id, userId: student, rawGrade: 73.5, finalGrade: 73.5, actorId: teacher,
    });
    await waitJobCompleted(totalEventId);
    expect(await notificationsOf(student, 'grade_updated')).toHaveLength(1);
  }, 180000);

  it('course_completed: học sinh nhận thông báo hoàn thành khoá với link về trang khoá', async () => {
    const student = uid(3);
    await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá hoàn thành');
    await enrolStudent(courseId, student);

    const eventId = await emit('completion', 'course_completed', { courseId, userId: student, actorId: student });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'course_completed');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.contextUrl).toBe(`/courses/${courseId}`);
    expect(notifs[0]!.subject).toContain('NE520 Khoá hoàn thành');
  }, 180000);

  it('enrol_expiry_warning: sự kiện quét hết hạn của worker thành thông báo thật cho học sinh', async () => {
    const student = uid(4);
    await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá hết hạn');
    await enrolStudent(courseId, student);
    const timeEnd = new Date(Date.now() + 3 * DAY);

    const eventId = await emit('enrol', 'enrol_expiry_warning', {
      userId: student, enrolmentId: uid(901), enrolId: uid(902), courseId, timeEnd: timeEnd.toISOString(),
    });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'enrol_expiry_warning');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.contextUrl).toBe(`/courses/${courseId}`);
    expect(notifs[0]!.subject.length).toBeGreaterThan(0);
  }, 180000);

  it('activity_due_soon: sự kiện nhắc hạn dạng đề thành thông báo link sâu tới trang đề', async () => {
    const student = uid(5);
    await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá nhắc hạn');
    await enrolStudent(courseId, student);
    const pinId = uid(903);
    const timeClose = new Date(Date.now() + 12 * HOUR);

    const eventId = await emit('activity', 'activity_due_reminder', {
      userId: student, courseId, pinId, activityType: 'quiz',
      activityName: 'Bài kiểm tra chương 1', timeClose: timeClose.toISOString(),
    });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'activity_due_soon');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.contextUrl).toBe(`/courses/${courseId}/exams/${pinId}`);
    expect(notifs[0]!.subject).toContain('Bài kiểm tra chương 1');
    expect(notifs[0]!.fullMessage).toContain('Bài kiểm tra chương 1');
    expect(notifs[0]!.fullMessage).toContain('NE520 Khoá nhắc hạn');
  }, 180000);

  it('message_new: tin nhắn báo người nhận đúng một bản khi còn chưa đọc và không chứa nội dung tin; đọc rồi thì tin mới sinh bản mới', async () => {
    const sender = uid(6); const recipient = uid(7);
    await makeUser(sender, 'Bình', 'Trần'); await makeUser(recipient);
    const [conv] = await db.insert(messageConversations).values({ type: 1, tenantId: fixtureTenantId }).returning();
    const conversationId = conv!.id as string;
    await db.insert(messageConversationMembers).values([
      { conversationId, userId: sender },
      { conversationId, userId: recipient },
    ]);
    const secret = 'NOI-DUNG-BI-MAT-4927';

    async function sendMessage(seq: number, text: string): Promise<string> {
      const [row] = await db.insert(message).values({
        conversationId, userIdFrom: sender, seq, fullMessage: text,
      }).returning();
      const messageId = row!.id as string;
      const eventId = await emit('messaging', 'message_sent', {
        conversationId, messageId, seq, fromUserId: sender,
        memberIds: [sender, recipient], clientMessageId: `ne520-${suffix}-${seq}`, replyToMessageId: null,
      });
      await waitJobCompleted(eventId);
      return messageId;
    }

    await sendMessage(1, secret);
    const notifs = await notificationsOf(recipient, 'message_new');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.subject).toContain('Bình Trần');
    expect(notifs[0]!.subject).not.toContain(secret);
    expect(notifs[0]!.fullMessage).not.toContain(secret);
    expect(notifs[0]!.contextUrl).toBe(`/messages?conversation=${conversationId}`);
    expect(notifs[0]!.tenantId).toBe(fixtureTenantId);
    // Người gửi không nhận thông báo cho tin của chính mình.
    expect(await notificationsOf(sender, 'message_new')).toHaveLength(0);

    // Tin thứ hai khi bản đầu còn chưa đọc: gộp — không sinh thêm.
    await sendMessage(2, 'tin thứ hai');
    expect(await notificationsOf(recipient, 'message_new')).toHaveLength(1);

    // Đọc hết rồi có tin mới thì lại có thông báo mới chưa đọc.
    await db.execute(sql`update notifications set time_read = now() where user_id_to = ${recipient} and event_type = 'message_new'`);
    await sendMessage(3, 'tin thứ ba');
    const after = await notificationsOf(recipient, 'message_new');
    expect(after).toHaveLength(2);
    expect(after.filter((n) => n.timeRead === null)).toHaveLength(1);
  }, 180000);

  it('assignment_created: học sinh ghi danh nhận thông báo bài tập mới; học sinh đã tắt tuỳ chọn provider thì không nhận bài sau', async () => {
    const teacher = uid(8); const student = uid(9); const student2 = uid(10);
    await makeUser(teacher); await makeUser(student); await makeUser(student2);
    const courseId = await makeCourse('NE520 Khoá bài tập mới');
    await enrolStudent(courseId, student);
    await enrolStudent(courseId, student2);

    const assignmentId = await makeAssignment(courseId, 'Bài tập NB-1 số 1');
    const eventId = await emit('assignments', 'assignment_created', {
      assignmentId, courseId, actorId: teacher,
    });
    await waitJobCompleted(eventId);
    const first = await notificationsOf(student, 'assignment_assigned');
    expect(first).toHaveLength(1);
    expect(first[0]!.contextUrl).toBe(`/courses/${courseId}/assignments/${assignmentId}`);
    expect(first[0]!.subject).toContain('Bài tập NB-1 số 1');
    expect(await notificationsOf(student2, 'assignment_assigned')).toHaveLength(1);

    // HS2 tắt tuỳ chọn popup của assignment_assigned (mô hình v2):
    // bài tập sau không báo nữa — kết quả chốt là dispatch log
    // 'skipped-preference' của chính HS2 trên sự kiện bài số 2.
    await db.insert(userPreferences).values({
      userId: student2, name: 'message_provider_assignment_assigned_popup_v2', value: '0',
    }).onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.name],
      set: { value: '0' },
    });
    const assignment2Id = await makeAssignment(courseId, 'Bài tập NB-1 số 2');
    const event2Id = await emit('assignments', 'assignment_created', {
      assignmentId: assignment2Id, courseId, actorId: teacher,
    });
    await waitJobCompleted(event2Id);
    await waitDispatchLog(student2, 'assignment_assigned', 'skipped-preference');
    const student2Notifs = await notificationsOf(student2, 'assignment_assigned');
    expect(student2Notifs).toHaveLength(1);
    expect(student2Notifs[0]!.contextUrl).toBe(`/courses/${courseId}/assignments/${assignmentId}`);
    expect((await notificationsOf(student, 'assignment_assigned')).length).toBe(2);
  }, 180000);

  it('assignment_submitted: người nộp nhận xác nhận và giáo viên nhận đúng một bản gộp có số chờ chấm cập nhật tại chỗ', async () => {
    const teacher = uid(11); const student = uid(12); const student2 = uid(13);
    await makeUser(teacher); await makeUser(student); await makeUser(student2);
    const courseId = await makeCourse('NE520 Khoá nộp bài');
    await enrolStudent(courseId, student);
    await enrolStudent(courseId, student2);
    await makeTeacher(courseId, teacher);
    const assignmentId = await makeAssignment(courseId, 'Bài tập nộp NB-1');

    await db.insert(assignSubmissions).values({
      assignmentId, userId: student, status: 'submitted', attemptNumber: 1,
    });
    const event1Id = await emit('assignments', 'assignment_submitted', {
      assignmentId, courseId, userId: student, attemptNumber: 1, late: false,
    });
    await waitJobCompleted(event1Id);
    const receipt = await waitNotification(student, 'assignment_submitted',
      (n) => n.subject.includes('Đã nộp bài'));
    expect(receipt.contextUrl).toBe(`/courses/${courseId}/assignments/${assignmentId}`);
    const teacherFirst = await waitNotification(teacher, 'assignment_submitted',
      (n) => n.fullMessage.includes('Có 1 bài nộp'));
    expect(teacherFirst.contextUrl).toBe(`/courses/${courseId}/assignments/${assignmentId}`);

    await db.insert(assignSubmissions).values({
      assignmentId, userId: student2, status: 'submitted', attemptNumber: 1,
    });
    const event2Id = await emit('assignments', 'assignment_submitted', {
      assignmentId, courseId, userId: student2, attemptNumber: 1, late: false,
    });
    await waitJobCompleted(event2Id);
    await waitNotification(teacher, 'assignment_submitted',
      (n) => n.fullMessage.includes('Có 2 bài nộp'));
    // Bản gộp của giáo viên vẫn đúng một bản — chỉ nội dung được cập nhật.
    expect(await notificationsOf(teacher, 'assignment_submitted')).toHaveLength(1);
    const receipt2 = await notificationsOf(student2, 'assignment_submitted');
    expect(receipt2).toHaveLength(1);
    expect(receipt2[0]!.subject).toContain('Đã nộp bài');
  }, 180000);

  it('assignment_returned: học sinh nhận thông báo trả bài và nội dung không chứa điểm số hay mức xếp loại', async () => {
    const teacher = uid(14); const student = uid(15);
    await makeUser(teacher); await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá trả bài');
    await enrolStudent(courseId, student);
    const assignmentId = await makeAssignment(courseId, 'Bài tập trả NB-1');
    await db.insert(assignSubmissions).values({
      assignmentId, userId: student, status: 'submitted', attemptNumber: 1,
    });

    const eventId = await emit('assignments', 'assignment_returned', {
      assignmentId, courseId, userId: student, graderId: teacher,
      grade: 8.5, level: 'Giỏi', attemptNumber: 1,
    });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'assignment_returned');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.contextUrl).toBe(`/courses/${courseId}/assignments/${assignmentId}`);
    expect(notifs[0]!.subject).not.toContain('8.5');
    expect(notifs[0]!.fullMessage).not.toContain('8.5');
    expect(notifs[0]!.subject).not.toContain('Giỏi');
    expect(notifs[0]!.fullMessage).not.toContain('Giỏi');
  }, 180000);

  it('exam_pinned: học sinh ghi danh nhận thông báo đề mới ghim vào khoá', async () => {
    const teacher = uid(16); const student = uid(17);
    await makeUser(teacher); await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá ghim đề');
    await enrolStudent(courseId, student);
    const pinId = await makePin(courseId, 'Kiểm tra NB-1');

    const eventId = await emit('exam_pin', 'exam_pinned', {
      examId: uid(904), examVersionId: uid(905), pinId, courseId, actorId: teacher,
    });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'quiz_available');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.contextUrl).toBe(`/courses/${courseId}/exams/${pinId}`);
    expect(notifs[0]!.subject).toContain('Kiểm tra NB-1');
  }, 180000);

  it('exam_pinned ghim lại: còn bản chưa đọc thì gộp không sinh bản mới; đã đọc rồi thì lần ghim sau sinh bản mới', async () => {
    const teacher = uid(18); const student = uid(19);
    await makeUser(teacher); await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá ghim lại');
    await enrolStudent(courseId, student);
    const pinId = await makePin(courseId, 'Kiểm tra triển khai đề NB-1');
    const payload = { examId: uid(906), examVersionId: uid(907), pinId, courseId, actorId: teacher };

    const firstId = await emit('exam_pin', 'exam_pinned', payload);
    await waitJobCompleted(firstId);
    expect(await notificationsOf(student, 'quiz_available')).toHaveLength(1);

    // Ghim lại khi bản đầu còn chưa đọc: handler gộp giữ đúng một bản.
    const secondId = await emit('exam_pin', 'exam_pinned', payload);
    await waitJobCompleted(secondId);
    expect(await notificationsOf(student, 'quiz_available')).toHaveLength(1);

    // Đọc xong bản gộp, lần ghim tiếp theo sinh bản mới chưa đọc.
    await db.execute(sql`update notifications set time_read = now() where user_id_to = ${student} and event_type = 'quiz_available'`);
    const thirdId = await emit('exam_pin', 'exam_pinned', payload);
    await waitJobCompleted(thirdId);
    const all = await notificationsOf(student, 'quiz_available');
    expect(all).toHaveLength(2);
    expect(all.filter((n) => n.timeRead === null)).toHaveLength(1);
    expect(all[0]!.contextUrl).toBe(`/courses/${courseId}/exams/${pinId}`);
  }, 180000);

  it('quiz_attempt_finished: giáo viên nhận đúng một bản gộp chỉ khi lượt làm cần chấm tay và không phải preview', async () => {
    const teacher = uid(20); const student = uid(21);
    await makeUser(teacher); await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá chấm tay');
    await enrolStudent(courseId, student);
    await makeTeacher(courseId, teacher);
    const pinId = await makePin(courseId, 'Kiểm tra chấm tay NB-1');
    const usage = await execRows<{ id: string }>(sql`insert into question_usages (component, user_id) values ('mod_quiz', ${student}) returning id`);
    const usageId = usage[0]!.id;
    const attempt = await execRows<{ id: string }>(sql`insert into exam_attempts (pin_id, user_id, attempt_number, usage_id, state, preview) values (${pinId}, ${student}, 1, ${usageId}, 'needsgrading', false) returning id`);
    const attemptId = attempt[0]!.id;

    async function emitFinished(overrides: Record<string, unknown>): Promise<void> {
      const eventId = await emit('quiz', 'quiz_attempt_finished', {
        pinId, courseId, attemptId, usageId, userId: student, attemptNumber: 1,
        preview: false, sumGrades: 0, needsGrading: true,
        closedDueToTimeLimit: false, actorId: student, ...overrides,
      });
      await waitJobCompleted(eventId);
    }

    await emitFinished({});
    const notif = await waitNotification(teacher, 'quiz_attempt_finished',
      (n) => n.fullMessage.includes('1 lượt làm bài'));
    expect(notif.contextUrl).toBe(`/courses/${courseId}/exams/${pinId}/results`);

    // Sự kiện trùng trạng thái: bản gộp cập nhật tại chỗ, không thêm bản.
    await emitFinished({});
    // Lượt tự chấm hết và lượt preview: không sinh thông báo nào.
    await emitFinished({ needsGrading: false });
    await emitFinished({ preview: true });
    expect(await notificationsOf(teacher, 'quiz_attempt_finished')).toHaveLength(1);
  }, 180000);

  it('activity_due_soon: sự kiện nhắc hạn dạng bài tập link sâu tới trang bài tập', async () => {
    const student = uid(22);
    await makeUser(student);
    const courseId = await makeCourse('NE520 Khoá hạn bài tập');
    await enrolStudent(courseId, student);
    const assignmentId = await makeAssignment(courseId, 'Bài tập sắp hạn NB-1');
    const dueDate = new Date(Date.now() + 12 * HOUR);

    const eventId = await emit('activity', 'activity_due_reminder', {
      userId: student, courseId, assignmentId, activityType: 'assign',
      activityName: 'Bài tập sắp hạn NB-1', timeClose: dueDate.toISOString(),
    });
    await waitJobCompleted(eventId);

    const notifs = await notificationsOf(student, 'activity_due_soon');
    expect(notifs).toHaveLength(1);
    expect(notifs[0]!.contextUrl).toBe(`/courses/${courseId}/assignments/${assignmentId}`);
    expect(notifs[0]!.subject).toContain('Bài tập sắp hạn NB-1');
  }, 180000);

  it('tắt tiếng theo khoá: thông báo thường của khoá bị chặn kèm dispatch log, khoá khác vẫn tới, hai loại P3 của khoá bị mute vẫn tới, gỡ mute khôi phục', async () => {
    const student = uid(23);
    await makeUser(student);
    const courseA = await makeCourse('NE520 Khoá A bị mute');
    const courseB = await makeCourse('NE520 Khoá B bình thường');
    await enrolStudent(courseA, student);
    await enrolStudent(courseB, student);
    await db.insert(userPreferences).values({
      userId: student, name: `notif.course.${courseA}`, value: 'mute',
    }).onConflictDoNothing();

    const quizA = uid(908); const quizB = uid(909);
    const timeClose = new Date(Date.now() + 12 * HOUR).toISOString();
    const eventA = await emit('activity', 'activity_due_reminder', {
      userId: student, courseId: courseA, pinId: quizA, activityType: 'quiz',
      activityName: 'Bài kiểm tra chương 1', timeClose,
    });
    const eventB = await emit('activity', 'activity_due_reminder', {
      userId: student, courseId: courseB, pinId: quizB, activityType: 'quiz',
      activityName: 'Bài kiểm tra chương 1', timeClose,
    });
    await waitJobCompleted(eventA);
    await waitJobCompleted(eventB);

    const dueSoons = await notificationsOf(student, 'activity_due_soon');
    expect(dueSoons.map((n) => n.contextUrl)).toContain(`/courses/${courseB}/exams/${quizB}`);
    expect(dueSoons.map((n) => n.contextUrl)).not.toContain(`/courses/${courseA}/exams/${quizA}`);
    await waitDispatchLog(student, 'activity_due_soon', 'skipped-course-mute');

    // P3: điểm mới của chính khoá bị mute vẫn tới.
    const item = await execRows<{ id: string }>(sql`insert into grade_items (course_id, item_name, item_type, grade_max, posting_policy) values (${courseA}, 'Bài kiểm tra 15 phút', 'manual', 100, 'auto') returning id`);
    await db.execute(sql`insert into grade_grades (item_id, user_id, final_grade, updated_at) values (${item[0]!.id}, ${student}, 61, now())`);
    const gradeEvent = await emit('grades', 'grade_updated', {
      courseId: courseA, itemId: item[0]!.id, userId: student, rawGrade: 61, finalGrade: 61, actorId: uid(910),
    });
    await waitJobCompleted(gradeEvent);
    const gradeNotifs = await notificationsOf(student, 'grade_updated');
    expect(gradeNotifs).toHaveLength(1);
    expect(gradeNotifs[0]!.contextUrl).toBe(`/courses/${courseA}/grades`);

    // P3: sắp hết hạn ghi danh của chính khoá bị mute vẫn tới.
    const expiryEvent = await emit('enrol', 'enrol_expiry_warning', {
      userId: student, enrolmentId: uid(911), enrolId: uid(912), courseId: courseA,
      timeEnd: new Date(Date.now() + 3 * DAY).toISOString(),
    });
    await waitJobCompleted(expiryEvent);
    expect(await notificationsOf(student, 'enrol_expiry_warning')).toHaveLength(1);

    // Gỡ mute: lần phát kế tiếp của khoá A tới bình thường.
    await db.execute(sql`update user_preferences set value = 'all' where user_id = ${student} and name = ${`notif.course.${courseA}`}`);
    const quizA2 = uid(913);
    const restoredEvent = await emit('activity', 'activity_due_reminder', {
      userId: student, courseId: courseA, pinId: quizA2, activityType: 'quiz',
      activityName: 'Bài kiểm tra chương 1', timeClose,
    });
    await waitJobCompleted(restoredEvent);
    const restored = await notificationsOf(student, 'activity_due_soon');
    expect(restored.map((n) => n.contextUrl)).toContain(`/courses/${courseA}/exams/${quizA2}`);
  }, 180000);

  it('tắt tiếng conversation: thành viên đã tắt tiếng và thành viên đã chặn người gửi không nhận message_new; bỏ tắt tiếng thì thông báo trở lại', async () => {
    const sender = uid(24); const mutedMember = uid(25); const normalMember = uid(26); const blockingMember = uid(27);
    await makeUser(sender); await makeUser(mutedMember); await makeUser(normalMember); await makeUser(blockingMember);
    const [conv] = await db.insert(messageConversations).values({ type: 2, tenantId: fixtureTenantId }).returning();
    const conversationId = conv!.id as string;
    await db.insert(messageConversationMembers).values([
      { conversationId, userId: sender },
      { conversationId, userId: mutedMember, muted: true },
      { conversationId, userId: normalMember },
      { conversationId, userId: blockingMember },
    ]);
    await db.insert(messageUsersBlocked).values({ userId: blockingMember, blockedUserId: sender });

    async function sendMessage(seq: number): Promise<void> {
      const [row] = await db.insert(message).values({
        conversationId, userIdFrom: sender, seq, fullMessage: `tin ${seq}`,
      }).returning();
      const eventId = await emit('messaging', 'message_sent', {
        conversationId, messageId: row!.id as string, seq, fromUserId: sender,
        memberIds: [sender, mutedMember, normalMember, blockingMember],
        clientMessageId: `ne520-mute-${suffix}-${seq}`, replyToMessageId: null,
      });
      await waitJobCompleted(eventId);
    }

    await sendMessage(1);
    expect(await notificationsOf(mutedMember, 'message_new')).toHaveLength(0);
    expect(await notificationsOf(blockingMember, 'message_new')).toHaveLength(0);
    expect(await notificationsOf(normalMember, 'message_new')).toHaveLength(1);

    // Bỏ tắt tiếng: tin kế tiếp sinh thông báo cho thành viên đó.
    await db.execute(sql`update message_conversation_members set muted = false where conversation_id = ${conversationId} and user_id = ${mutedMember}`);
    await sendMessage(2);
    expect(await notificationsOf(mutedMember, 'message_new')).toHaveLength(1);
  }, 180000);
});
