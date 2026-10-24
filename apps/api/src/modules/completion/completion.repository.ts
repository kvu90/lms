import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { courseCompletionCriteria, courseCompletionCritCompl, courseCompletions, courseCompletionSettings, courseModulesCompletion } from '../../db/schema';

export type CmCompletionRow = typeof courseModulesCompletion.$inferSelect;
export type CriteriaRow = typeof courseCompletionCriteria.$inferSelect;
export type CritComplRow = typeof courseCompletionCritCompl.$inferSelect;
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
  async getCmCompletion(cmid: string, userId: string): Promise<CmCompletionRow | undefined> {
    const [row] = await this.db.select().from(courseModulesCompletion)
      .where(and(eq(courseModulesCompletion.courseModuleId, cmid), eq(courseModulesCompletion.userId, userId)));
    return row;
  }
  /**
   * Ghi/cập nhật trạng thái hoàn thành cm.
   */
  async upsertCmCompletion(v: typeof courseModulesCompletion.$inferInsert, tx?: DbTx): Promise<CmCompletionRow> {
    const [row] = await (tx ?? this.db).insert(courseModulesCompletion).values(v)
      .onConflictDoUpdate({
        target: [courseModulesCompletion.courseModuleId, courseModulesCompletion.userId],
        set: { completionState: v.completionState, viewed: v.viewed, overrideBy: v.overrideBy, updatedAt: new Date() },
      }).returning();
    return row!;
  }
  /**
   * Mọi trạng thái hoàn thành cm của user trong khoá học.
   */
  async listCmCompletionsForUser(userId: string, cmIds: string[]): Promise<CmCompletionRow[]> {
    if (!cmIds.length) return [];
    return this.db.select().from(courseModulesCompletion)
      .where(and(eq(courseModulesCompletion.userId, userId), inArray(courseModulesCompletion.courseModuleId, cmIds)));
  }
  /**
   * Mọi trạng thái hoàn thành của một cm.
   */
  async listCmCompletionsForCm(cmid: string): Promise<CmCompletionRow[]> {
    return this.db.select().from(courseModulesCompletion).where(eq(courseModulesCompletion.courseModuleId, cmid));
  }
  /**
   * Xoá trạng thái hoàn thành khi cm bị xoá.
   */
  async deleteCmCompletionsForCm(cmid: string): Promise<number> {
    const deleted = await this.db.delete(courseModulesCompletion).where(eq(courseModulesCompletion.courseModuleId, cmid)).returning();
    return deleted.length;
  }
  /**
   * Cm đã có bất kỳ bản ghi hoàn thành nào chưa (probe dữ liệu liên quan).
   */
  async hasAnyCmCompletion(userId: string, cmIds: string[]): Promise<boolean> {
    const rows = await this.listCmCompletionsForUser(userId, cmIds);
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
    return this.db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId)).orderBy(courseCompletionCriteria.sortOrder, courseCompletionCriteria.id);
  }
  /**
   * Xoá toàn bộ tiêu chí của khoá học (khi đặt lại).
   */
  async deleteCriteria(id: string): Promise<void> {
    await this.db.delete(courseCompletionCriteria).where(eq(courseCompletionCriteria.id, id));
  }
  /**
   * Một tiêu chí theo id (kèm kiểm tra thuộc khoá học ở tầng nghiệp vụ).
   */
  async getCriteria(id: string): Promise<CriteriaRow | undefined> {
    const [row] = await this.db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.id, id));
    return row;
  }
  /**
   * Các khoá học có tiêu chí 'course' trỏ vào khoá học này (khoá phụ thuộc
   * vào khoá tiên quyết) — dùng để đánh giá lại khi khoá tiên quyết hoàn thành.
   */
  async listDependentCourseIds(prerequisiteCourseId: string): Promise<string[]> {
    const rows = await this.db.select({ course: courseCompletionCriteria.course }).from(courseCompletionCriteria)
      .where(and(eq(courseCompletionCriteria.criteriaType, 'course'), eq(courseCompletionCriteria.courseInstance, prerequisiteCourseId)));
    return [...new Set(rows.map((r) => r.course))];
  }

  /**
   * Dấu hoàn thành thủ công (crit_compl) của một tiêu chí cho một user:
   * có dòng = tiêu chí thủ công (self/role) đã đạt.
   */
  async getCritCompl(criteriaId: string, userId: string): Promise<CritComplRow | undefined> {
    const [row] = await this.db.select().from(courseCompletionCritCompl)
      .where(and(eq(courseCompletionCritCompl.criteriaId, criteriaId), eq(courseCompletionCritCompl.userId, userId)));
    return row;
  }
  /**
   * Mọi dấu hoàn thành thủ công của user trong tập tiêu chí cho trước
   * (nạp một lần cho tầng đánh giá).
   */
  async listCritComplForUser(criteriaIds: string[], userId: string): Promise<CritComplRow[]> {
    if (!criteriaIds.length) return [];
    return this.db.select().from(courseCompletionCritCompl)
      .where(and(eq(courseCompletionCritCompl.userId, userId), inArray(courseCompletionCritCompl.criteriaId, criteriaIds)));
  }
  /**
   * Ghi dấu hoàn thành thủ công cho một tiêu chí (ghi lại thì cập nhật
   * người đánh dấu và thời điểm).
   */
  async upsertCritCompl(v: typeof courseCompletionCritCompl.$inferInsert): Promise<CritComplRow> {
    const [row] = await this.db.insert(courseCompletionCritCompl).values(v)
      .onConflictDoUpdate({
        target: [courseCompletionCritCompl.criteriaId, courseCompletionCritCompl.userId],
        set: { markedBy: v.markedBy, timeCompleted: new Date() },
      }).returning();
    return row!;
  }
  /**
   * Xoá dấu hoàn thành thủ công (bỏ đánh dấu).
   */
  async deleteCritCompl(criteriaId: string, userId: string): Promise<void> {
    await this.db.delete(courseCompletionCritCompl)
      .where(and(eq(courseCompletionCritCompl.criteriaId, criteriaId), eq(courseCompletionCritCompl.userId, userId)));
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
  async getCourseCompletion(userId: string, courseId: string): Promise<CourseCompletionRow | undefined> {
    const [row] = await this.db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.userId, userId), eq(courseCompletions.course, courseId)));
    return row;
  }
  /**
   * Ghi/cập nhật bản ghi hoàn thành khoá học.
   */
  async upsertCourseCompletion(v: typeof courseCompletions.$inferInsert): Promise<CourseCompletionRow> {
    const [row] = await this.db.insert(courseCompletions).values(v)
      .onConflictDoUpdate({
        target: [courseCompletions.userId, courseCompletions.course],
        set: { status: v.status, timeStarted: v.timeStarted, timeCompleted: v.timeCompleted, reAggregate: new Date() },
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
