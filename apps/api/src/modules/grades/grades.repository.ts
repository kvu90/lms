import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  gradeCategories, gradeGrades, gradeGradesHistory, gradeItems, gradeLetters, gradeOutcomes, scales,
  vnActivityMappings, vnCandidateActions, vnGradebooks, vnTermResults,
} from '../../db/schema';

export type CategoryRow = typeof gradeCategories.$inferSelect;
export type ItemRow = typeof gradeItems.$inferSelect;
export type GradeRow = typeof gradeGrades.$inferSelect;
export type LetterRow = typeof gradeLetters.$inferSelect;
export type ScaleRow = typeof scales.$inferSelect;
export type OutcomeRow = typeof gradeOutcomes.$inferSelect;
export type VnBookRow = typeof vnGradebooks.$inferSelect;
export type VnTermResultRow = typeof vnTermResults.$inferSelect;
export type VnActivityMappingRow = typeof vnActivityMappings.$inferSelect;
export type VnCandidateActionRow = typeof vnCandidateActions.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu sổ điểm: grade category, grade item, grade (điểm theo user), lịch sử điểm, grade letters và scales.
 */
export class GradesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  // categories
  /**
   * Chèn category điểm.
   */
  async insertCategory(v: typeof gradeCategories.$inferInsert): Promise<CategoryRow> {
    const [row] = await this.db.insert(gradeCategories).values(v).returning(); return row!;
  }
  /**
   * Lấy category theo id.
   */
  async getCategory(id: string): Promise<CategoryRow | undefined> {
    const [row] = await this.db.select().from(gradeCategories).where(eq(gradeCategories.id, id)); return row;
  }
  /**
   * Category của khoá học.
   */
  async listCategories(courseId: string): Promise<CategoryRow[]> {
    return this.db.select().from(gradeCategories).where(eq(gradeCategories.courseId, courseId)).orderBy(asc(gradeCategories.depth), asc(gradeCategories.id));
  }
  /**
   * Cập nhật category.
   */
  async updateCategory(id: string, patch: Partial<CategoryRow>): Promise<void> {
    await this.db.update(gradeCategories).set({ ...patch, updatedAt: new Date() }).where(eq(gradeCategories.id, id));
  }
  /**
   * Xoá category.
   */
  async deleteCategory(id: string): Promise<void> {
    await this.db.delete(gradeCategories).where(eq(gradeCategories.id, id));
  }
  /**
   * Category gốc của khoá học (tự tạo khi chưa có).
   */
  async rootCategory(courseId: string): Promise<CategoryRow | undefined> {
    const rows = await this.listCategories(courseId);
    return rows.find((c) => c.parent === null);
  }

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
   * Item trong một category.
   */
  async listItemsInCategory(categoryId: string): Promise<ItemRow[]> {
    return this.db.select().from(gradeItems).where(eq(gradeItems.categoryId, categoryId)).orderBy(asc(gradeItems.sortOrder), asc(gradeItems.id));
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

  // letters & scales
  /**
   * Bảng grade letters của khoá học.
   */
  async listLetters(contextId: string): Promise<LetterRow[]> {
    return this.db.select().from(gradeLetters).where(eq(gradeLetters.contextId, contextId)).orderBy(asc(gradeLetters.lowerBoundary));
  }
  /**
   * Thay toàn bộ bảng grade letters.
   */
  async replaceLetters(contextId: string, letters: { letter: string; lowerBoundary: number }[]): Promise<void> {
    await this.db.delete(gradeLetters).where(eq(gradeLetters.contextId, contextId));
    for (const l of letters) await this.db.insert(gradeLetters).values({ contextId: contextId, ...l });
  }
  /**
   * Chèn scale điểm tuỳ biến.
   */
  async insertScale(v: typeof scales.$inferInsert): Promise<ScaleRow> {
    const [row] = await this.db.insert(scales).values(v).returning(); return row!;
  }
  /**
   * Liệt kê scales.
   */
  async listScales(courseId: string): Promise<ScaleRow[]> {
    return this.db.select().from(scales).where(or(isNull(scales.courseId), eq(scales.courseId, courseId)));
  }
  /**
   * Lấy scale theo id.
   */
  async getScale(id: string): Promise<ScaleRow | undefined> {
    const [row] = await this.db.select().from(scales).where(eq(scales.id, id)); return row;
  }

  // outcomes
  /**
   * Chèn grade outcome.
   */
  async insertOutcome(v: typeof gradeOutcomes.$inferInsert): Promise<OutcomeRow> {
    const [row] = await this.db.insert(gradeOutcomes).values(v).returning(); return row!;
  }
  /**
   * Lấy grade outcome theo id.
   */
  async getOutcome(id: string): Promise<OutcomeRow | undefined> {
    const [row] = await this.db.select().from(gradeOutcomes).where(eq(gradeOutcomes.id, id)); return row;
  }
  /**
   * Liệt kê outcome khả dụng cho một khoá học: outcome mức site (courseId null) cộng outcome của chính khoá học đó.
   */
  async listOutcomes(courseId?: string): Promise<OutcomeRow[]> {
    if (courseId === undefined) {
      return this.db.select().from(gradeOutcomes).where(isNull(gradeOutcomes.courseId)).orderBy(asc(gradeOutcomes.id));
    }
    return this.db.select().from(gradeOutcomes)
      .where(or(isNull(gradeOutcomes.courseId), eq(gradeOutcomes.courseId, courseId)))
      .orderBy(asc(gradeOutcomes.id));
  }
  /**
   * Cập nhật grade outcome.
   */
  async updateOutcome(id: string, patch: Partial<OutcomeRow>): Promise<void> {
    await this.db.update(gradeOutcomes).set({ ...patch, updatedAt: new Date() }).where(eq(gradeOutcomes.id, id));
  }
  /**
   * Xoá grade outcome (item đang gắn sẽ được gỡ outcomeId nhờ khoá ngoại set null).
   */
  async deleteOutcome(id: string): Promise<void> {
    await this.db.delete(gradeOutcomes).where(eq(gradeOutcomes.id, id));
  }
  /**
   * Mọi grade item đang gắn một outcome (ở bất kỳ khoá học nào — outcome site dùng chung).
   */
  async listItemsForOutcome(outcomeId: string): Promise<ItemRow[]> {
    return this.db.select().from(gradeItems).where(eq(gradeItems.outcomeId, outcomeId));
  }
  /**
   * Tìm grade item theo idNumber trong một khoá học (khoá tham chiếu của công thức tính).
   */
  async findItemByIdnumber(courseId: string, idNumber: string): Promise<ItemRow | undefined> {
    const [row] = await this.db.select().from(gradeItems)
      .where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.idNumber, idNumber)));
    return row;
  }

  // vn gradebooks (GB-VN-1)
  /**
   * Chèn sổ VN.
   */
  async insertVnBook(v: typeof vnGradebooks.$inferInsert): Promise<VnBookRow> {
    const [row] = await this.db.insert(vnGradebooks).values(v).returning(); return row!;
  }
  /**
   * Lấy sổ VN theo id.
   */
  async getVnBook(id: string): Promise<VnBookRow | undefined> {
    const [row] = await this.db.select().from(vnGradebooks).where(eq(vnGradebooks.id, id)); return row;
  }
  /**
   * Sổ VN của một khoá học.
   */
  async listVnBooks(courseId: string): Promise<VnBookRow[]> {
    return this.db.select().from(vnGradebooks).where(eq(vnGradebooks.courseId, courseId)).orderBy(asc(vnGradebooks.term));
  }
  /**
   * Mọi sổ VN của một học kì (mọi khoá học) — đầu vào xếp mức chung của học sinh (Điều 9).
   */
  async listVnBooksByTerm(term: string): Promise<VnBookRow[]> {
    return this.db.select().from(vnGradebooks).where(eq(vnGradebooks.term, term)).orderBy(asc(vnGradebooks.id));
  }
  /**
   * Cập nhật sổ VN.
   */
  async updateVnBook(id: string, patch: Partial<VnBookRow>): Promise<void> {
    await this.db.update(vnGradebooks).set({ ...patch, updatedAt: new Date() }).where(eq(vnGradebooks.id, id));
  }
  /**
   * Các cột điểm thuộc một sổ VN, theo thứ tự hiển thị.
   */
  async listItemsByVnBook(bookId: string): Promise<ItemRow[]> {
    return this.db.select().from(gradeItems).where(eq(gradeItems.vnBookId, bookId)).orderBy(asc(gradeItems.sortOrder), asc(gradeItems.id));
  }
  /**
   * Chèn bản chốt kết quả sổ VN.
   */
  async insertVnTermResult(v: typeof vnTermResults.$inferInsert): Promise<VnTermResultRow> {
    const [row] = await this.db.insert(vnTermResults).values(v).returning(); return row!;
  }
  /**
   * Các bản chốt của một sổ cho một học sinh, mới nhất cuối danh sách.
   */
  async listVnTermResults(bookId: string, userId: string): Promise<VnTermResultRow[]> {
    return this.db.select().from(vnTermResults)
      .where(and(eq(vnTermResults.bookId, bookId), eq(vnTermResults.userId, userId)))
      .orderBy(asc(vnTermResults.version));
  }
  /**
   * Bản chốt cả năm của một học sinh trong một khoá học.
   */
  async listVnYearResults(courseId: string, userId: string): Promise<VnTermResultRow[]> {
    return this.db.select().from(vnTermResults)
      .where(and(eq(vnTermResults.courseId, courseId), eq(vnTermResults.userId, userId), eq(vnTermResults.scope, 'year')))
      .orderBy(asc(vnTermResults.version));
  }
  /**
   * Mọi bản chốt (term + year) của một học sinh — đầu vào xếp mức chung.
   */
  async listVnResultsForUser(userId: string): Promise<VnTermResultRow[]> {
    return this.db.select().from(vnTermResults).where(eq(vnTermResults.userId, userId)).orderBy(asc(vnTermResults.id));
  }

  // vn activity mappings + candidate actions (GB-VN-2)
  /**
   * Chèn khai vai trò điểm của hoạt động vào sổ VN.
   */
  async insertVnActivityMapping(v: typeof vnActivityMappings.$inferInsert): Promise<VnActivityMappingRow> {
    const [row] = await this.db.insert(vnActivityMappings).values(v).returning(); return row!;
  }
  /**
   * Lấy khai vai trò theo id.
   */
  async getVnActivityMapping(id: string): Promise<VnActivityMappingRow | undefined> {
    const [row] = await this.db.select().from(vnActivityMappings).where(eq(vnActivityMappings.id, id)); return row;
  }
  /**
   * Khai vai trò của một course module (duy nhất theo cm — một hoạt động chỉ vào một cột đích).
   */
  async findVnActivityMappingByCm(cmId: string): Promise<VnActivityMappingRow | undefined> {
    const [row] = await this.db.select().from(vnActivityMappings).where(eq(vnActivityMappings.cmId, cmId)); return row;
  }
  /**
   * Các khai vai trò của một sổ VN.
   */
  async listVnActivityMappings(bookId: string): Promise<VnActivityMappingRow[]> {
    return this.db.select().from(vnActivityMappings).where(eq(vnActivityMappings.bookId, bookId)).orderBy(asc(vnActivityMappings.createdAt), asc(vnActivityMappings.id));
  }
  /**
   * Xoá khai vai trò (vết quyết định cũ giữ nguyên — mapping_id trong vn_candidate_actions chuyển null).
   */
  async deleteVnActivityMapping(id: string): Promise<void> {
    await this.db.delete(vnActivityMappings).where(eq(vnActivityMappings.id, id));
  }
  /**
   * Ghi một quyết định của giáo viên trên luồng ứng viên → cột (chỉ thêm, không sửa hàng cũ).
   */
  async insertVnCandidateAction(v: typeof vnCandidateActions.$inferInsert): Promise<VnCandidateActionRow> {
    const [row] = await this.db.insert(vnCandidateActions).values(v).returning(); return row!;
  }
  /**
   * Mọi quyết định đã ghi trong một sổ VN, theo thứ tự thời gian tăng dần.
   */
  async listVnCandidateActions(bookId: string): Promise<VnCandidateActionRow[]> {
    return this.db.select().from(vnCandidateActions).where(eq(vnCandidateActions.bookId, bookId)).orderBy(asc(vnCandidateActions.createdAt), asc(vnCandidateActions.id));
  }
}
