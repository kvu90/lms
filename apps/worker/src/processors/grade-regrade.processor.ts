import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { gradeCategories, gradeGrades, gradeGradesHistory, gradeItems, outboxEvents } from '../db/schema';
import { calculateCategory, type AggregationStrategy, type CalcItemInput } from '../domain/grade-calculator';

type Database = NodePgDatabase<typeof relations>;

export interface GradeRegradeJobData { courseId: number; categoryId?: number }
export interface GradeRegradeResult { courseId: number; users: number; updatedTotals: number }

/**
 * Bulk regrade: enqueued by the API when a category's aggregation
 * semantics change (or for large gradebooks generally). Recomputes every
 * user's category totals bottom-up and the course total with the same pure
 * GradeCalculator the API uses, writes grade_grades_history for changed
 * totals, and emits one grade_updated outbox event per changed total plus a
 * course_grade_recalculated summary — the chain completion/badges consume.
 * Overridden and frozen totals are never recomputed.
 */
@Processor('grade-regrade')
/**
 * Xử lý job tính lại điểm (regrade) cho user/khoá học bằng grade-calculator của worker.
 */
export class GradeRegradeProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<GradeRegradeJobData>): Promise<GradeRegradeResult> {
    const { courseId } = job.data;
    const categories = await this.db.select().from(gradeCategories).where(eq(gradeCategories.courseid, courseId));
    const items = await this.db.select().from(gradeItems).where(eq(gradeItems.courseid, courseId));
    const itemIds = items.map((i) => i.id);
    const allGrades = itemIds.length
      ? await this.db.select().from(gradeGrades).where(inArray(gradeGrades.itemid, itemIds))
      : [];
    const userIds = [...new Set(allGrades.map((g) => g.userid))];
    let updatedTotals = 0;

    for (const userId of userIds) {
      const grades = allGrades.filter((g) => g.userid === userId);
      const gradeByItem = new Map(grades.map((g) => [g.itemid, g]));
      const finalByItem = new Map<number, number | null>(grades.map((g) => [g.itemid, g.finalgrade]));
      const byDepthDesc = [...categories].sort((a, b) => b.depth - a.depth);
      for (const cat of byDepthDesc) {
        const totalItem = items.find((i) => (i.itemtype === 'category' && i.iteminstance === cat.id)
          || (i.itemtype === 'course' && (cat.parent === null || cat.parent === 0)));
        if (!totalItem) continue;
        const existing = gradeByItem.get(totalItem.id);
        if (existing?.overridden) { finalByItem.set(totalItem.id, existing.finalgrade); continue; }
        if (existing?.frozen && existing.finalgrade !== null) { finalByItem.set(totalItem.id, existing.finalgrade); continue; }
        const childItems = items.filter((i) => i.categoryid === cat.id && i.id !== totalItem.id);
        const calcItems: CalcItemInput[] = childItems.map((ci) => {
          const g = gradeByItem.get(ci.id);
          const isSubTotal = ci.itemtype === 'category' || ci.itemtype === 'course';
          return {
            itemId: ci.id, grademin: ci.grademin, grademax: ci.grademax,
            grade: finalByItem.get(ci.id) ?? null,
            excluded: g?.excluded ?? false, extracredit: ci.extracredit,
            weightOverride: ci.weightoverride, weight: ci.aggregationcoef, aggregationcoef: ci.aggregationcoef,
            multiplicator: isSubTotal ? 1 : ci.multiplicator, offset: isSubTotal ? 0 : ci.plusfactor,
            frozen: g?.frozen ?? false,
          };
        });
        const result = calculateCategory({
          aggregation: cat.aggregation as AggregationStrategy,
          grademin: totalItem.grademin, grademax: totalItem.grademax,
          droplow: cat.droplow, keephigh: cat.keephigh, aggregateOnlyGraded: cat.aggregateonlygraded,
          items: calcItems,
        });
        if ((cat.aggregation === 'natural' || cat.aggregation === 'sum') && Math.abs(result.grademax - totalItem.grademax) > 1e-9) {
          await this.db.update(gradeItems).set({ grademax: result.grademax }).where(eq(gradeItems.id, totalItem.id));
          totalItem.grademax = result.grademax;
        }
        const changed = !existing || existing.finalgrade !== result.finalgrade;
        await this.db.insert(gradeGrades).values({
          itemid: totalItem.id, userid: userId, rawgrade: null, finalgrade: result.finalgrade,
          aggregationstatus: result.finalgrade === null ? 'novalue' : 'used',
        }).onConflictDoUpdate({
          target: [gradeGrades.itemid, gradeGrades.userid],
          set: { finalgrade: result.finalgrade, aggregationstatus: result.finalgrade === null ? 'novalue' : 'used', timemodified: new Date() },
        });
        finalByItem.set(totalItem.id, result.finalgrade);
        if (changed && result.finalgrade !== null) {
          updatedTotals += 1;
          await this.db.insert(gradeGradesHistory).values({
            action: existing ? 2 : 1, oldid: existing?.id ?? null, itemid: totalItem.id, userid: userId,
            rawgrade: null, finalgrade: result.finalgrade, source: 'regrade-worker',
          });
          await this.db.insert(outboxEvents).values({
            aggregate: 'grades', type: 'grade_updated',
            payload: { courseId, itemId: totalItem.id, userId, finalgrade: result.finalgrade, calculated: true, via: 'worker-regrade' },
          });
        }
      }
    }
    await this.db.insert(outboxEvents).values({
      aggregate: 'grades', type: 'course_grade_recalculated',
      payload: { courseId, users: userIds.length, via: 'worker-regrade' },
    });
    return { courseId, users: userIds.length, updatedTotals };
  }
}
