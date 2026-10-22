import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  gradeCategories, gradeGrades, gradeGradesHistory, gradeItems, gradeLetters, scales,
} from '../../db/schema';

export type CategoryRow = typeof gradeCategories.$inferSelect;
export type ItemRow = typeof gradeItems.$inferSelect;
export type GradeRow = typeof gradeGrades.$inferSelect;
export type LetterRow = typeof gradeLetters.$inferSelect;
export type ScaleRow = typeof scales.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class GradesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // categories
  async insertCategory(v: typeof gradeCategories.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.db.insert(gradeCategories).values(v).returning(); return row!;
  }
  async getCategory(id: number): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(gradeCategories).where(eq(gradeCategories.id, id)); return row;
  }
  async listCategories(courseId: number): Promise<CategoryRow[]> {
    return this.db.select().from(gradeCategories).where(eq(gradeCategories.courseid, courseId)).orderBy(asc(gradeCategories.depth), asc(gradeCategories.id));
  }
  async updateCategory(id: number, patch: Partial<CategoryRow>): Promise<void> {
    await this.db.update(gradeCategories).set({ ...patch, timemodified: new Date() }).where(eq(gradeCategories.id, id));
  }
  async deleteCategory(id: number): Promise<void> {
    await this.db.delete(gradeCategories).where(eq(gradeCategories.id, id));
  }
  async rootCategory(courseId: number): Promise<CategoryRow | undefined> {
    const rows = await this.listCategories(courseId);
    return rows.find((c) => c.parent === null || c.parent === 0);
  }

  // items
  async insertItem(v: typeof gradeItems.$inferInsert): Promise<ItemRow> {
    const [row] = await this.db.insert(gradeItems).values(v).returning(); return row!;
  }
  async getItem(id: number): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems).where(eq(gradeItems.id, id)); return row;
  }
  async listItems(courseId: number): Promise<ItemRow[]> {
    return this.db.select().from(gradeItems).where(eq(gradeItems.courseid, courseId)).orderBy(asc(gradeItems.sortorder), asc(gradeItems.id));
  }
  async listItemsInCategory(categoryId: number): Promise<ItemRow[]> {
    return this.db.select().from(gradeItems).where(eq(gradeItems.categoryid, categoryId)).orderBy(asc(gradeItems.sortorder), asc(gradeItems.id));
  }
  async findItemByTypeInstance(courseId: number, itemtype: string, iteminstance: number): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems)
      .where(and(eq(gradeItems.courseid, courseId), eq(gradeItems.itemtype, itemtype), eq(gradeItems.iteminstance, iteminstance)));
    return row;
  }
  async findItemForCm(courseId: number, cmId: number): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems)
      .where(and(eq(gradeItems.courseid, courseId), eq(gradeItems.itemtype, 'mod'), eq(gradeItems.iteminstance, cmId)));
    return row;
  }
  async updateItem(id: number, patch: Partial<ItemRow>): Promise<void> {
    await this.db.update(gradeItems).set({ ...patch, timemodified: new Date() }).where(eq(gradeItems.id, id));
  }
  async deleteItem(id: number): Promise<void> {
    await this.db.delete(gradeItems).where(eq(gradeItems.id, id));
  }

  // grades
  async getGrade(itemId: number, userId: number): Promise<GradeRow | undefined> {
    const [row] = await this.db.select().from(gradeGrades)
      .where(and(eq(gradeGrades.itemid, itemId), eq(gradeGrades.userid, userId)));
    return row;
  }
  async listGradesForCourse(courseId: number, userId?: number): Promise<GradeRow[]> {
    const items = await this.listItems(courseId);
    if (!items.length) return [];
    const conds = [inArray(gradeGrades.itemid, items.map((i) => i.id))];
    if (userId !== undefined) conds.push(eq(gradeGrades.userid, userId));
    return this.db.select().from(gradeGrades).where(and(...conds));
  }
  async getGradeById(id: number): Promise<GradeRow | undefined> {
    const [row] = await this.db.select().from(gradeGrades).where(eq(gradeGrades.id, id)); return row;
  }
  async listGradesForItem(itemId: number): Promise<GradeRow[]> {
    return this.db.select().from(gradeGrades).where(eq(gradeGrades.itemid, itemId));
  }
  async upsertGrade(v: typeof gradeGrades.$inferInsert, tx?: DbTx): Promise<GradeRow> {
    const [row] = await (tx ?? this.db).insert(gradeGrades).values(v)
      .onConflictDoUpdate({
        target: [gradeGrades.itemid, gradeGrades.userid],
        set: {
          rawgrade: v.rawgrade, finalgrade: v.finalgrade, hidden: v.hidden, locked: v.locked,
          overridden: v.overridden, excluded: v.excluded, frozen: v.frozen, feedback: v.feedback,
          aggregationstatus: v.aggregationstatus, aggregationweight: v.aggregationweight,
          locktime: v.locktime, timemodified: new Date(),
        },
      }).returning();
    return row!;
  }
  async updateGrade(id: number, patch: Partial<GradeRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(gradeGrades).set({ ...patch, timemodified: new Date() }).where(eq(gradeGrades.id, id));
  }
  async insertHistory(v: typeof gradeGradesHistory.$inferInsert, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(gradeGradesHistory).values(v);
  }
  async listHistory(itemId: number, userId: number): Promise<(typeof gradeGradesHistory.$inferSelect)[]> {
    return this.db.select().from(gradeGradesHistory)
      .where(and(eq(gradeGradesHistory.itemid, itemId), eq(gradeGradesHistory.userid, userId)))
      .orderBy(asc(gradeGradesHistory.id));
  }

  // letters & scales
  async listLetters(contextId: number): Promise<LetterRow[]> {
    return this.db.select().from(gradeLetters).where(eq(gradeLetters.contextid, contextId)).orderBy(asc(gradeLetters.lowerboundary));
  }
  async replaceLetters(contextId: number, letters: { letter: string; lowerboundary: number }[]): Promise<void> {
    await this.db.delete(gradeLetters).where(eq(gradeLetters.contextid, contextId));
    for (const l of letters) await this.db.insert(gradeLetters).values({ contextid: contextId, ...l });
  }
  async insertScale(v: typeof scales.$inferInsert): Promise<ScaleRow> {
    const [row] = await this.db.insert(scales).values(v).returning(); return row!;
  }
  async listScales(courseId: number): Promise<ScaleRow[]> {
    return this.db.select().from(scales).where(inArray(scales.courseid, [0, courseId]));
  }
}
