import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import { ActivityDueReminderProcessor } from '../src/processors/activity-due-reminder.processor';
import { enrol, outboxEvents, quizzes, userEnrolments } from '@lms/db-schema';
import { WorkerModule } from '../src/worker.module';

/**
 * Lát N5 (issue #50): nhắc hạn nộp tự động trước 24 giờ.
 *
 * Phía phát (worker): lượt quét activity-due-reminders tìm quiz có
 * time_close thuộc (hiện tại, hiện tại + 24h] và phát ĐÚNG MỘT sự
 * kiện outbox `activity_due_reminder` cho từng (học sinh, quiz) chưa
 * nộp — học sinh đã có attempt hoàn tất (needsgrading/finished) thì
 * không nhắc, attempt inprogress (chưa nộp) vẫn nhắc; chạy lại không
 * phát trùng (dedupe theo (userId, quizId, timeClose) trên outbox);
 * giáo viên dời hạn thì mốc hạn mới được nhắc lại.
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
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name, visible) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'N5 course', ${short}, ${opts.courseVisible ?? true}) returning id`);
    const cid = (courseRows.rows[0] as { id: string }).id;
    const secRows = await db.execute(sql`insert into course_sections (course, section) values (${cid}, 0) returning id`);
    const secId = (secRows.rows[0] as { id: string }).id;
    const cmRows = await db.execute(sql`insert into course_modules (course, section, component, visible) values (${cid}, ${secId}, 'mod_quiz', ${opts.cmVisible ?? true}) returning id`);
    const cmId = (cmRows.rows[0] as { id: string }).id;
    const timeClose = opts.closeInHours === null ? null : new Date(Date.now() + opts.closeInHours * HOUR);
    const [quiz] = await db.insert(quizzes).values({ course: cid, cmId, name: opts.name ?? 'Quiz N5', timeClose }).returning();
    const [inst] = await db.insert(enrol).values({ courseId: cid, enrol: 'manual', status: 0 }).returning();
    return { courseId: cid, quizId: quiz.id as string, instanceId: inst.id as string, timeClose };
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
    await db.execute(sql`insert into quiz_attempts (quiz_id, user_id, attempt_number, usage_id, state, preview) values (${quizId}, ${userId}, 1, ${usageId}, ${state}, false)`);
  }

  async function eventsFor(quizId: string, userId?: string) {
    const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'activity_due_reminder'));
    return (rows as { payload: { quizId?: string; userId?: string; timeClose?: string } }[])
      .filter((e) => e.payload.quizId === quizId && (userId === undefined || e.payload.userId === userId));
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
    await db.update(quizzes).set({ timeClose: newClose }).where(eq(quizzes.id, quizId));
    await processor.process({ data: {} } as never);
    const events = await eventsFor(quizId, student);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.payload.timeClose).sort()).toEqual([timeClose!.toISOString(), newClose.toISOString()].sort());

    await processor.process({ data: {} } as never);
    expect(await eventsFor(quizId, student)).toHaveLength(2);
  });
});
