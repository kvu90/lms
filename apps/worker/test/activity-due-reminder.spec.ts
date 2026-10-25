import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import { ActivityDueReminderProcessor } from '../src/processors/activity-due-reminder.processor';
import { assignments, assignSubmissions, enrol, examPins, outboxEvents, userEnrolments } from '@lms/db-schema';
import { WorkerModule } from '../src/worker.module';

/**
 * Lát N5 (issue #50): nhắc hạn nộp tự động trước 24 giờ.
 *
 * Phía phát (worker): lượt quét activity-due-reminders tìm pin có
 * time_close thuộc (hiện tại, hiện tại + 24h] và phát ĐÚNG MỘT sự
 * kiện outbox `activity_due_reminder` cho từng (học sinh, pin) chưa
 * nộp — học sinh đã có attempt hoàn tất (needsgrading/finished) thì
 * không nhắc, attempt inprogress (chưa nộp) vẫn nhắc; chạy lại không
 * phát trùng (dedupe theo (userId, pinId, timeClose) trên outbox);
 * giáo viên dời hạn thì mốc hạn mới được nhắc lại.
 *
 * NB-1 (issue #174): cùng lượt quét phủ thêm BÀI TẬP theo
 * assignments.due_date — sự kiện mang activityType 'assign' +
 * assignmentId; "chưa nộp" = chưa có bản nộp ở trạng thái submitted
 * (bản nháp vẫn nhắc); dedupe theo (userId, assignmentId, dueDate).
 *
 * Nửa API (sự kiện → thông báo activity_due_soon) được kiểm chứng ở
 * apps/api/test/notifications-providers-flow.e2e-spec.ts bằng đúng
 * hình dạng sự kiện phát ở đây.
 */
