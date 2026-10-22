import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { courseCompletionCriteria, courseCompletions, courseCompletionSettings, courseModulesCompletion } from '../../db/schema';

export type CmCompletionRow = typeof courseModulesCompletion.$inferSelect;
export type CriteriaRow = typeof courseCompletionCriteria.$inferSelect;
export type CourseCompletionRow = typeof courseCompletions.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu hoàn thành: trạng thái completion của cm theo user, tiêu chí hoàn thành khoá học, cấu hình và bản ghi hoàn thành khoá học.
 */
export class CompletionRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Trạng thái hoàn thành một cm của một user.
   */
  async getCmCompletion(cmid: string, userid: string): Promise<CmCompletionRow | undefined> {
    const [row] = await this.db.select().from(courseModulesCompletion)
      .where(and(eq(courseModulesCompletion.coursemoduleid, cmid), eq(courseModulesCompletion.userid, userid)));
    return row;
  }
  /**
   * Ghi/cập nhật trạng thái hoàn thành cm.
   */
  async upsertCmCompletion(v: typeof courseModulesCompletion.$inferInsert, tx?: DbTx): Promise<CmCompletionRow> {
    const [row] = await (tx ?? this.db).insert(courseModulesCompletion).values(v)
      .onConflictDoUpdate({
        target: [courseModulesCompletion.coursemoduleid, courseModulesCompletion.userid],
        set: { completionstate: v.completionstate, viewed: v.viewed, overrideby: v.overrideby, timemodified: new Date() },
      }).returning();
    return row!;
  }
  /**
   * Mọi trạng thái hoàn thành cm của user trong khoá học.
   */
  async listCmCompletionsForUser(userid: string, cmIds: string[]): Promise<CmCompletionRow[]> {
    if (!cmIds.length) return [];
    return this.db.select().from(courseModulesCompletion)
      .where(and(eq(courseModulesCompletion.userid, userid), inArray(courseModulesCompletion.coursemoduleid, cmIds)));
  }
  /**
   * Mọi trạng thái hoàn thành của một cm.
   */
  async listCmCompletionsForCm(cmid: string): Promise<CmCompletionRow[]> {
    return this.db.select().from(courseModulesCompletion).where(eq(courseModulesCompletion.coursemoduleid, cmid));
  }
  /**
   * Xoá trạng thái hoàn thành khi cm bị xoá.
   */
  async deleteCmCompletionsForCm(cmid: string): Promise<number> {
    const deleted = await this.db.delete(courseModulesCompletion).where(eq(courseModulesCompletion.coursemoduleid, cmid)).returning();
    return deleted.length;
  }
  /**
   * Cm đã có bất kỳ bản ghi hoàn thành nào chưa (probe dữ liệu liên quan).
   */
  async hasAnyCmCompletion(userid: string, cmIds: string[]): Promise<boolean> {
    const rows = await this.listCmCompletionsForUser(userid, cmIds);
    return rows.length > 0;
  }

  /**
   * Thêm một tiêu chí hoàn thành khoá học.
   */
  async insertCriteria(v: typeof courseCompletionCriteria.$inferInsert): Promise<CriteriaRow> {
    const [row] = await this.db.insert(courseCompletionCriteria).values(v).returning(); return row!;
  }
  /**
   * Tiêu chí của khoá học.
   */
  async listCriteria(courseId: string): Promise<CriteriaRow[]> {
    return this.db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId)).orderBy(courseCompletionCriteria.sortorder, courseCompletionCriteria.id);
  }
  /**
   * Xoá toàn bộ tiêu chí của khoá học (khi đặt lại).
   */
  async deleteCriteria(id: string): Promise<void> {
    await this.db.delete(courseCompletionCriteria).where(eq(courseCompletionCriteria.id, id));
  }
  /**
   * Cấu hình completion của khoá học.
   */
  async getSettings(courseId: string): Promise<{ method: number }> {
    const [row] = await this.db.select().from(courseCompletionSettings).where(eq(courseCompletionSettings.course, courseId));
    return row ?? { method: 1 };
  }
  /**
   * Ghi cấu hình completion.
   */
  async setSettings(courseId: string, method: number): Promise<void> {
    await this.db.insert(courseCompletionSettings).values({ course: courseId, method })
      .onConflictDoUpdate({ target: courseCompletionSettings.course, set: { method } });
  }

  /**
   * Bản ghi hoàn thành khoá học của user.
   */
  async getCourseCompletion(userid: string, courseId: string): Promise<CourseCompletionRow | undefined> {
    const [row] = await this.db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.userid, userid), eq(courseCompletions.course, courseId)));
    return row;
  }
  /**
   * Ghi/cập nhật bản ghi hoàn thành khoá học.
   */
  async upsertCourseCompletion(v: typeof courseCompletions.$inferInsert): Promise<CourseCompletionRow> {
    const [row] = await this.db.insert(courseCompletions).values(v)
      .onConflictDoUpdate({
        target: [courseCompletions.userid, courseCompletions.course],
        set: { status: v.status, timestarted: v.timestarted, timecompleted: v.timecompleted, reaggregate: new Date() },
      }).returning();
    return row!;
  }
  /**
   * Mọi bản ghi hoàn thành của khoá học.
   */
  async listCourseCompletions(courseId: string): Promise<CourseCompletionRow[]> {
    return this.db.select().from(courseCompletions).where(eq(courseCompletions.course, courseId));
  }
}
