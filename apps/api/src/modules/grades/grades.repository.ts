import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  gradeGrades, gradeGradesHistory, gradeItems, gradePublications,
} from '../../db/schema';

export type ItemRow = typeof gradeItems.$inferSelect;
export type GradeRow = typeof gradeGrades.$inferSelect;
export type GradePublicationRow = typeof gradePublications.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu điểm theo bài: grade item (một item = một bài/hoạt động),
 * điểm theo user, lịch sử điểm và vết công bố cấp bài.
 */
export class GradesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // items
  /**
   * Chèn grade item.
   */
  async insertItem(v: typeof gradeItems.$inferInsert): Promise<ItemRow> {
    const [row] = await this.db.insert(gradeItems).values(v).returning(); return row!;
  }
  /**
   * Lấy item theo id.
   */
  async getItem(id: string): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems).where(eq(gradeItems.id, id)); return row;
  }
  /**
   * Item của khoá học.
   */
  async listItems(courseId: string): Promise<ItemRow[]> {
    return this.db.select().from(gradeItems).where(eq(gradeItems.courseId, courseId)).orderBy(asc(gradeItems.sortOrder), asc(gradeItems.id));
  }
  /**
   * Tìm item theo (itemType, itemInstance) — khoá liên kết với hoạt động nguồn.
   */
  async findItemByTypeInstance(courseId: string, itemType: string, itemInstance: string): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems)
      .where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.itemType, itemType), eq(gradeItems.itemInstance, itemInstance)));
    return row;
  }
  /**
   * Tìm item gắn với một course module.
   */
  async findItemForCm(courseId: string, cmId: string): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems)
      .where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.itemType, 'mod'), eq(gradeItems.itemInstance, cmId)));
    return row;
  }
  /**
   * Cập nhật item.
   */
  async updateItem(id: string, patch: Partial<ItemRow>): Promise<void> {
    await this.db.update(gradeItems).set({ ...patch, updatedAt: new Date() }).where(eq(gradeItems.id, id));
  }
  /**
   * Xoá item.
   */
  async deleteItem(id: string): Promise<void> {
    await this.db.delete(gradeItems).where(eq(gradeItems.id, id));
  }

  // grades
  /**
   * Điểm của user tại một item.
   */
  async getGrade(itemId: string, userId: string): Promise<GradeRow | undefined> {
    const [row] = await this.db.select().from(gradeGrades)
      .where(and(eq(gradeGrades.itemId, itemId), eq(gradeGrades.userId, userId)));
    return row;
  }
  /**
   * Mọi điểm của khoá học.
   */
  async listGradesForCourse(courseId: string, userId?: string): Promise<GradeRow[]> {
    const items = await this.listItems(courseId);
    if (!items.length) return [];
    const conds = [inArray(gradeGrades.itemId, items.map((i) => i.id))];
    if (userId !== undefined) conds.push(eq(gradeGrades.userId, userId));
    return this.db.select().from(gradeGrades).where(and(...conds));
  }
  /**
   * Lấy một bản ghi điểm theo id.
   */
  async getGradeById(id: string): Promise<GradeRow | undefined> {
    const [row] = await this.db.select().from(gradeGrades).where(eq(gradeGrades.id, id)); return row;
  }
  /**
   * Mọi điểm tại một item.
   */
  async listGradesForItem(itemId: string): Promise<GradeRow[]> {
    return this.db.select().from(gradeGrades).where(eq(gradeGrades.itemId, itemId));
  }
  /**
   * Ghi/cập nhật điểm (kèm ghi lịch sử ở tầng service).
   */
  async upsertGrade(v: typeof gradeGrades.$inferInsert, tx?: DbTx): Promise<GradeRow> {
    const [row] = await (tx ?? this.db).insert(gradeGrades).values(v)
      .onConflictDoUpdate({
        target: [gradeGrades.itemId, gradeGrades.userId],
        set: {
          rawGrade: v.rawGrade, finalGrade: v.finalGrade, hidden: v.hidden, locked: v.locked,
          overridden: v.overridden, excluded: v.excluded, frozen: v.frozen, feedback: v.feedback,
          aggregationStatus: v.aggregationStatus, aggregationWeight: v.aggregationWeight,
          lockTime: v.lockTime, updatedAt: new Date(),
        },
      }).returning();
    return row!;
  }
  /**
   * Cập nhật một bản ghi điểm.
   */
  async updateGrade(id: string, patch: Partial<GradeRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(gradeGrades).set({ ...patch, updatedAt: new Date() }).where(eq(gradeGrades.id, id));
  }
  /**
   * Ghi một dòng lịch sử thay đổi điểm.
   */
  async insertHistory(v: typeof gradeGradesHistory.$inferInsert, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(gradeGradesHistory).values(v);
  }
  /**
   * Lịch sử thay đổi điểm của một item/user.
   */
  async listHistory(itemId: string, userId: string): Promise<(typeof gradeGradesHistory.$inferSelect)[]> {
    return this.db.select().from(gradeGradesHistory)
      .where(and(eq(gradeGradesHistory.itemId, itemId), eq(gradeGradesHistory.userId, userId)))
      .orderBy(asc(gradeGradesHistory.id));
  }

  // publications (PH-0, issue #116)
  /** Ghi một hành động công bố/rút công bố cho một item (bảng append-only grade_publications). */
  async insertPublication(v: typeof gradePublications.$inferInsert): Promise<GradePublicationRow> {
    const [row] = await this.db.insert(gradePublications).values(v).returning(); return row!;
  }
  /** Mọi vết công bố của một khoá theo thứ tự thời gian tăng dần — trạng thái hiệu lực suy từ vết mới nhất của từng item. */
  async listPublications(courseId: string): Promise<GradePublicationRow[]> {
    return this.db.select().from(gradePublications).where(eq(gradePublications.courseId, courseId)).orderBy(asc(gradePublications.createdAt), asc(gradePublications.id));
  }
}