describe('Worker activity due-soon reminders (N5, issue #50)', () => {
  let context: INestApplicationContext;
  let db: any;
  const suffix = Date.now();

  const uid = (n: number) => `01900000-0000-7000-8000-${String(910000 + n * 37 + (suffix % 1000)).padStart(12, '0')}`;
  const HOUR = 3600_000;

  async function makeQuiz(opts: { closeInHours: number | null; courseVisible?: boolean; cmVisible?: boolean; name?: string }) {
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`n5-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const short = `n5${suffix}${Math.floor(Math.random() * 1e9)}`;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'N5 course', ${short}, ${opts.courseVisible ?? true}, ${await fixtureClassId()}) returning id`);
    const cid = (courseRows.rows[0] as { id: string }).id;
    const secRows = await db.execute(sql`insert into course_sections (course, section) values (${cid}, 0) returning id`);
    const secId = (secRows.rows[0] as { id: string }).id;
    const cmRows = await db.execute(sql`insert into course_modules (course, section, component, visible) values (${cid}, ${secId}, 'mod_quiz', ${opts.cmVisible ?? true}) returning id`);
    const cmId = (cmRows.rows[0] as { id: string }).id;
    const timeClose = opts.closeInHours === null ? null : new Date(Date.now() + opts.closeInHours * HOUR);
    // Sau gộp Đề (#226): hoạt động được nhắc là LẦN GHIM (exam_pins)
    // — dựng tối thiểu bank → đề → version → pin bằng SQL như các
    // fixture khác của suite worker.
    const bankRows = await db.execute(sql`insert into question_banks (name, bank_kind, scope, context_id, created_by) values ('N5 bank', 'exam', 'platform', gen_random_uuid(), ${uid(900)}) returning id`);
    const bankId = (bankRows.rows[0] as { id: string }).id;
    const examRows = await db.execute(sql`insert into exams (bank_id, created_by, status) values (${bankId}, ${uid(900)}, 'ready') returning id`);
    const examId = (examRows.rows[0] as { id: string }).id;
    const verRows = await db.execute(sql`insert into exam_versions (exam_id, version, name, created_by) values (${examId}, 1, ${opts.name ?? 'Quiz N5'}, ${uid(900)}) returning id`);
    const versionId = (verRows.rows[0] as { id: string }).id;
    const pinRows = await db.execute(sql`insert into exam_pins (exam_id, exam_version_id, course_id, cm_id, time_close, variants, created_by) values (${examId}, ${versionId}, ${cid}, ${cmId}, ${timeClose}, '[]'::jsonb, ${uid(900)}) returning id`);
    const pinId = (pinRows.rows[0] as { id: string }).id;
    const [inst] = await db.insert(enrol).values({ courseId: cid, enrol: 'manual', status: 0 }).returning();
    return { courseId: cid, quizId: pinId, instanceId: inst.id as string, timeClose };
  }

  async function enrolStudent(instance: string, userId: string, overrides: Record<string, unknown> = {}) {
    const [row] = await db.insert(userEnrolments).values({
      enrolId: instance, userId, status: 0, timeStart: new Date(Date.now() - 24 * HOUR), ...overrides,
    }).returning();
    return row.id as string;
  }

  async function addAttempt(quizId: string, userId: string, state: string) {
    const usageRows = await db.execute(sql`insert into question_usages (component, user_id) values ('mod_quiz', ${userId}) returning id`);
    const usageId = (usageRows.rows[0] as { id: string }).id;
    await db.execute(sql`insert into exam_attempts (pin_id, user_id, attempt_number, usage_id, state, preview) values (${quizId}, ${userId}, 1, ${usageId}, ${state}, false)`);
  }

  async function eventsFor(quizId: string, userId?: string) {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'activity_due_reminder'));
    return (rows as { payload: { pinId?: string; userId?: string; timeClose?: string } }[])
      .filter((e) => e.payload.pinId === quizId && (userId === undefined || e.payload.userId === userId));
  }

  async function makeAssignment(opts: { dueInHours: number | null; courseVisible?: boolean; cmVisible?: boolean; name?: string }) {
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`nb1-cat-${suffix}-${Math.random()}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const short = `nb1${suffix}${Math.floor(Math.random() * 1e9)}`;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, visible, class_id) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'NB1 course', ${short}, ${opts.courseVisible ?? true}, ${await fixtureClassId()}) returning id`);
    const cid = (courseRows.rows[0] as { id: string }).id;
    const secRows = await db.execute(sql`insert into course_sections (course, section) values (${cid}, 0) returning id`);
    const secId = (secRows.rows[0] as { id: string }).id;
    const cmRows = await db.execute(sql`insert into course_modules (course, section, component, visible) values (${cid}, ${secId}, 'mod_assign', ${opts.cmVisible ?? true}) returning id`);
    const cmId = (cmRows.rows[0] as { id: string }).id;
    const dueDate = opts.dueInHours === null ? null : new Date(Date.now() + opts.dueInHours * HOUR);
    const [assignment] = await db.insert(assignments).values({ course: cid, cmId, name: opts.name ?? 'Bài tập NB1', dueDate }).returning();
    const [inst] = await db.insert(enrol).values({ courseId: cid, enrol: 'manual', status: 0 }).returning();
    return { courseId: cid, assignmentId: assignment.id as string, instanceId: inst.id as string, dueDate };
  }

  async function addSubmission(assignmentId: string, userId: string, status: string) {
    await db.insert(assignSubmissions).values({ assignmentId, userId, status, attemptNumber: 1 });
  }

  async function eventsForAssignment(assignmentId: string, userId?: string) {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'activity_due_reminder'));
    return (rows as { payload: { assignmentId?: string; userId?: string; activityType?: string; timeClose?: string } }[])
      .filter((e) => e.payload.assignmentId === assignmentId && (userId === undefined || e.payload.userId === userId));
  }


  // CLASS-0 đóng gói (PR #200): khoá dạy thật phải có class_id (CHECK
  // course_class_required_check) — lớp fixture cho tenant worker-fixture,
  // chủ lớp là user fixture riêng; mỗi lần gọi dựng một lớp mới.
  async function fixtureClassId(): Promise<string> {
    const ownerId = '01980000-0000-7000-8000-00000000c1a5';
    await db.execute(sql`insert into users (id, username, email, suspended, deleted) values (${ownerId}, 'wk-class-owner', 'wk-class-owner@x.io', false, false) on conflict (id) do nothing`);
    const coh = await db.execute(sql`insert into cohort (tenant_id, name, context_id, component, visible) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture cohort', '01990000-0000-7000-8000-0000000000a1', 'class', false) returning id`);
    const cohId = (coh.rows[0] as { id: string }).id;
    const cls = await db.execute(sql`insert into classes (tenant_id, name, owner_id, cohort_id) values ((select id from tenants where slug = 'worker-fixture'), 'wk fixture class', ${ownerId}, ${cohId}) returning id`);
    return (cls.rows[0] as { id: string }).id;
  }
  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
  });
  afterAll(async () => { await context.close(); });

  it('reminds each not-yet-submitted enrolled student exactly once; re-running the sweep does not duplicate', async () => {
    const { quizId, instanceId: inst } = await makeQuiz({ closeInHours: 12 });
    const noAttempt = uid(1);
    const finished = uid(2);
    const inProgress = uid(3);
    const suspendedEnrol = uid(4);
    const expiredEnrol = uid(5);
    // Attempt tạo TRƯỚC ghi danh: scheduler nền của WorkerModule có
    // thể quét chen giữa các bước dựng dữ liệu — thứ tự này bảo đảm
    // học sinh "đã nộp" luôn nhất quán (đã có attempt hoàn tất) ở mọi
    // thời điểm quét, và mọi khẳng định đều dựa trên SỰ KIỆN outbox
    // bền thay vì kết quả trả về của một lượt gọi cụ thể.
    await addAttempt(quizId, finished, 'finished');
    await addAttempt(quizId, inProgress, 'inprogress');
    await enrolStudent(inst, noAttempt);
    await enrolStudent(inst, finished);
    await enrolStudent(inst, inProgress);
    await enrolStudent(inst, suspendedEnrol, { status: 1 });
    await enrolStudent(inst, expiredEnrol, { timeEnd: new Date(Date.now() - HOUR) });

    const processor = context.get(ActivityDueReminderProcessor);
    await processor.process({ data: {} } as never);
    await processor.process({ data: {} } as never);
    expect(await eventsFor(quizId, noAttempt)).toHaveLength(1);
    expect(await eventsFor(quizId, inProgress)).toHaveLength(1);
    expect(await eventsFor(quizId, finished)).toHaveLength(0);
    expect(await eventsFor(quizId, suspendedEnrol)).toHaveLength(0);
    expect(await eventsFor(quizId, expiredEnrol)).toHaveLength(0);
    expect(await eventsFor(quizId)).toHaveLength(2);

    // Lượt quét sau nữa (job chạy lại): không phát trùng cho cùng mốc hạn.
    await processor.process({ data: {} } as never);
    expect(await eventsFor(quizId, noAttempt)).toHaveLength(1);
    expect(await eventsFor(quizId, inProgress)).toHaveLength(1);
    expect(await eventsFor(quizId)).toHaveLength(2);
  });

  it('ignores quizzes outside the 24h window, already closed, without a deadline, in hidden courses, or behind hidden modules', async () => {
    const processor = context.get(ActivityDueReminderProcessor);
    const cases = [
      await makeQuiz({ closeInHours: 48 }),
      await makeQuiz({ closeInHours: -1 }),
      await makeQuiz({ closeInHours: null }),
      await makeQuiz({ closeInHours: 12, courseVisible: false }),
      await makeQuiz({ closeInHours: 12, cmVisible: false }),
    ];
    for (const [i, c] of cases.entries()) {
      await enrolStudent(c.instanceId, uid(10 + i));
    }
    await processor.process({ data: {} } as never);
    for (const c of cases) {
      expect(await eventsFor(c.quizId)).toHaveLength(0);
    }
  });

  it('a moved deadline is a new deadline: the student is reminded again for the new timeClose only', async () => {
    const { quizId, instanceId: inst, timeClose } = await makeQuiz({ closeInHours: 12 });
    const student = uid(30);
    await enrolStudent(inst, student);
    const processor = context.get(ActivityDueReminderProcessor);
    await processor.process({ data: {} } as never);
    expect(await eventsFor(quizId, student)).toHaveLength(1);

    const newClose = new Date(Date.now() + 20 * HOUR);
    await db.update(examPins).set({ timeClose: newClose }).where(eq(examPins.id, quizId));
    await processor.process({ data: {} } as never);
    const events = await eventsFor(quizId, student);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.timeClose).sort()).toEqual([timeClose!.toISOString(), newClose.toISOString()].sort());

    await processor.process({ data: {} } as never);
    expect(await eventsFor(quizId, student)).toHaveLength(2);
  });

  it('NB-1: reminds enrolled students about an assignment due within 24h exactly once; submitted students are skipped, draft-only students are reminded', async () => {
    const { assignmentId, instanceId: inst } = await makeAssignment({ dueInHours: 12 });
    const noSubmission = uid(41);
    const draftOnly = uid(42);
    const submitted = uid(43);
    const suspendedEnrol = uid(44);
    // Bản nộp tạo TRƯỚC ghi danh như khuôn attempt của quiz: scheduler
    // nền có thể quét chen giữa các bước dựng dữ liệu.
    await addSubmission(assignmentId, draftOnly, 'draft');
    await addSubmission(assignmentId, submitted, 'submitted');
    await enrolStudent(inst, noSubmission);
    await enrolStudent(inst, draftOnly);
    await enrolStudent(inst, submitted);
    await enrolStudent(inst, suspendedEnrol, { status: 1 });

    const processor = context.get(ActivityDueReminderProcessor);
    await processor.process({ data: {} } as never);
    await processor.process({ data: {} } as never);
    expect(await eventsForAssignment(assignmentId, noSubmission)).toHaveLength(1);
    expect(await eventsForAssignment(assignmentId, draftOnly)).toHaveLength(1);
    expect(await eventsForAssignment(assignmentId, submitted)).toHaveLength(0);
    expect(await eventsForAssignment(assignmentId, suspendedEnrol)).toHaveLength(0);
    const events = await eventsForAssignment(assignmentId);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.payload.activityType === 'assign')).toBe(true);
  });

  it('NB-1: ignores assignments outside the 24h window, already past due, without a deadline, in hidden courses, or behind hidden modules', async () => {
    const processor = context.get(ActivityDueReminderProcessor);
    const cases = [
      await makeAssignment({ dueInHours: 48 }),
      await makeAssignment({ dueInHours: -1 }),
      await makeAssignment({ dueInHours: null }),
      await makeAssignment({ dueInHours: 12, courseVisible: false }),
      await makeAssignment({ dueInHours: 12, cmVisible: false }),
    ];
    for (const [i, c] of cases.entries()) {
      await enrolStudent(c.instanceId, uid(50 + i));
    }
    await processor.process({ data: {} } as never);
    for (const c of cases) {
      expect(await eventsForAssignment(c.assignmentId)).toHaveLength(0);
    }
  });

  it('NB-1: a moved assignment deadline is reminded again for the new dueDate only', async () => {
    const { assignmentId, instanceId: inst, dueDate } = await makeAssignment({ dueInHours: 12 });
    const student = uid(60);
    await enrolStudent(inst, student);
    const processor = context.get(ActivityDueReminderProcessor);
    await processor.process({ data: {} } as never);
    expect(await eventsForAssignment(assignmentId, student)).toHaveLength(1);

    const newDue = new Date(Date.now() + 20 * HOUR);
    await db.update(assignments).set({ dueDate: newDue }).where(eq(assignments.id, assignmentId));
    await processor.process({ data: {} } as never);
    const events = await eventsForAssignment(assignmentId, student);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.timeClose).sort()).toEqual([dueDate!.toISOString(), newDue.toISOString()].sort());
  });
});
