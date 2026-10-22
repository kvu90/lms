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
export class CompletionRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async getCmCompletion(cmid: number, userid: number): Promise<CmCompletionRow | undefined> {
    const [row] = await this.db.select().from(courseModulesCompletion)
      .where(and(eq(courseModulesCompletion.coursemoduleid, cmid), eq(courseModulesCompletion.userid, userid)));
    return row;
  }
  async upsertCmCompletion(v: typeof courseModulesCompletion.$inferInsert, tx?: DbTx): Promise<CmCompletionRow> {
    const [row] = await (tx ?? this.db).insert(courseModulesCompletion).values(v)
      .onConflictDoUpdate({
        target: [courseModulesCompletion.coursemoduleid, courseModulesCompletion.userid],
        set: { completionstate: v.completionstate, viewed: v.viewed, overrideby: v.overrideby, timemodified: new Date() },
      }).returning();
    return row!;
  }
  async listCmCompletionsForUser(userid: number, cmIds: number[]): Promise<CmCompletionRow[]> {
    if (!cmIds.length) return [];
    return this.db.select().from(courseModulesCompletion)
      .where(and(eq(courseModulesCompletion.userid, userid), inArray(courseModulesCompletion.coursemoduleid, cmIds)));
  }
  async listCmCompletionsForCm(cmid: number): Promise<CmCompletionRow[]> {
    return this.db.select().from(courseModulesCompletion).where(eq(courseModulesCompletion.coursemoduleid, cmid));
  }
  async deleteCmCompletionsForCm(cmid: number): Promise<number> {
    const deleted = await this.db.delete(courseModulesCompletion).where(eq(courseModulesCompletion.coursemoduleid, cmid)).returning();
    return deleted.length;
  }
  async hasAnyCmCompletion(userid: number, cmIds: number[]): Promise<boolean> {
    const rows = await this.listCmCompletionsForUser(userid, cmIds);
    return rows.length > 0;
  }

  async insertCriteria(v: typeof courseCompletionCriteria.$inferInsert): Promise<CriteriaRow> {
    const [row] = await this.db.insert(courseCompletionCriteria).values(v).returning(); return row!;
  }
  async listCriteria(courseId: number): Promise<CriteriaRow[]> {
    return this.db.select().from(courseCompletionCriteria).where(eq(courseCompletionCriteria.course, courseId)).orderBy(courseCompletionCriteria.sortorder, courseCompletionCriteria.id);
  }
  async deleteCriteria(id: number): Promise<void> {
    await this.db.delete(courseCompletionCriteria).where(eq(courseCompletionCriteria.id, id));
  }
  async getSettings(courseId: number): Promise<{ method: number }> {
    const [row] = await this.db.select().from(courseCompletionSettings).where(eq(courseCompletionSettings.course, courseId));
    return row ?? { method: 1 };
  }
  async setSettings(courseId: number, method: number): Promise<void> {
    await this.db.insert(courseCompletionSettings).values({ course: courseId, method })
      .onConflictDoUpdate({ target: courseCompletionSettings.course, set: { method } });
  }

  async getCourseCompletion(userid: number, courseId: number): Promise<CourseCompletionRow | undefined> {
    const [row] = await this.db.select().from(courseCompletions)
      .where(and(eq(courseCompletions.userid, userid), eq(courseCompletions.course, courseId)));
    return row;
  }
  async upsertCourseCompletion(v: typeof courseCompletions.$inferInsert): Promise<CourseCompletionRow> {
    const [row] = await this.db.insert(courseCompletions).values(v)
      .onConflictDoUpdate({
        target: [courseCompletions.userid, courseCompletions.course],
        set: { status: v.status, timestarted: v.timestarted, timecompleted: v.timecompleted, reaggregate: new Date() },
      }).returning();
    return row!;
  }
  async listCourseCompletions(courseId: number): Promise<CourseCompletionRow[]> {
    return this.db.select().from(courseCompletions).where(eq(courseCompletions.course, courseId));
  }
}
