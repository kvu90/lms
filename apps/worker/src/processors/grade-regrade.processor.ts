import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { gradeCategories, gradeGrades, gradeGradesHistory, gradeItems, outboxEvents } from '../db/schema';
import { calculateCategory, evaluateGradeFormula, parseGradeFormula, type AggregationStrategy, type CalcItemInput } from '@lms/grades';

type Database = NodePgDatabase<typeof relations>;

export interface GradeRegradeJobData { courseId: string; categoryId?: string }
export interface GradeRegradeResult { courseId: string; users: number; updatedTotals: number }

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
 * Xử lý job tính lại điểm (regrade) cho user/khoá học bằng grade-calculator của package dùng chung @lms/grades.
 */
export class GradeRegradeProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<GradeRegradeJobData>): Promise<GradeRegradeResult> {
    const { courseId } = job.data;
    const categories = await this.db.select().from(gradeCategories).where(eq(gradeCategories.courseId, courseId));
    const items = await this.db.select().from(gradeItems).where(eq(gradeItems.courseId, courseId));
    const itemIds = items.map((i) => i.id);
    const allGrades = itemIds.length
      ? await this.db.select().from(gradeGrades).where(inArray(gradeGrades.itemId, itemIds))
      : [];
    const userIds = [...new Set(allGrades.map((g) => g.userId))];
    let updatedTotals = 0;

