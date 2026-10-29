import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { GuardianDigestEventsProcessor } from '../../../src/processors/guardian-digest-events.processor';
import type { OutboxEventJobData } from '../../../src/outbox-event-routes';
import {
  guardianDigests, notifications, notificationDispatchLog, outboxEvents, userPreferences,
} from '@lms/db';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * PH-2 (issue #159) — nửa TIÊU THỤ của digest phụ huynh sau khi chuyển
 * sang worker (issue con #518 của #491): năm ca hành vi vốn ở e2e phía
 * API (`guardian-ph2-digest-flow.e2e-spec.ts`, nay file đó chỉ còn ca
 * endpoint tuỳ chọn tần suất) chuyển nguyên sang tầng này, đi qua
 * ĐƯỜNG THẬT của production: chèn vết lượt `guardian_digests` +
 * sự kiện outbox như lượt quét chốt → relay outbox duy nhất đóng dấu
 * và định tuyến vào hàng đợi `guardian-digest-events` →
 * `GuardianDigestEventsProcessor` → `GuardianDigestHandlerService`
 * tổng hợp + phát qua `NotificationDeliveryService.notify`.
 *
 * Ánh xạ ca (e2e phía API cũ → spec này), giữ nguyên khẳng định
 * nghiệp vụ:
 *  1. Kết quả mới ĐÃ CÔNG BỐ → đúng 1 thông báo đếm số mục + link
 *     sâu, không điểm số/tên item ở mọi kênh (kể cả job email chỉ
 *     mang bản tối thiểu hoá), vết lượt `sent` kèm số đếm +
 *     notification_id, audit `guardian_digest_sent` không điểm;
 *     phát lại sự kiện không gửi trùng. (Ở đây khẳng định luôn qua
 *     hàng đợi: chờ job của sự kiện phát lại hoàn thành rồi mới đếm.)
 *  2. Item CHƯA công bố (posting_policy manual, không publish) →
 *     số kết quả mới = 0. Khác biệt bề mặt so với e2e cũ: ở tầng
 *     worker không có luồng API nào sinh thông báo lớp trong cửa sổ
 *     cho học sinh fixture, nên tổng cửa sổ = 0 và lượt khép
 *     `skipped_empty` với new_results_count = 0 — khẳng định cốt
 *     lõi (chưa công bố thì không tính, không rò) giữ nguyên.
 *  3. Cửa sổ rỗng → `skipped_empty`, không thông báo.
 *  4. Liên kết đã thu hồi tại thời điểm gửi → `skipped_revoked`.
 *  5. Đẩy quá hạn ≥7 ngày → 1 thông báo `guardian_overdue_alert`
 *     (tên hoạt động chỉ ở kênh trong-app; kênh email chỉ mang bản
 *     tối thiểu hoá), phát lại không trùng.
 *  6. (Ca mới của #518) Cùng một job xử lý hai lần → lần hai no-op
 *     nhờ vết lượt đã rời `queued`: ghim kỷ luật idempotent theo
 *     outboxId của chuỗi issue #491 ở tầng processor.
 *
 * Spec boot WorkerModule qua harness role thường như spec quét
 * (`guardian-digest.int-spec.ts`): module chạy bằng role
 * NOSUPERUSER/NOBYPASSRLS như production; fixture và đọc kiểm chứng
 * qua kết nối quản trị của harness. Relay/processor chạy nền trong
 * module đã boot nên các ca chờ theo trạng thái (vết lượt, trạng
 * thái job) thay vì mốc thời gian cố định.
 */
describe('Worker guardian digest delivery (PH-2, issue #159; chuyển worker ở #518)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let eventsQueue: Queue;
  let dispatchQueue: Queue;
  let eventsProcessor: GuardianDigestEventsProcessor;
  let fixtureTenantId = '';
  const suffix = Date.now();
  const DAY = 24 * 3600_000;

  const uid = (n: number) => `01900000-0000-7000-8000-${String(730000 + n * 37 + (suffix % 991)).padStart(12, '0')}`;

  /**
   * Chạy SQL thô qua kết nối quản trị và trả về các dòng — cùng khuôn
   * ép kiểu của các spec tích hợp khác trong suite: kiểu kết quả thô
   * của drizzle không khai báo `.rows` dù runtime luôn trả về.
   */
  async function execRows<T>(query: SQL): Promise<T[]> {
    const result = (await db.execute(query)) as unknown as { rows: T[] };
    return result.rows;
  }

  async function makeUser(id: string) {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${id}, ${`ph2d-${id.slice(-6)}-${suffix}`}, ${`ph2d-${id.slice(-6)}-${suffix}@x.io`}, 'An', 'Nguyễn Văn', false, false) on conflict (id) do nothing`);
  }

  /**
   * Cách ly dữ kiện email giữa các spec tích hợp: phụ huynh fixture
   * đặt tường minh tần suất email `immediate` cho hai provider digest
   * phụ huynh. Nếu để tần suất mặc định theo nhóm (`daily`), mỗi
   * dispatch email sinh ra từ các ca dưới đây sẽ nằm chờ ở trạng thái
   * `digest-queued` trong database dùng chung của suite, và lượt quét
   * tổng hợp ngày của spec email
   * (notifications/notification-email.int-spec.ts) — vốn khẳng định
   * tổng số trên TOÀN database — sẽ gom cả các mục chờ đó vào kết quả
   * của nó. Với `immediate`, dispatch vẫn đi trọn đường thật
   * (notify → hàng đợi dispatch → processor phát) nhưng chốt ngay
   * bằng một dòng dispatch log, không vào bể chờ digest; bằng chứng
   * kênh email của các ca dưới đây (job trên hàng đợi hoặc dispatch
   * log theo dedupeKey) không đổi. Luật gộp digest ngày tự nó được
   * kiểm chứng ở chính spec email.
   */
  async function setEmailImmediate(guardianId: string) {
    for (const provider of ['guardian_digest', 'guardian_overdue_alert']) {
      await db.insert(userPreferences).values({
        userId: guardianId, name: `message_provider_${provider}_email_v2`, value: 'immediate',
      }).onConflictDoNothing();
    }
  }

  async function makeLink(guardianId: string, studentId: string, status = 'active') {
    await setEmailImmediate(guardianId);
    // SQL thô như spec quét: bảng thật còn các cột NOT NULL
    // (relationship, created_by) nằm ngoài view subset của worker.
    const rows = await execRows<{ id: string }>(sql`insert into guardian_links (guardian_user_id, student_user_id, relationship, status, created_by, created_at, updated_at, tenant_id) values (${guardianId}, ${studentId}, 'Cha', ${status}, ${guardianId}, ${new Date(Date.now() - 10 * DAY)}, now(), (select id from tenants where slug = 'worker-fixture')) returning id`);
    return rows[0]!.id;
  }

  /** Lớp fixture cho tenant worker-fixture (khoá dạy thật phải có class_id — cùng khuôn spec quét). */
  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await execRows<{ id: string }>(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cohId = coh[0]!.id;
    const cls = await execRows<{ id: string }>(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${cohId}) returning id`);
    return cls[0]!.id;
  }

  /** Khoá mới + học sinh ghi danh hiệu lực (chưa hết hạn) — đủ cho đường tổng hợp của digest đọc tập khoá. */
  async function makeEnrolledCourse(studentId: string): Promise<string> {
    const catRows = await execRows<{ id: string }>(sql`insert into course_categories (name, path, tenant_id) values (${`ph2d-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = catRows[0]!.id;
    const short = `ph2d${suffix}${Math.floor(Math.random() * 1e9)}`;
    const courseRows = await execRows<{ id: string }>(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'PH2D course', ${short}, true, ${await fixtureClassId()}) returning id`);
    const courseId = courseRows[0]!.id;
    const instRows = await execRows<{ id: string }>(sql`insert into enrol (course_id, enrol, status) values (${courseId}, 'manual', 0) returning id`);
    const instId = instRows[0]!.id;
    await db.execute(sql`insert into user_enrolments (enrol_id, user_id, status, time_start) values (${instId}, ${studentId}, 0, ${new Date(Date.now() - 30 * DAY)})`);
    return courseId;
  }

  /** Item điểm thủ công + điểm của học sinh vừa chấm (updated_at = now, trong cửa sổ digest). */
  async function makeGrade(courseId: string, studentId: string, input: { itemName: string; postingPolicy: 'auto' | 'manual'; finalGrade: number }) {
    const itemRows = await execRows<{ id: string }>(sql`insert into grade_items (course_id, item_name, item_type, grade_max, posting_policy) values (${courseId}, ${input.itemName}, 'manual', 10, ${input.postingPolicy}) returning id`);
    const itemId = itemRows[0]!.id;
    await db.execute(sql`insert into grade_grades (item_id, user_id, final_grade, updated_at) values (${itemId}, ${studentId}, ${input.finalGrade}, now())`);
    return itemId;
  }

  /** Chốt một vết lượt digest như lượt quét làm + phát sự kiện outbox tương ứng; trả cả digestId lẫn outboxId. */
  async function queueDigestEvent(input: {
    guardianId: string; studentId: string; kind: 'weekly' | 'daily';
    windowStart: Date; windowEnd: Date;
  }): Promise<{ digestId: string; outboxId: string }> {
    const dedupeKey = `digest:${fixtureTenantId}:${input.guardianId}:${input.studentId}:${input.kind}:${input.windowStart.toISOString()}:int-${suffix}-${Math.random()}`;
    const [row] = await db.insert(guardianDigests).values({
      guardianUserId: input.guardianId, studentUserId: input.studentId, kind: input.kind,
      windowStart: input.windowStart, windowEnd: input.windowEnd, activityCmId: null,
      dedupeKey, status: 'queued', tenantId: fixtureTenantId,
    }).returning({ id: guardianDigests.id });
    const digestId = row!.id as string;
    const [event] = await db.insert(outboxEvents).values({
      aggregate: 'guardian', type: 'guardian_digest_due', tenantId: fixtureTenantId,
      payload: {
        guardianUserId: input.guardianId, studentUserId: input.studentId, digestId, tenantId: fixtureTenantId,
        kind: input.kind, windowStart: input.windowStart.toISOString(), windowEnd: input.windowEnd.toISOString(),
      },
    }).returning({ id: outboxEvents.id });
    return { digestId, outboxId: event!.id as string };
  }

  /** Chốt một vết lượt đẩy quá hạn như lượt quét làm + phát sự kiện outbox tương ứng. */
  async function queueOverdueEvent(input: {
    guardianId: string; studentId: string; cmId: string; courseId: string; activityName: string; dueAt: Date;
  }): Promise<{ digestId: string; outboxId: string }> {
    const dedupeKey = `overdue:${fixtureTenantId}:${input.guardianId}:${input.studentId}:${input.cmId}:int-${suffix}-${Math.random()}`;
    const [row] = await db.insert(guardianDigests).values({
      guardianUserId: input.guardianId, studentUserId: input.studentId, kind: 'overdue_alert',
      windowStart: null, windowEnd: null, activityCmId: input.cmId,
      dedupeKey, status: 'queued', tenantId: fixtureTenantId,
    }).returning({ id: guardianDigests.id });
    const digestId = row!.id as string;
    const payload = {
      guardianUserId: input.guardianId, studentUserId: input.studentId, digestId, tenantId: fixtureTenantId,
      cmId: input.cmId, activityKind: 'quiz' as const, courseId: input.courseId,
      activityName: input.activityName, dueAt: input.dueAt.toISOString(),
    };
    const [event] = await db.insert(outboxEvents).values({
      aggregate: 'guardian', type: 'guardian_overdue_alert', tenantId: fixtureTenantId, payload,
    }).returning({ id: outboxEvents.id });
    return { digestId, outboxId: event!.id as string };
  }

  async function digestRow(id: string) {
    const [row] = await db.select().from(guardianDigests).where(eq(guardianDigests.id, id));
    return row as { status: string; newResultsCount: number; notificationId: string | null };
  }

  /** Chờ vết lượt rời trạng thái queued (relay + processor đã xử lý xong sự kiện). */
  async function waitDigestStatus(id: string, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await digestRow(id);
      if (row.status !== 'queued') return row;
      if (Date.now() > deadline) throw new Error(`digest ${id} vẫn queued sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function notificationsOf(guardianId: string, eventType: string) {
    const rows = await db.select().from(notifications).where(and(
      eq(notifications.userIdTo, guardianId), eq(notifications.eventType, eventType),
    ));
    return rows as { id: string; subject: string; fullMessage: string; contextUrl: string | null; tenantId: string | null }[];
  }

  /** Chờ job của một dòng outbox trên hàng đợi sự kiện digest đạt trạng thái completed. */
  async function waitEventJobCompleted(outboxId: string, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await eventsQueue.getJob(outboxId);
      if (job && (await job.getState()) === 'completed') return;
      if (Date.now() > deadline) throw new Error(`job sự kiện ${outboxId} chưa completed sau ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /**
   * Bằng chứng kênh email của một thông báo: hoặc job dispatch còn
   * trên hàng đợi (dữ liệu job mang subject kênh ngoài), hoặc
   * processor phát kênh ngoài đã ghi dispatch log với dedupe_key =
   * jobId — cả hai đều phải chỉ chứa bản tối thiểu hoá.
   */
  async function waitEmailEvidence(jobId: string, timeoutMs = 60000): Promise<{ subject: string; raw: string }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await dispatchQueue.getJob(jobId);
      if (job) {
        const data = job.data as { subject: string };
        return { subject: data.subject, raw: JSON.stringify(job.data) };
      }
      const [log] = await db.select().from(notificationDispatchLog)
        .where(eq(notificationDispatchLog.dedupeKey, jobId));
      if (log) return { subject: (log as { subject: string }).subject, raw: JSON.stringify(log) };
      if (Date.now() > deadline) throw new Error(`không thấy job/log email ${jobId} sau ${timeoutMs}ms`);
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
    eventsQueue = context.get<Queue>(getQueueToken('guardian-digest-events'));
    dispatchQueue = context.get<Queue>(getQueueToken('notification-dispatch'));
    eventsProcessor = context.get(GuardianDigestEventsProcessor);
  });
  afterAll(async () => { await harness.close(); });

  it('kết quả mới ĐÃ CÔNG BỐ: gửi đúng 1 thông báo đếm số mục + link sâu, không điểm số ở mọi kênh, audit có vết, phát lại không trùng', async () => {
    const guardian = uid(1); const student = uid(2);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student);
    const courseId = await makeEnrolledCourse(student);
    await makeGrade(courseId, student, { itemName: 'Điểm miệng PH2 bí mật', postingPolicy: 'auto', finalGrade: 7.25 });

    const now = Date.now();
    const windowStart = new Date(now - 7 * DAY);
    const windowEnd = new Date(now + DAY);
    const { digestId } = await queueDigestEvent({ guardianId: guardian, studentId: student, kind: 'weekly', windowStart, windowEnd });

    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('sent');
    expect(row.newResultsCount).toBe(1);

    const notifs = await notificationsOf(guardian, 'guardian_digest');
    expect(notifs).toHaveLength(1);
    const notif = notifs[0]!;
    expect(notif.subject).toContain('Tổng hợp tuần');
    expect(notif.fullMessage).toContain('Kết quả mới đã công bố: 1');
    expect(notif.contextUrl).toBe(`/guardian/students/${student}`);
    expect(notif.tenantId).toBe(fixtureTenantId);
    expect(notif.fullMessage).not.toContain('7.25');
    expect(notif.fullMessage).not.toContain('Điểm miệng PH2 bí mật');
    expect(notif.subject).not.toContain('7.25');
    expect(row.notificationId).toBe(notif.id);

    // Audit: sự kiện guardian_digest_sent mang số đếm, không điểm số.
    const auditRows = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'guardian_digest_sent'));
    const audit = (auditRows as { payload: { digestId?: string } }[])
      .find((e) => e.payload.digestId === digestId);
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit!.payload)).not.toContain('7.25');

    // Kênh email: job dispatch (hoặc dispatch log của nó) chỉ mang
    // subject tối thiểu hoá — jobId mang tiền tố tenant như phía API.
    const jobId = `${fixtureTenantId}-dispatch-guardian_digest-${guardian}-email-${notif.id}`;
    const email = await waitEmailEvidence(jobId);
    expect(email.subject).toBe('Thông tin mới về việc học của con');
    expect(email.raw).not.toContain('7.25');
    expect(email.raw).not.toContain('Điểm miệng PH2 bí mật');

    // Phát lại cùng sự kiện (đường phát ít-nhất-một-lần): chờ job của
    // dòng phát lại hoàn thành rồi mới đếm — vẫn đúng 1 thông báo.
    const [replay] = await db.insert(outboxEvents).values({
      aggregate: 'guardian', type: 'guardian_digest_due', tenantId: fixtureTenantId,
      payload: {
        guardianUserId: guardian, studentUserId: student, digestId, tenantId: fixtureTenantId,
        kind: 'weekly', windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
      },
    }).returning({ id: outboxEvents.id });
    await waitEventJobCompleted(replay!.id as string);
    expect(await notificationsOf(guardian, 'guardian_digest')).toHaveLength(1);

    // Phụ huynh khác không nhận digest của con người khác.
    const other = uid(3);
    await makeUser(other);
    expect(await notificationsOf(other, 'guardian_digest')).toHaveLength(0);
  }, 180000);

  it('item CHƯA công bố (chính sách manual, chưa publish): số kết quả mới bằng 0, lượt khép skipped_empty, không rò tên item hay điểm', async () => {
    const guardian = uid(4); const student = uid(5);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student);
    const courseId = await makeEnrolledCourse(student);
    await makeGrade(courseId, student, { itemName: 'Điểm chưa công bố PH2', postingPolicy: 'manual', finalGrade: 3.75 });

    const now = Date.now();
    const { digestId } = await queueDigestEvent({
      guardianId: guardian, studentId: student, kind: 'weekly',
      windowStart: new Date(now - 7 * DAY), windowEnd: new Date(now + DAY),
    });
    const row = await waitDigestStatus(digestId);
    // Cổng công bố PH-0 loại item khỏi số đếm; cửa sổ không còn gì
    // khác (tầng worker không sinh thông báo lớp cho fixture) nên
    // lượt khép skipped_empty với số kết quả mới ghi đúng 0.
    expect(row.newResultsCount).toBe(0);
    expect(row.status).toBe('skipped_empty');
    const notifs = await notificationsOf(guardian, 'guardian_digest');
    expect(notifs).toHaveLength(0);
    expect(JSON.stringify(notifs)).not.toContain('Điểm chưa công bố PH2');
    expect(JSON.stringify(notifs)).not.toContain('3.75');
  }, 180000);

  it('cửa sổ không có gì mới: lượt khép skipped_empty, không sinh thông báo', async () => {
    const guardian = uid(6); const student = uid(7);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student);

    // Cửa sổ nằm hoàn toàn trong quá khứ (trước cả ghi danh): không
    // kết quả, không thông báo, không việc nào thuộc về cửa sổ.
    const now = Date.now();
    const { digestId } = await queueDigestEvent({
      guardianId: guardian, studentId: student, kind: 'weekly',
      windowStart: new Date(now - 14 * DAY), windowEnd: new Date(now - 7 * DAY),
    });
    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('skipped_empty');
    expect(await notificationsOf(guardian, 'guardian_digest')).toHaveLength(0);
  }, 180000);

  it('liên kết đã thu hồi tại thời điểm gửi: lượt khép skipped_revoked, không gửi gì', async () => {
    const guardian = uid(8); const student = uid(9);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student, 'revoked');

    const now = Date.now();
    const { digestId } = await queueDigestEvent({
      guardianId: guardian, studentId: student, kind: 'weekly',
      windowStart: new Date(now - 7 * DAY), windowEnd: new Date(now + DAY),
    });
    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('skipped_revoked');
    expect(await notificationsOf(guardian, 'guardian_digest')).toHaveLength(0);
  }, 180000);

  it('đẩy riêng quá hạn ≥7 ngày: thông báo guardian_overdue_alert đúng một lần, tên hoạt động không ra kênh email, phát lại không trùng', async () => {
    const guardian = uid(10); const student = uid(11);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student);
    const courseId = await makeEnrolledCourse(student);
    const cmId = '01900000-0000-7000-8000-0000000000aa';

    const { digestId } = await queueOverdueEvent({
      guardianId: guardian, studentId: student, cmId, courseId,
      activityName: 'Kiểm tra chương 1', dueAt: new Date(Date.now() - 8 * DAY),
    });
    const row = await waitDigestStatus(digestId);
    expect(row.status).toBe('sent');

    const notifs = await notificationsOf(guardian, 'guardian_overdue_alert');
    expect(notifs).toHaveLength(1);
    const notif = notifs[0]!;
    expect(notif.subject).toContain('Kiểm tra chương 1');
    expect(notif.contextUrl).toBe(`/guardian/students/${student}`);
    expect(row.notificationId).toBe(notif.id);

    // Kênh email chỉ mang subject ngoài TỔNG QUÁT của đẩy quá hạn —
    // tên hoạt động tuyệt đối không ra kênh ngoài.
    const jobId = `${fixtureTenantId}-dispatch-guardian_overdue_alert-${guardian}-email-${notif.id}`;
    const email = await waitEmailEvidence(jobId);
    expect(email.subject).toBe('Có việc quá hạn 7 ngày chưa nộp');
    expect(email.raw).not.toContain('Kiểm tra chương 1');

    // Phát lại cùng sự kiện quá hạn: chờ job phát lại hoàn thành rồi
    // đếm — vẫn đúng 1 thông báo.
    const [replay] = await db.insert(outboxEvents).values({
      aggregate: 'guardian', type: 'guardian_overdue_alert', tenantId: fixtureTenantId,
      payload: {
        guardianUserId: guardian, studentUserId: student, digestId, tenantId: fixtureTenantId,
        cmId, activityKind: 'quiz', courseId,
        activityName: 'Kiểm tra chương 1', dueAt: new Date(Date.now() - 8 * DAY).toISOString(),
      },
    }).returning({ id: outboxEvents.id });
    await waitEventJobCompleted(replay!.id as string);
    expect(await notificationsOf(guardian, 'guardian_overdue_alert')).toHaveLength(1);
  }, 180000);

  it('cùng một job sự kiện xử lý hai lần: lần hai là no-op nhờ vết lượt đã rời queued — không sinh thông báo thứ hai', async () => {
    const guardian = uid(12); const student = uid(13);
    await makeUser(guardian); await makeUser(student);
    await makeLink(guardian, student);
    const courseId = await makeEnrolledCourse(student);
    await makeGrade(courseId, student, { itemName: 'Điểm miệng PH2 lần hai', postingPolicy: 'auto', finalGrade: 8.5 });

    // Chỉ chốt vết lượt, KHÔNG chèn sự kiện outbox: job được dựng
    // tay và gọi thẳng processor hai lần — đường relay không chen
    // vào ca này, khẳng định thuần về chốt idempotent của handler.
    const now = Date.now();
    const windowStart = new Date(now - 7 * DAY);
    const windowEnd = new Date(now + DAY);
    const dedupeKey = `digest:${fixtureTenantId}:${guardian}:${student}:weekly:${windowStart.toISOString()}:int-direct-${suffix}-${Math.random()}`;
    const [row] = await db.insert(guardianDigests).values({
      guardianUserId: guardian, studentUserId: student, kind: 'weekly',
      windowStart, windowEnd, activityCmId: null,
      dedupeKey, status: 'queued', tenantId: fixtureTenantId,
    }).returning({ id: guardianDigests.id });
    const digestId = row!.id as string;
    const jobData: OutboxEventJobData = {
      outboxId: '01900000-0000-7000-8000-0000000000d1', seq: 0, aggregate: 'guardian',
      type: 'guardian_digest_due', tenantId: fixtureTenantId, occurredAt: new Date().toISOString(),
      payload: {
        guardianUserId: guardian, studentUserId: student, digestId, tenantId: fixtureTenantId,
        kind: 'weekly', windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
      },
    };
    const first = await eventsProcessor.process({ data: jobData } as never);
    expect(first).toEqual({ handled: true });
    expect((await digestRow(digestId)).status).toBe('sent');
    expect(await notificationsOf(guardian, 'guardian_digest')).toHaveLength(1);

    const second = await eventsProcessor.process({ data: jobData } as never);
    expect(second).toEqual({ handled: true });
    expect(await notificationsOf(guardian, 'guardian_digest')).toHaveLength(1);
  }, 180000);
});
