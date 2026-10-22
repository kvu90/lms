import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { gradeCategories, gradeGrades, gradeGradesHistory, gradeItems, outboxEvents } from '../db/schema';
import { calculateCategory, type AggregationStrategy, type CalcItemInput } from '../domain/grade-calculator';
import { evaluateGradeFormula, parseGradeFormula } from '../domain/grade-formula';

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
      const finalByItem = new Map<string, number | null>(grades.map((g) => [g.itemid, g.finalgrade]));

      // Calculated items (bản worker — cùng logic với API): đánh giá công thức theo idnumber
      // trước khi tổng hợp category, kẹp vào [grademin, grademax] của item và lưu lại điểm.
      const byIdnumber = new Map(items.filter((i) => i.idnumber).map((i) => [i.idnumber!, i]));
      const computedCalc = new Map<string, number | null>();
      const resolving = new Set<string>();
      type ItemRowW = (typeof items)[number];
      const resolveFinal = (it: ItemRowW): number | null => {
        if (it.itemtype !== 'calculated') return finalByItem.get(it.id) ?? null;
        if (computedCalc.has(it.id)) return computedCalc.get(it.id)!;
        if (resolving.has(it.id)) return null;
        resolving.add(it.id);
        let value: number | null = null;
        const existingCalc = gradeByItem.get(it.id);
        if (existingCalc?.overridden) value = existingCalc.finalgrade;
        else if (it.calculation) {
          try {
            value = evaluateGradeFormula(parseGradeFormula(it.calculation), (idnumber) => {
              const ref = byIdnumber.get(idnumber);
              if (!ref || ref.id === it.id) return null;
              if (gradeByItem.get(ref.id)?.excluded) return null;
              return resolveFinal(ref);
            });
          } catch { value = null; }
          if (value !== null) value = Math.min(it.grademax, Math.max(it.grademin, value));
        }
        resolving.delete(it.id);
        computedCalc.set(it.id, value);
        return value;
      };
      for (const calcItem of items.filter((i) => i.itemtype === 'calculated')) {
        const existingCalc = gradeByItem.get(calcItem.id);
        if (existingCalc?.overridden) { finalByItem.set(calcItem.id, existingCalc.finalgrade); continue; }
        const value = resolveFinal(calcItem);
        finalByItem.set(calcItem.id, value);
        const changed = !existingCalc || existingCalc.finalgrade !== value;
        await this.db.insert(gradeGrades).values({
          itemid: calcItem.id, userid: userId, rawgrade: existingCalc?.rawgrade ?? null, finalgrade: value,
          aggregationstatus: value === null ? 'novalue' : 'used',
        }).onConflictDoUpdate({
          target: [gradeGrades.itemid, gradeGrades.userid],
          set: { finalgrade: value, aggregationstatus: value === null ? 'novalue' : 'used', timemodified: new Date() },
        });
        if (changed && value !== null) {
          updatedTotals += 1;
          await this.db.insert(gradeGradesHistory).values({
            action: existingCalc ? 2 : 1, oldid: existingCalc?.id ?? null, itemid: calcItem.id, userid: userId,
            rawgrade: null, finalgrade: value, source: 'calculation-worker',
          });
          await this.db.insert(outboxEvents).values({
            aggregate: 'grades', type: 'grade_updated',
            payload: { courseId, itemId: calcItem.id, userId, finalgrade: value, calculated: true, via: 'worker-regrade' },
          });
        }
      }

      const byDepthDesc = [...categories].sort((a, b) => b.depth - a.depth);
      for (const cat of byDepthDesc) {
        const totalItem = items.find((i) => (i.itemtype === 'category' && i.iteminstance === cat.id)
          || (i.itemtype === 'course' && cat.parent === null));
        if (!totalItem) continue;
        const existing = gradeByItem.get(totalItem.id);
        if (existing?.overridden) { finalByItem.set(totalItem.id, existing.finalgrade); continue; }
        if (existing?.frozen && existing.finalgrade !== null) { finalByItem.set(totalItem.id, existing.finalgrade); continue; }
        // Item thang định tính (gradetype='scale', gồm item gắn outcome) không tham gia tổng hợp số — cùng luật với API.
        const childItems = items.filter((i) => i.categoryid === cat.id && i.id !== totalItem.id
          && !i.outcomeid && i.gradetype !== 'scale');
        const calcItems: CalcItemInput[] = childItems.map((ci) => {
          const g = gradeByItem.get(ci.id);
          const isSubTotal = ci.itemtype === 'category' || ci.itemtype === 'course';
          const isCalculated = ci.itemtype === 'calculated';
          return {
            itemId: ci.id, grademin: ci.grademin, grademax: ci.grademax,
            grade: finalByItem.get(ci.id) ?? null,
            excluded: g?.excluded ?? false, extracredit: ci.extracredit,
            weightOverride: ci.weightoverride, weight: ci.aggregationcoef, aggregationcoef: ci.aggregationcoef,
            multiplicator: (isSubTotal || isCalculated) ? 1 : ci.multiplicator, offset: (isSubTotal || isCalculated) ? 0 : ci.plusfactor,
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
