import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { CompletionRecalculateProcessor } from '../src/processors/completion-recalculate.processor';
import { EnrolExpiryProcessor } from '../src/processors/enrol-expiry.processor';
import {
  courseCompletionCriteria, courseCompletions, courseCompletionSettings,
  courseModulesCompletion, enrol, outboxEvents, userEnrolments,
} from '../src/db/schema';
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const suffix = Date.now();
  const userId = `01900000-0000-7000-8000-${String(900000 + (suffix % 10000)).padStart(12, '0')}`;
  let instanceId = '';
  let courseId = '';
  let cmId = '';

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    // Create a real category+course+section via raw SQL (FKs in the shared DB require real rows;
    // the worker's schema view intentionally only carries the tables its processors touch).
    const catRows = await db.execute(sql`insert into course_categories (name, path) values (${`worker-cat-${suffix}`}, '') returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId}, 'Worker course', ${`wk${suffix}`}) returning id`);
    courseId = (courseRows.rows[0] as { id: string }).id;
    const sectionRows = await db.execute(sql`insert into course_sections (course, section) values (${courseId}, 0) returning id`);
    const sectionId = (sectionRows.rows[0] as { id: string }).id;
    const [inst] = await db.insert(enrol).values({ courseid: courseId, enrol: 'manual', status: 0 }).returning();
    instanceId = inst.id;
    const cmRows = await db.execute(sql`insert into course_modules (course, section, component) values (${courseId}, ${sectionId}, 'mod_page') returning id`);
    cmId = (cmRows.rows[0] as { id: string }).id;
  });
  afterAll(async () => { await context.close(); });

  it('enrol-expiry flips ACTIVE enrolments whose timeend passed to SUSPENDED and writes the outbox event; future enrolments untouched', async () => {
    const past = new Date(Date.now() - 3600_000);
    const future = new Date(Date.now() + 3600_000);
    const [expired] = await db.insert(userEnrolments).values({ enrolid: instanceId, userid: userId, status: 0, timestart: new Date(Date.now() - 7200_000), timeend: past }).returning();
    const [alive] = await db.insert(userEnrolments).values({ enrolid: instanceId, userid: userId + 1, status: 0, timestart: new Date(), timeend: future }).returning();
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

  it('completion-recalculate recomputes course completion from current criteria (AND), and reopens it when criteria tighten', async () => {
    const processor = context.get(CompletionRecalculateProcessor);
    await db.insert(courseModulesCompletion).values({ coursemoduleid: cmId, userid: userId, completionstate: 1, viewed: true });
    await db.insert(courseCompletionSettings).values({ course: courseId, method: 1 }).onConflictDoNothing();
    await db.insert(courseCompletionCriteria).values({ course: courseId, criteriatype: 'module', moduleinstance: cmId, sortorder: 0 });
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.users).toBeGreaterThan(0);
    let [cc] = await db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
    expect(cc.status).toBe('complete');
    expect(cc.timecompleted).toBeTruthy();

    // Add a date criterion in the future ⇒ recalculation reopens the completion.
    await db.insert(courseCompletionCriteria).values({ course: courseId, criteriatype: 'date', date: new Date('2100-01-01'), sortorder: 1 });
    await processor.process({ data: { courseId } } as never);
    [cc] = await db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
    expect(cc.status).not.toBe('complete');
    expect(cc.timecompleted).toBeNull();
  });
});
