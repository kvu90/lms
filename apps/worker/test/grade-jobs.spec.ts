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
 * Grade worker jobs. Oracle: MoodleDocs Grade aggregation arithmetic (the same
 * golden numbers as the API GradeCalculator spec) + completionlib grade
 * criteria (lib/tests/completionlib_test.php). The regrade processor must
 * recompute totals with the worker's own copy of the calculator, write
 * history, and emit the grade_updated outbox chain.
 */
describe('Worker grades: grade-regrade + completion grade criterion', () => {
  let context: INestApplicationContext;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const suffix = Date.now();
  const userId = `01910000-0000-7000-8000-${String(910000 + (suffix % 10000)).padStart(12, '0')}`;
  let courseId = '';
  let rootCatId = '';
  let courseItemId = '';

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    const catRows = await db.execute(sql`insert into course_categories (name, path) values (${`worker-cat3-${suffix}`}, '') returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId}, 'Worker grades course', ${`wk3${suffix}`}) returning id`);
    courseId = (courseRows.rows[0] as { id: string }).id;
  });
  afterAll(async () => { await context.close(); });

  it('grade-regrade recomputes the course total (Natural 100/190), writes history and emits grade_updated; a second run is idempotent', async () => {
    const [root] = await db.insert(gradeCategories).values({ courseid: courseId, parent: null, fullname: '', aggregation: 'natural', depth: 1 }).returning();
    rootCatId = root.id;
    const [courseItem] = await db.insert(gradeItems).values({ courseid: courseId, categoryid: rootCatId, itemname: 'Course total', itemtype: 'course', iteminstance: courseId, grademax: 100 }).returning();
    courseItemId = courseItem.id;
    const mk = async (name: string, max: number, grade: number) => {
      const [item] = await db.insert(gradeItems).values({ courseid: courseId, categoryid: rootCatId, itemname: name, itemtype: 'manual', iteminstance: null, grademax: max }).returning();
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
    expect((events as { payload: { itemId?: string } }[]).some((e) => e.payload.itemId === courseItemId)).toBe(true);
    // Idempotent: second run changes nothing.
    const second = await processor.process({ data: { courseId } } as never);
    expect(second.updatedTotals).toBe(0);
  });


  it('grade-regrade computes calculated items from idnumber formulas and excludes outcome/scale items from numeric aggregation', async () => {
    // Khoá học riêng để không lẫn với total của test trước.
    const sfx = `${suffix}c`;
    const catRows = await db.execute(sql`insert into course_categories (name, path) values (${`worker-cat3c-${sfx}`}, '') returning id`);
    const catId2 = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, fullname, shortname) values (${catId2}, 'Worker calc course', ${`wk3c${suffix}`}) returning id`);
    const course2 = (courseRows.rows[0] as { id: string }).id;
    const [root2] = await db.insert(gradeCategories).values({ courseid: course2, parent: null, fullname: '', aggregation: 'natural', depth: 1 }).returning();
    const [courseItem2] = await db.insert(gradeItems).values({ courseid: course2, categoryid: root2.id, itemname: 'Course total', itemtype: 'course', iteminstance: course2, grademax: 100 }).returning();
    const mk2 = async (values: Record<string, unknown>, grade?: number) => {
      const [item] = await db.insert(gradeItems).values({ courseid: course2, categoryid: root2.id, itemname: 'I', itemtype: 'manual', iteminstance: null, grademax: 100, ...values }).returning();
      if (grade !== undefined) await db.insert(gradeGrades).values({ itemid: item.id, userid: userId, rawgrade: grade, finalgrade: grade });
      return item;
    };
    await mk2({ itemname: 'Q1', idnumber: 'wq1' }, 80);
    await mk2({ itemname: 'Q2', idnumber: 'wq2' }, 60);
    const calc = await mk2({ itemname: 'Avg', itemtype: 'calculated', idnumber: 'wavg', calculation: '=average([[wq1]],[[wq2]])' });
    // Item outcome (gradetype scale + outcomeid): điểm 3/3 KHÔNG được cộng vào tổng số.
    await mk2({ itemname: 'Outcome item', gradetype: 'scale', outcomeid: '01910000-0000-7000-8000-0000000000aa', grademax: 3, grademin: 1 }, 3);
    const processor = context.get(GradeRegradeProcessor);
    const result = await processor.process({ data: { courseId: course2 } } as never);
    expect(result.users).toBe(1);
    const [calcGrade] = await db.select().from(gradeGrades).where(and(eq(gradeGrades.itemid, calc.id), eq(gradeGrades.userid, userId)));
    expect(calcGrade.finalgrade).toBeCloseTo(70, 6);
    // Natural: (80 + 60 + 70) trên thang 300 ⇒ 210; nếu outcome item lọt vào tổng hợp thì kết quả sẽ khác.
    const [total2] = await db.select().from(gradeGrades).where(and(eq(gradeGrades.itemid, courseItem2.id), eq(gradeGrades.userid, userId)));
    expect(total2.finalgrade).toBeCloseTo(210, 6);
    const [totalItem2] = await db.select().from(gradeItems).where(eq(gradeItems.id, courseItem2.id));
    expect(totalItem2.grademax).toBeCloseTo(300, 6);
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
    // covered in enrol-completion-jobs — here assert the criterion does NOT complete when a row exists.
    if (cc) expect(cc.status).not.toBe('complete');
    await db.update(gradeItems).set({ gradepass: 90 }).where(eq(gradeItems.id, courseItemId));
    await db.insert(courseCompletions).values({ userid: userId, course: courseId, status: 'in_progress', timestarted: new Date() }).onConflictDoNothing();
    await processor.process({ data: { courseId } } as never);
    [cc] = await db.select().from(courseCompletions).where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
    expect(cc.status).toBe('complete');
    void rootCatId;
  });
});
