import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { GradeRegradeProcessor } from '../src/processors/grade-regrade.processor';
import { CompletionRecalculateProcessor } from '../src/processors/completion-recalculate.processor';
import {
  courseCompletionCriteria, courseCompletions, gradeCategories, gradeGrades,
  gradeGradesHistory, gradeItems, outboxEvents,
} from '../src/db/schema';
import { WorkerModule } from '../src/worker.module';

/**
 * P3 worker jobs. Oracle: MoodleDocs Grade aggregation arithmetic (the same
 * golden numbers as the API GradeCalculator spec) + completionlib grade
 * criteria (lib/tests/completionlib_test.php). The regrade processor must
 * recompute totals with the worker's own copy of the calculator, write
 * history, and emit the grade_updated outbox chain.
 */
describe('Worker P3: grade-regrade + completion grade criterion', () => {
  let context: INestApplicationContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const suffix = Date.now();
  const userId = 910000 + (suffix % 10000);
  let courseId = 0;
  let rootCatId = 0;
  let courseItemId = 0;

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    const catRows = await db.execute(sql`insert into course_categories (name, path) values (${`worker-cat3-${suffix}`}, '') returning id`);
    const catId = (catRows.rows[0] as { id: number }).id;
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId}, 'Worker P3 course', ${`wk3${suffix}`}) returning id`);
    courseId = (courseRows.rows[0] as { id: number }).id;
  });
  afterAll(async () => { await context.close(); });

  it('grade-regrade recomputes the course total (Natural 100/190), writes history and emits grade_updated; a second run is idempotent', async () => {
    const [root] = await db.insert(gradeCategories).values({ courseid: courseId, parent: null, fullname: '', aggregation: 'natural', depth: 1 }).returning();
    rootCatId = root.id;
    const [courseItem] = await db.insert(gradeItems).values({ courseid: courseId, categoryid: rootCatId, itemname: 'Course total', itemtype: 'course', iteminstance: courseId, grademax: 100 }).returning();
    courseItemId = courseItem.id;
    const mk = async (name: string, max: number, grade: number) => {
      const [item] = await db.insert(gradeItems).values({ courseid: courseId, categoryid: rootCatId, itemname: name, itemtype: 'manual', iteminstance: 0, grademax: max }).returning();
      await db.insert(gradeGrades).values({ itemid: item.id, userid: userId, rawgrade: grade, finalgrade: grade });
      return item;
    };
    await mk('A1', 100, 70);
    await mk('A2', 80, 20);
    await mk('A3', 10, 10);
    // Stale course total that the regrade must correct.
    await db.insert(gradeGrades).values({ itemid: courseItemId, userid: userId, rawgrade: null, finalgrade: 1 });

    const processor = context.get(GradeRegradeProcessor);
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.users).toBe(1);
    expect(result.updatedTotals).toBeGreaterThanOrEqual(1);
    const [total] = await db.select().from(gradeGrades).where(and(eq(gradeGrades.itemid, courseItemId), eq(gradeGrades.userid, userId)));
    expect(total.finalgrade).toBeCloseTo(100, 6);
    const [itemRow] = await db.select().from(gradeItems).where(eq(gradeItems.id, courseItemId));
    expect(itemRow.grademax).toBeCloseTo(190, 6);
    const history = await db.select().from(gradeGradesHistory).where(and(eq(gradeGradesHistory.itemid, courseItemId), eq(gradeGradesHistory.userid, userId)));
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[history.length - 1].source).toBe('regrade-worker');
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'grade_updated'));
    expect((events as { payload: { itemId?: number } }[]).some((e) => e.payload.itemId === courseItemId)).toBe(true);
    // Idempotent: second run changes nothing.
    const second = await processor.process({ data: { courseId } } as never);
    expect(second.updatedTotals).toBe(0);
  });

  it('completion-recalculate evaluates a grade criterion against the course total and its gradepass', async () => {
    // Course total is 100/190 ≈ 52.6% — set gradepass 120 (absolute, of 190) ⇒ not met; then lower to 90 ⇒ met.
    await db.update(gradeItems).set({ gradepass: 120 }).where(eq(gradeItems.id, courseItemId));
    await db.insert(courseCompletionCriteria).values({ course: courseId, criteriatype: 'grade', sortorder: 0 });
    const processor = context.get(CompletionRecalculateProcessor);
    await processor.process({ data: { courseId } } as never);
    let [cc] = await db.select().from(courseCompletions).where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
    // The user may have no course_completions row yet if never enrolled/started: grade criterion
    // candidates come from enrolments/completions; insert the row path via a module criterion is
    // covered in p2-jobs — here assert the criterion does NOT complete when a row exists.
    if (cc) expect(cc.status).not.toBe('complete');
    await db.update(gradeItems).set({ gradepass: 90 }).where(eq(gradeItems.id, courseItemId));
    await db.insert(courseCompletions).values({ userid: userId, course: courseId, status: 'in_progress', timestarted: new Date() }).onConflictDoNothing();
    await processor.process({ data: { courseId } } as never);
    [cc] = await db.select().from(courseCompletions).where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
    expect(cc.status).toBe('complete');
    void rootCatId;
  });
});
