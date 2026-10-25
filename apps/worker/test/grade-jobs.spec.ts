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
} from '@lms/db-schema';
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
    await db.execute(sql`insert into tenants (slug, name, kind, status) values ('worker-fixture', 'Worker fixture tenant', 'school', 'active') on conflict (slug) do nothing`);
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`worker-cat3-${suffix}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name) values (${catId}, (select tenant_id from course_categories where id = ${catId}), 'Worker grades course', ${`wk3${suffix}`}) returning id`);
    courseId = (courseRows.rows[0] as { id: string }).id;
  });
  afterAll(async () => { await context.close(); });

  it('grade-regrade recomputes the course total (Natural 100/190), writes history and emits grade_updated; a second run is idempotent', async () => {
    const [root] = await db.insert(gradeCategories).values({ courseId: courseId, parent: null, fullName: '', aggregation: 'natural', depth: 1 }).returning();
    rootCatId = root.id;
    const [courseItem] = await db.insert(gradeItems).values({ courseId: courseId, categoryId: rootCatId, itemName: 'Course total', itemType: 'course', itemInstance: courseId, gradeMax: 100 }).returning();
    courseItemId = courseItem.id;
    const mk = async (name: string, max: number, grade: number) => {
      const [item] = await db.insert(gradeItems).values({ courseId: courseId, categoryId: rootCatId, itemName: name, itemType: 'manual', itemInstance: null, gradeMax: max }).returning();
      await db.insert(gradeGrades).values({ itemId: item.id, userId: userId, rawGrade: grade, finalGrade: grade });
      return item;
    };
    await mk('A1', 100, 70);
    await mk('A2', 80, 20);
    await mk('A3', 10, 10);
    // Stale course total that the regrade must correct.
    await db.insert(gradeGrades).values({ itemId: courseItemId, userId: userId, rawGrade: null, finalGrade: 1 });

    const processor = context.get(GradeRegradeProcessor);
    const result = await processor.process({ data: { courseId } } as never);
    expect(result.users).toBe(1);
    expect(result.updatedTotals).toBeGreaterThanOrEqual(1);
    const [total] = await db.select().from(gradeGrades).where(and(eq(gradeGrades.itemId, courseItemId), eq(gradeGrades.userId, userId)));
    expect(total.finalGrade).toBeCloseTo(100, 6);
    const [itemRow] = await db.select().from(gradeItems).where(eq(gradeItems.id, courseItemId));
    expect(itemRow.gradeMax).toBeCloseTo(190, 6);
    const history = await db.select().from(gradeGradesHistory).where(and(eq(gradeGradesHistory.itemId, courseItemId), eq(gradeGradesHistory.userId, userId)));
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[history.length - 1].source).toBe('regrade-worker');
    const events = await db.select().from(outboxEvents).where(eq(outboxEvents.type, 'grade_updated'));
    expect((events as { payload: { itemId?: string } }[]).some((e) => e.payload.itemId === courseItemId)).toBe(true);
    // Idempotent: second run changes nothing.
    const second = await processor.process({ data: { courseId } } as never);
    expect(second.updatedTotals).toBe(0);
  });


  it('grade-regrade computes calculated items from idNumber formulas and excludes outcome/scale items from numeric aggregation', async () => {
    // Khoá học riêng để không lẫn với total của test trước.
    const sfx = `${suffix}c`;
    const catRows = await db.execute(sql`insert into course_categories (name, path, tenant_id) values (${`worker-cat3c-${sfx}`}, '', (select id from tenants where slug = 'worker-fixture')) returning id`);
    const catId2 = (catRows.rows[0] as { id: string }).id;
    const courseRows = await db.execute(sql`insert into course (category, tenant_id, full_name, short_name) values (${catId2}, (select tenant_id from course_categories where id = ${catId2}), 'Worker calc course', ${`wk3c${suffix}`}) returning id`);
    const course2 = (courseRows.rows[0] as { id: string }).id;
    const [root2] = await db.insert(gradeCategories).values({ courseId: course2, parent: null, fullName: '', aggregation: 'natural', depth: 1 }).returning();
    const [courseItem2] = await db.insert(gradeItems).values({ courseId: course2, categoryId: root2.id, itemName: 'Course total', itemType: 'course', itemInstance: course2, gradeMax: 100 }).returning();
    const mk2 = async (values: Record<string, unknown>, grade?: number) => {
      const [item] = await db.insert(gradeItems).values({ courseId: course2, categoryId: root2.id, itemName: 'I', itemType: 'manual', itemInstance: null, gradeMax: 100, ...values }).returning();
      if (grade !== undefined) await db.insert(gradeGrades).values({ itemId: item.id, userId: userId, rawGrade: grade, finalGrade: grade });
      return item;
    };
    await mk2({ itemName: 'Q1', idNumber: 'wq1' }, 80);
    await mk2({ itemName: 'Q2', idNumber: 'wq2' }, 60);
    const calc = await mk2({ itemName: 'Avg', itemType: 'calculated', idNumber: 'wavg', calculation: '=average([[wq1]],[[wq2]])' });
    // Outcome tham chiếu phải tồn tại thật trong grade_outcomes (kèm scale của nó):
    // test tự dựng hai dòng này, không dựa vào trạng thái DB do suite khác để lại.
    await db.execute(sql`insert into scales (id, name, scale) values ('01910000-0000-7000-8000-0000000000ab', 'Worker outcome scale', '1,2,3') on conflict (id) do nothing`);
    await db.execute(sql`insert into grade_outcomes (id, scale_id, name) values ('01910000-0000-7000-8000-0000000000aa', '01910000-0000-7000-8000-0000000000ab', 'Worker outcome') on conflict (id) do nothing`);
    // Item outcome (gradeType scale + outcomeId): điểm 3/3 KHÔNG được cộng vào tổng số.
    await mk2({ itemName: 'Outcome item', gradeType: 'scale', outcomeId: '01910000-0000-7000-8000-0000000000aa', gradeMax: 3, gradeMin: 1 }, 3);
    const processor = context.get(GradeRegradeProcessor);
    const result = await processor.process({ data: { courseId: course2 } } as never);
    expect(result.users).toBe(1);
    const [calcGrade] = await db.select().from(gradeGrades).where(and(eq(gradeGrades.itemId, calc.id), eq(gradeGrades.userId, userId)));
    expect(calcGrade.finalGrade).toBeCloseTo(70, 6);
    // Natural: (80 + 60 + 70) trên thang 300 ⇒ 210; nếu outcome item lọt vào tổng hợp thì kết quả sẽ khác.
    const [total2] = await db.select().from(gradeGrades).where(and(eq(gradeGrades.itemId, courseItem2.id), eq(gradeGrades.userId, userId)));
    expect(total2.finalGrade).toBeCloseTo(210, 6);
    const [totalItem2] = await db.select().from(gradeItems).where(eq(gradeItems.id, courseItem2.id));
    expect(totalItem2.gradeMax).toBeCloseTo(300, 6);
  });

  it('completion-recalculate evaluates a grade criterion against the course total and its gradePass', async () => {
    // Course total is 100/190 ≈ 52.6% — set gradePass 120 (absolute, of 190) ⇒ not met; then lower to 90 ⇒ met.
    await db.update(gradeItems).set({ gradePass: 120 }).where(eq(gradeItems.id, courseItemId));
    await db.insert(courseCompletionCriteria).values({ course: courseId, criteriaType: 'grade', sortOrder: 0 });
    const processor = context.get(CompletionRecalculateProcessor);
    await processor.process({ data: { courseId } } as never);
    let [cc] = await db.select().from(courseCompletions).where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userId, userId)));
    // The user may have no course_completions row yet if never enrolled/started: grade criterion
    // candidates come from enrolments/completions; insert the row path via a module criterion is
    // covered in enrol-completion-jobs — here assert the criterion does NOT complete when a row exists.
    if (cc) expect(cc.status).not.toBe('complete');
    await db.update(gradeItems).set({ gradePass: 90 }).where(eq(gradeItems.id, courseItemId));
    await db.insert(courseCompletions).values({ userId: userId, course: courseId, status: 'in_progress', timeStarted: new Date() }).onConflictDoNothing();
    await processor.process({ data: { courseId } } as never);
    [cc] = await db.select().from(courseCompletions).where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userId, userId)));
    expect(cc.status).toBe('complete');
    void rootCatId;
  });
});