    for (const userId of userIds) {
      const grades = allGrades.filter((g) => g.userId === userId);
      const gradeByItem = new Map(grades.map((g) => [g.itemId, g]));
      const finalByItem = new Map<string, number | null>(grades.map((g) => [g.itemId, g.finalGrade]));

      // Calculated items (từ @lms/grades dùng chung với API): đánh giá công thức theo idNumber
      // trước khi tổng hợp category, kẹp vào [gradeMin, gradeMax] của item và lưu lại điểm.
      const byIdnumber = new Map(items.filter((i) => i.idNumber).map((i) => [i.idNumber!, i]));
      const computedCalc = new Map<string, number | null>();
      const resolving = new Set<string>();
      type ItemRowW = (typeof items)[number];
      const resolveFinal = (it: ItemRowW): number | null => {
        if (it.itemType !== 'calculated') return finalByItem.get(it.id) ?? null;
        if (computedCalc.has(it.id)) return computedCalc.get(it.id)!;
        if (resolving.has(it.id)) return null;
        resolving.add(it.id);
        let value: number | null = null;
        const existingCalc = gradeByItem.get(it.id);
        if (existingCalc?.overridden) value = existingCalc.finalGrade;
        else if (it.calculation) {
          try {
            value = evaluateGradeFormula(parseGradeFormula(it.calculation), (idNumber) => {
              const ref = byIdnumber.get(idNumber);
              if (!ref || ref.id === it.id) return null;
              if (gradeByItem.get(ref.id)?.excluded) return null;
              return resolveFinal(ref);
            });
          } catch { value = null; }
          if (value !== null) value = Math.min(it.gradeMax, Math.max(it.gradeMin, value));
        }
        resolving.delete(it.id);
        computedCalc.set(it.id, value);
        return value;
      };
      for (const calcItem of items.filter((i) => i.itemType === 'calculated')) {
        const existingCalc = gradeByItem.get(calcItem.id);
        if (existingCalc?.overridden) { finalByItem.set(calcItem.id, existingCalc.finalGrade); continue; }
        const value = resolveFinal(calcItem);
        finalByItem.set(calcItem.id, value);
        const changed = !existingCalc || existingCalc.finalGrade !== value;
        await this.db.insert(gradeGrades).values({
          itemId: calcItem.id, userId: userId, rawGrade: existingCalc?.rawGrade ?? null, finalGrade: value,
          aggregationStatus: value === null ? 'novalue' : 'used',
        }).onConflictDoUpdate({
          target: [gradeGrades.itemId, gradeGrades.userId],
          set: { finalGrade: value, aggregationStatus: value === null ? 'novalue' : 'used', updatedAt: new Date() },
        });
        if (changed && value !== null) {
          updatedTotals += 1;
          await this.db.insert(gradeGradesHistory).values({
            action: existingCalc ? 2 : 1, oldId: existingCalc?.id ?? null, itemId: calcItem.id, userId: userId,
            rawGrade: null, finalGrade: value, source: 'calculation-worker',
          });
          await this.db.insert(outboxEvents).values({
            aggregate: 'grades', type: 'grade_updated',
            payload: { courseId, itemId: calcItem.id, userId, finalGrade: value, calculated: true, via: 'worker-regrade' },
          });
        }
      }

      const byDepthDesc = [...categories].sort((a, b) => b.depth - a.depth);
      for (const cat of byDepthDesc) {
        const totalItem = items.find((i) => (i.itemType === 'category' && i.itemInstance === cat.id)
          || (i.itemType === 'course' && cat.parent === null));
        if (!totalItem) continue;
        const existing = gradeByItem.get(totalItem.id);
        if (existing?.overridden) { finalByItem.set(totalItem.id, existing.finalGrade); continue; }
        if (existing?.frozen && existing.finalGrade !== null) { finalByItem.set(totalItem.id, existing.finalGrade); continue; }
        // Item thang định tính (gradeType='scale', gồm item gắn outcome) không tham gia tổng hợp số — cùng luật với API.
        const childItems = items.filter((i) => i.categoryId === cat.id && i.id !== totalItem.id
          && !i.outcomeId && i.gradeType !== 'scale');
        const calcItems: CalcItemInput[] = childItems.map((ci) => {
          const g = gradeByItem.get(ci.id);
          const isSubTotal = ci.itemType === 'category' || ci.itemType === 'course';
          const isCalculated = ci.itemType === 'calculated';
          return {
            itemId: ci.id, gradeMin: ci.gradeMin, gradeMax: ci.gradeMax,
            grade: finalByItem.get(ci.id) ?? null,
            excluded: g?.excluded ?? false, extraCredit: ci.extraCredit,
            weightOverride: ci.weightOverride, weight: ci.aggregationCoef, aggregationCoef: ci.aggregationCoef,
            multiplicator: (isSubTotal || isCalculated) ? 1 : ci.multiplicator, offset: (isSubTotal || isCalculated) ? 0 : ci.plusFactor,
            frozen: g?.frozen ?? false,
          };
        });
        const result = calculateCategory({
          aggregation: cat.aggregation as AggregationStrategy,
          gradeMin: totalItem.gradeMin, gradeMax: totalItem.gradeMax,
          dropLow: cat.dropLow, keepHigh: cat.keepHigh, aggregateOnlyGraded: cat.aggregateOnlyGraded,
          items: calcItems,
        });
        if ((cat.aggregation === 'natural' || cat.aggregation === 'sum') && Math.abs(result.gradeMax - totalItem.gradeMax) > 1e-9) {
          await this.db.update(gradeItems).set({ gradeMax: result.gradeMax }).where(eq(gradeItems.id, totalItem.id));
          totalItem.gradeMax = result.gradeMax;
        }
        const changed = !existing || existing.finalGrade !== result.finalGrade;
        await this.db.insert(gradeGrades).values({
          itemId: totalItem.id, userId: userId, rawGrade: null, finalGrade: result.finalGrade,
          aggregationStatus: result.finalGrade === null ? 'novalue' : 'used',
        }).onConflictDoUpdate({
          target: [gradeGrades.itemId, gradeGrades.userId],
          set: { finalGrade: result.finalGrade, aggregationStatus: result.finalGrade === null ? 'novalue' : 'used', updatedAt: new Date() },
        });
        finalByItem.set(totalItem.id, result.finalGrade);
        if (changed && result.finalGrade !== null) {
          updatedTotals += 1;
          await this.db.insert(gradeGradesHistory).values({
            action: existing ? 2 : 1, oldId: existing?.id ?? null, itemId: totalItem.id, userId: userId,
            rawGrade: null, finalGrade: result.finalGrade, source: 'regrade-worker',
          });
          await this.db.insert(outboxEvents).values({
            aggregate: 'grades', type: 'grade_updated',
            payload: { courseId, itemId: totalItem.id, userId, finalGrade: result.finalGrade, calculated: true, via: 'worker-regrade' },
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
