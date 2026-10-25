import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/database';
import type { DbTx } from '../curriculum/curriculum.repository';
import { bookMappings, bookNodes, bookRecords, books } from '../../db/schema';

export type BookRow = typeof books.$inferSelect;
export type BookNodeRow = typeof bookNodes.$inferSelect;
export type BookMappingRow = typeof bookMappings.$inferSelect;
export type BookRecordRow = typeof bookRecords.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu tầng SGK (K0b): sách → cây node (chủ đề → bài) → ánh xạ
 * sang chương trình → sổ đăng ký nạp. Thứ tự hiển thị luôn là position
 * tăng dần, rồi thời gian tạo để ổn định khi trùng position — cùng quy
 * ước của CurriculumRepository.
 */
export class BookRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Handle DB gốc — tầng service mở transaction khi cần ghi nguyên tử nhiều bảng (nạp dataset). */
  get dbHandle(): Database { return this.db; }

  // --- sách -------------------------------------------------------------------

  /** Chèn cuốn sách. */
  async insertBook(v: typeof books.$inferInsert, tx?: DbTx): Promise<BookRow> {
    const [row] = await (tx ?? this.db).insert(books).values(v).returning(); return row!;
  }
  /** Lấy cuốn sách theo id. */
  async getBook(id: string): Promise<BookRow | undefined> {
    const [row] = await this.db.select().from(books).where(eq(books.id, id)); return row;
  }
  /** Tìm cuốn sách theo định danh tự nhiên (môn, khối, tựa) — khoá tìm-tạo của lượt nạp. */
  async findBook(subjectId: string, grade: number, title: string): Promise<BookRow | undefined> {
    const [row] = await this.db.select().from(books)
      .where(and(eq(books.subjectId, subjectId), eq(books.grade, grade), eq(books.title, title)));
    return row;
  }
  /** Liệt kê sách, tuỳ chọn lọc theo môn. */
  async listBooks(subjectId?: string, kind?: string): Promise<BookRow[]> {
    const conds = [];
    if (subjectId) conds.push(eq(books.subjectId, subjectId));
    if (kind) conds.push(eq(books.kind, kind));
    const rows = conds.length ? await this.db.select().from(books).where(and(...conds)) : await this.db.select().from(books);
    return rows.sort((a, b) => (a.grade ?? 0) - (b.grade ?? 0) || a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime());
  }

  // --- cây sách ---------------------------------------------------------------

  /** Chèn node sách (chủ đề hoặc bài). */
  async insertBookNode(v: typeof bookNodes.$inferInsert, tx?: DbTx): Promise<BookNodeRow> {
    const [row] = await (tx ?? this.db).insert(bookNodes).values(v).returning(); return row!;
  }
  /** Lấy node sách theo id. */
  async getBookNode(id: string): Promise<BookNodeRow | undefined> {
    const [row] = await this.db.select().from(bookNodes).where(eq(bookNodes.id, id)); return row;
  }
  /** Toàn bộ node của một cuốn sách theo thứ tự cây (position, rồi thời gian tạo). */
  async listBookNodes(bookId: string): Promise<BookNodeRow[]> {
    return this.db.select().from(bookNodes).where(eq(bookNodes.bookId, bookId))
      .orderBy(asc(bookNodes.position), asc(bookNodes.createdAt));
  }
  /** Sửa node sách (đã lọc trường ở tầng service). */
  async updateBookNode(id: string, v: Partial<typeof bookNodes.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(bookNodes).set({ ...v, updatedAt: new Date() }).where(eq(bookNodes.id, id));
  }

  // --- ánh xạ -----------------------------------------------------------------

  /** Chèn một dòng ánh xạ bài → node chương trình hoặc → YCCĐ. */
  async insertMapping(v: typeof bookMappings.$inferInsert, tx?: DbTx): Promise<BookMappingRow> {
    const [row] = await (tx ?? this.db).insert(bookMappings).values(v).returning(); return row!;
  }
  /** Mọi dòng ánh xạ của một node bài. */
  async listMappingsForNode(bookNodeId: string): Promise<BookMappingRow[]> {
    return this.db.select().from(bookMappings).where(eq(bookMappings.bookNodeId, bookNodeId))
      .orderBy(asc(bookMappings.position), asc(bookMappings.createdAt));
  }
  /** Mọi dòng ánh xạ của nhiều node bài (cho cây sách/đơn vị khung). */
  async listMappingsForNodes(bookNodeIds: string[]): Promise<BookMappingRow[]> {
    if (bookNodeIds.length === 0) return [];
    return this.db.select().from(bookMappings).where(inArray(bookMappings.bookNodeId, bookNodeIds))
      .orderBy(asc(bookMappings.position), asc(bookMappings.createdAt));
  }
  /** Xoá toàn bộ ánh xạ của một node bài (thay mới khi dataset đính chính). */
  async deleteMappingsForNode(bookNodeId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).delete(bookMappings).where(eq(bookMappings.bookNodeId, bookNodeId));
  }

  // --- sổ đăng ký nạp -----------------------------------------------------------

  /** Tra sổ đăng ký theo cặp (dataset, mã bản ghi) — khoá idempotent của lượt nạp. */
  async getBookRecord(datasetKey: string, recordId: string): Promise<BookRecordRow | undefined> {
    const [row] = await this.db.select().from(bookRecords)
      .where(and(eq(bookRecords.datasetKey, datasetKey), eq(bookRecords.recordId, recordId)));
    return row;
  }
  /** Mọi dòng sổ của một dataset. */
  async listBookRecords(datasetKey: string): Promise<BookRecordRow[]> {
    return this.db.select().from(bookRecords).where(eq(bookRecords.datasetKey, datasetKey));
  }
  /** Mọi dòng sổ trỏ vào một cuốn sách (mọi dataset) — dựng mã bản ghi cho cây sách. */
  async listBookRecordsByBook(bookId: string): Promise<BookRecordRow[]> {
    return this.db.select().from(bookRecords).where(eq(bookRecords.bookId, bookId));
  }
  /** Ghi dòng sổ cho một bản ghi vừa nạp. */
  async insertBookRecord(v: typeof bookRecords.$inferInsert, tx?: DbTx): Promise<BookRecordRow> {
    const [row] = await (tx ?? this.db).insert(bookRecords).values(v).returning(); return row!;
  }
  /** Cập nhật dòng sổ khi dataset đính chính. */
  async updateBookRecord(id: string, v: Partial<typeof bookRecords.$inferInsert>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(bookRecords).set({ ...v, updatedAt: new Date() }).where(eq(bookRecords.id, id));
  }
}
