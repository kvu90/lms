import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import type { DbTx } from './curriculum.repository';
import { curriculumTextbookMappings, curriculumTextbookNodes, curriculumTextbookRecords, curriculumTextbooks } from './schema';

export type TextbookRow = typeof curriculumTextbooks.$inferSelect;
export type TextbookNodeRow = typeof curriculumTextbookNodes.$inferSelect;
export type TextbookMappingRow = typeof curriculumTextbookMappings.$inferSelect;
export type TextbookRecordRow = typeof curriculumTextbookRecords.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu tầng SGK (K0b): sách → cây node (chủ đề → bài) → ánh xạ
 * sang chương trình → sổ đăng ký nạp. Thứ tự hiển thị luôn là position
 * tăng dần, rồi thời gian tạo để ổn định khi trùng position — cùng quy
 * ước của CurriculumRepository.
 */
export class TextbookRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Handle DB gốc — tầng service mở transaction khi cần ghi nguyên tử nhiều bảng (nạp dataset). */
  get dbHandle(): Database { return this.db; }

  // --- sách -------------------------------------------------------------------

  /** Chèn cuốn sách. */
  async insertTextbook(v: typeof curriculumTextbooks.$inferInsert, tx?: DbTx): Promise<TextbookRow> {
    const [row] = await (tx ?? this.db).insert(curriculumTextbooks).values(v).returning(); return row!;
  }
  /** Lấy cuốn sách theo id. */
  async getTextbook(id: string): Promise<TextbookRow | undefined> {
    const [row] = await this.db.select().from(curriculumTextbooks).where(eq(curriculumTextbooks.id, id)); return row;
  }
  /** Tìm cuốn sách theo định danh tự nhiên (môn, khối, tựa) — khoá tìm-tạo của lượt nạp. */
  async findTextbook(subjectId: string, grade: number, title: string): Promise<TextbookRow | undefined> {
    const [row] = await this.db.select().from(curriculumTextbooks)
      .where(and(eq(curriculumTextbooks.subjectId, subjectId), eq(curriculumTextbooks.grade, grade), eq(curriculumTextbooks.title, title)));
    return row;
  }
  /** Liệt kê sách, tuỳ chọn lọc theo môn. */
  async listTextbooks(subjectId?: string): Promise<TextbookRow[]> {
    const query = this.db.select().from(curriculumTextbooks);
    const rows = subjectId ? await query.where(eq(curriculumTextbooks.subjectId, subjectId)) : await query;
    return rows.sort((a, b) => a.grade - b.grade || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  }

  // --- cây sách ---------------------------------------------------------------

  /** Chèn node sách (chủ đề hoặc bài). */
  async insertTextbookNode(v: typeof curriculumTextbookNodes.$inferInsert, tx?: DbTx): Promise<TextbookNodeRow> {
    const [row] = await (tx ?? this.db).insert(curriculumTextbookNodes).values(v).returning(); return row!;
  }
  /** Lấy node sách theo id. */
  async getTextbookNode(id: string): Promise<TextbookNodeRow | undefined> {
    const [row] = await this.db.select().from(curriculumTextbookNodes).where(eq(curriculumTextbookNodes.id, id)); return row;
  }
  /** Toàn bộ node của một cuốn sách theo thứ tự cây (position, rồi thời gian tạo). */
  async listTextbookNodes(textbookId: string): Promise<TextbookNodeRow[]> {
    return this.db.select().from(curriculumTextbookNodes).where(eq(curriculumTextbookNodes.textbookId, textbookId))
      .orderBy(asc(curriculumTextbookNodes.position), asc(curriculumTextbookNodes.createdAt));
  }
  /** Sửa node sách (đã lọc trường ở tầng service). */
  async updateTextbookNode(id: string, v: Partial<typeof curriculumTextbookNodes.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(curriculumTextbookNodes).set({ ...v, updatedAt: new Date() }).where(eq(curriculumTextbookNodes.id, id));
  }

  // --- ánh xạ -----------------------------------------------------------------

  /** Chèn một dòng ánh xạ bài → node chương trình hoặc → YCCĐ. */
  async insertMapping(v: typeof curriculumTextbookMappings.$inferInsert, tx?: DbTx): Promise<TextbookMappingRow> {
    const [row] = await (tx ?? this.db).insert(curriculumTextbookMappings).values(v).returning(); return row!;
  }
  /** Mọi dòng ánh xạ của một node bài. */
  async listMappingsForNode(textbookNodeId: string): Promise<TextbookMappingRow[]> {
    return this.db.select().from(curriculumTextbookMappings).where(eq(curriculumTextbookMappings.textbookNodeId, textbookNodeId))
      .orderBy(asc(curriculumTextbookMappings.createdAt));
  }
  /** Mọi dòng ánh xạ của nhiều node bài (cho cây sách/đơn vị khung). */
  async listMappingsForNodes(textbookNodeIds: string[]): Promise<TextbookMappingRow[]> {
    if (textbookNodeIds.length === 0) return [];
    return this.db.select().from(curriculumTextbookMappings).where(inArray(curriculumTextbookMappings.textbookNodeId, textbookNodeIds))
      .orderBy(asc(curriculumTextbookMappings.createdAt));
  }
  /** Xoá toàn bộ ánh xạ của một node bài (thay mới khi dataset đính chính). */
  async deleteMappingsForNode(textbookNodeId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(curriculumTextbookMappings).where(eq(curriculumTextbookMappings.textbookNodeId, textbookNodeId));
  }

  // --- sổ đăng ký nạp -----------------------------------------------------------

  /** Tra sổ đăng ký theo cặp (dataset, mã bản ghi) — khoá idempotent của lượt nạp. */
  async getTextbookRecord(datasetKey: string, recordId: string): Promise<TextbookRecordRow | undefined> {
    const [row] = await this.db.select().from(curriculumTextbookRecords)
      .where(and(eq(curriculumTextbookRecords.datasetKey, datasetKey), eq(curriculumTextbookRecords.recordId, recordId)));
    return row;
  }
  /** Mọi dòng sổ của một dataset. */
  async listTextbookRecords(datasetKey: string): Promise<TextbookRecordRow[]> {
    return this.db.select().from(curriculumTextbookRecords).where(eq(curriculumTextbookRecords.datasetKey, datasetKey));
  }
  /** Mọi dòng sổ trỏ vào một cuốn sách (mọi dataset) — dựng mã bản ghi cho cây sách. */
  async listTextbookRecordsByTextbook(textbookId: string): Promise<TextbookRecordRow[]> {
    return this.db.select().from(curriculumTextbookRecords).where(eq(curriculumTextbookRecords.textbookId, textbookId));
  }
  /** Ghi dòng sổ cho một bản ghi vừa nạp. */
  async insertTextbookRecord(v: typeof curriculumTextbookRecords.$inferInsert, tx?: DbTx): Promise<TextbookRecordRow> {
    const [row] = await (tx ?? this.db).insert(curriculumTextbookRecords).values(v).returning(); return row!;
  }
  /** Cập nhật dòng sổ khi dataset đính chính. */
  async updateTextbookRecord(id: string, v: Partial<typeof curriculumTextbookRecords.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(curriculumTextbookRecords).set({ ...v, updatedAt: new Date() }).where(eq(curriculumTextbookRecords.id, id));
  }
}
