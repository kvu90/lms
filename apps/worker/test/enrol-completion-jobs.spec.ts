import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { CompletionRecalculateProcessor } from '../src/processors/completion-recalculate.processor';
import { EnrolExpiryProcessor } from '../src/processors/enrol-expiry.processor';
import {
  courseCompletionCriteria, courseCompletionCritCompl, courseCompletions, courseCompletionSettings,
  courseModulesCompletion, enrol, outboxEvents, userEnrolments,
} from '@lms/db-schema';
import { WorkerModule } from '../src/worker.module';

/**
 * Enrol & completion worker jobs. Business oracles: enrol expiry semantics from
 * enrol/tests/enrollib_test.php + report §2#5 (expired ⇒ not active), and
 * completion reaggregation from lib/tests/completionlib_test.php
 * ::test_aggregate_completions (criteria change ⇒ controlled recalculation).
 * Rows are inserted directly because the canonical API schema owns creation;
 * the processors under test operate on the worker's view of the same tables.
 */
describe('Worker enrol & completion: enrol-expiry + completion-recalculate processors', () => {
  let context: INestApplicationContext;
  let db: any;
  const suffix = Date.now();
  const userId = `01900000-0000-7000-8000-${String(900000 + (suffix % 10000)).padStart(12, '0')}`;
  const userIdB = `01900000-0000-7000-8000-${String(900100 + (suffix % 10000)).padStart(12, '0')}`;
  let instanceId = '';
  let courseId = '';
  let cmId = '';

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    // Create a real category+course+section via raw SQL (FKs in the shared DB require real rows;
    // the worker's schema view intentionally only carries the tables its processors touch).
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`worker-cat-${suffix}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'Worker course', ${`wk${suffix}`}) returning id`);
    courseId = (courseRows.rows[0] as { id: string }).id;
    const sectionRows = await db.execute(sql`insert into course_sections (course, section) values (${courseId}, 0) returning id`);
    const sectionId = (sectionRows.rows[0] as { id: string }).id;
    const [inst] = await db.insert(enrol).values({ courseId: courseId, enrol: 'manual', status: 0 }).returning();
    instanceId = inst.id;
    const cmRows = await db.execute(sql`insert into course_modules (course, section, component) values (${courseId}, ${sectionId}, 'mod_page') returning id`);
    cmId = (cmRows.rows[0] as { id: string }).id;
  });
  afterAll(async () => { await context.close(); });

  it('enrol-expiry flips ACTIVE enrolments whose timeEnd passed to SUSPENDED and writes the outbox event; future enrolments untouched', async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 3600_000);
    const [expired] = await db.insert(userEnrolments).values({ enrolId: instanceId, userId: userId, status: 0, timeStart: new Date(Date.now() - 7200_000), timeEnd: past }).returning();
    const [alive] = await db.insert(userEnrolments).values({ enrolId: instanceId, userId: userIdB, status: 0, timeStart: new Date(), timeEnd: future }).returning();
    const processor = context.get(EnrolExpiryProcessor);
    const result = await processor.process({ data: {} } as never);
    expect(result.suspendedIds).toContain(expired.id);
    expect(result.suspendedIds).not.toContain(alive.id);
    const [row] = await db.select().from(userEnrolments).where(eq(userEnrolments.id, expired.id));
    expect(row.status).toBe(1);
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'user_enrolment_suspended'));
    expect((events as { payload: { enrolmentId?: string } }[]).some((e) => e.payload.enrolmentId === expired.id)).toBe(true);
    // Idempotent: a second sweep does not flip it again.
    const second = await processor.process({ data: {} } as never);
    expect(second.suspendedIds).not.toContain(expired.id);
  });

  it('enrol-expiry warning: an ACTIVE enrolment expiring inside the warning window gets exactly one enrol_expiry_warning outbox event; outside the window none (issue #49)', async () => {
    const processor = context.get(EnrolExpiryProcessor);
    const inWindow = new Date(Date.now() + 3 * 24 * 3600_000);
    const outWindow = new Date(Date.now() + 30 * 24 * 3600_000);
    // Offset 900400/900500: 900200/900300 đã thuộc về userIdC/userIdD
    // của test criteria-types phía dưới (trùng (enrol_id, user_id) sẽ
    // vỡ ràng buộc duy nhất của user_enrolments).
    const userC = `01900000-0000-7000-8000-${String(900400 + (suffix % 10000)).padStart(12, '0')}`;
    const userD = `01900000-0000-7000-8000-${String(900500 + (suffix % 10000)).padStart(12, '0')}`;
    const [soon] = await db.insert(userEnrolments).values({ enrolId: instanceId, userId: userC, status: 0, timeStart: new Date(), timeEnd: inWindow }).returning();
    const [later] = await db.insert(userEnrolments).values({ enrolId: instanceId, userId: userD, status: 0, timeStart: new Date(), timeEnd: outWindow }).returning();
    const warningsFor = async (enrolmentId: string) => (await db.select().from(outboxEvents)
      .where(eq(outboxEvents.type, 'enrol_expiry_warning')))
      .filter((e: { payload: { enrolmentId?: string } }) => e.payload.enrolmentId === enrolmentId);
    const first = await processor.process({ data: {} } as never);
    expect(first.warnedIds).toContain(soon.id);
    expect(first.warnedIds).not.toContain(later.id);
    const events = await warningsFor(soon.id) as { payload: { userId?: string; courseId?: string } }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.userId).toBe(userC);
    expect(events[0]!.payload.courseId).toBe(courseId);
    expect(await warningsFor(later.id)).toHaveLength(0);
    // Quét lại không phát trùng cảnh báo cho cùng một ghi danh.
    const second = await processor.process({ data: {} } as never);
    expect(second.warnedIds).not.toContain(soon.id);
    expect(await warningsFor(soon.id)).toHaveLength(1);
  });

  it('completion-recalculate recomputes course completion from current criteria (AND), and reopens it when criteria tighten', async () => {
    const processor = context.get(CompletionRecalculateProcessor);
    await db.insert(courseModulesCompletion).values({ courseModuleId: cmId, userId: userId, completionState: 1, viewed: true });
    await db.insert(courseCompletionSettings).values({ course: courseId, method: 1 }).onConflictDoNothing();
    await db.insert(courseCompletionCriteria).values({ course: courseId, criteriaType: 'module', moduleInstance: cmId, sortOrder: 0 });
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.users).toBeGreaterThan(0);
    let [cc] = await db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userId, userId)));
    expect(cc.status).toBe('complete');
    expect(cc.timeCompleted).toBeTruthy();

    // Add a date criterion in the future ⇒ recalculation reopens the completion.
    await db.insert(courseCompletionCriteria).values({ course: courseId, criteriaType: 'date', date: new Date('2100-01-01'), sortOrder: 1 });
    await processor.process({ data: { courseId } } as never);
    [cc] = await db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userId, userId)));
    expect(cc.status).not.toBe('complete');
    expect(cc.timeCompleted).toBeNull();
  });

  it('completion-recalculate evaluates the remaining Moodle criteria types (course, self, duration, unenrol) like the API evaluator', async () => {
    const processor = context.get(CompletionRecalculateProcessor);
    const statusOf = async (uid: string) => {
      const [row] = await db.select().from(courseCompletions)
        .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userId, uid)));
      return row?.status as string | undefined;
    };
    const replaceCriteria = async (rows: Record<string, unknown>[]) => {
      await db.delete(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId));
      for (const [i, r] of rows.entries()) {
        await db.insert(courseCompletionCriteria).values({ course: courseId, sortOrder: i, ...r });
      }
    };

    // course (prerequisite): incomplete until the prerequisite course's
    // stored completion row is complete.
    const prereqRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name) values ((select category from course where id = ${courseId}), (select tenant_id from course where id = ${courseId}), 'Prereq course', ${`wkpre${suffix}`}) returning id`);
    const prereqId = (prereqRows.rows[0] as { id: string }).id;
    await replaceCriteria([{ criteriaType: 'course', courseInstance: prereqId }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).not.toBe('complete');
    await db.insert(courseCompletions).values({ userId: userId, course: prereqId, status: 'complete', timeCompleted: new Date() });
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).toBe('complete');

    // self: needs a crit_compl evidence row for the criterion.
    await db.delete(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId));
    const [selfCritRow] = await db.insert(courseCompletionCriteria)
      .values({ course: courseId, criteriaType: 'self', sortOrder: 0 }).returning();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).not.toBe('complete');
    await db.insert(courseCompletionCritCompl).values({ criteriaId: selfCritRow.id, userId: userId, markedBy: userId });
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).toBe('complete');

    // role: shares the markedKeys evidence path with self, but the
    // crit_compl row is written by a MARKER (markedBy ≠ the learner) —
    // "manual completion by others". The worker only reads the evidence;
    // who may write these rows is the API-side role check (issue #23 F1).
    // A real role row is required: criteria.role_id has an FK to role.id.
    const roleRows = await db.execute(sql`insert into role (name, short_name) values ('Worker marker role', ${`wkmarker${suffix}`}) returning id`);
    const markerRoleId = (roleRows.rows[0] as { id: string }).id;
    await db.delete(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId));
    const [roleCritRow] = await db.insert(courseCompletionCriteria)
      .values({ course: courseId, criteriaType: 'role', roleId: markerRoleId, sortOrder: 0 }).returning();
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).not.toBe('complete');
    await db.insert(courseCompletionCritCompl).values({ criteriaId: roleCritRow.id, userId: userId, markedBy: userIdB });
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userId)).toBe('complete');

    // duration: anchored on the enrolment timeStart (10 days ago here).
    const userIdC = `01900000-0000-7000-8000-${String(900200 + (suffix % 10000)).padStart(12, '0')}`;
    await db.insert(userEnrolments).values({ enrolId: instanceId, userId: userIdC, status: 0, timeStart: new Date(Date.now() - 10 * 86_400_000) });
    await replaceCriteria([{ criteriaType: 'duration', enrolPeriodDays: 30 }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userIdC)).not.toBe('complete');
    await replaceCriteria([{ criteriaType: 'duration', enrolPeriodDays: 7 }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userIdC)).toBe('complete');

    // unenrol: a user with a stored completion row but no live enrolment.
    const userIdD = `01900000-0000-7000-8000-${String(900300 + (suffix % 10000)).padStart(12, '0')}`;
    await db.insert(courseCompletions).values({ userId: userIdD, course: courseId, status: 'in_progress', timeStarted: new Date() });
    await replaceCriteria([{ criteriaType: 'unenrol' }]);
    await processor.process({ data: { courseId } } as never);
    expect(await statusOf(userIdD)).toBe('complete');
    // ...while a still-enrolled user does NOT satisfy it.
    expect(await statusOf(userIdC)).not.toBe('complete');
  });
});
