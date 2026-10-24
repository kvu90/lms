import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { questionImportBatches, questionImportItems } from './schema';

export type ImportBatchRow = typeof questionImportBatches.$inferSelect;
export type ImportItemRow = typeof questionImportItems.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu Question Import: đợt nhập + các mục chờ duyệt. Mọi truy vấn
 * đều theo batch/ordinal tường minh để màn hình duyệt hiển thị đúng thứ
 * tự câu trong file gốc.
 */
export class QuestionImportRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /** Chèn đợt nhập. */
  async insertBatch(v: typeof questionImportBatches.$inferInsert, tx?: DbTx): Promise<ImportBatchRow> {
    const [row] = await (tx ?? this.db).insert(questionImportBatches).values(v).returning();
    return row!;
  }
  /** Lấy đợt nhập theo id. */
  async getBatch(id: string): Promise<ImportBatchRow | undefined> {
    const [row] = await this.db.select().from(questionImportBatches).where(eq(questionImportBatches.id, id));
    return row;
  }
  /** Các đợt nhập của một người tải lên, mới nhất trước. */
  async listBatchesByUploader(uploadedBy: string, limit = 100): Promise<ImportBatchRow[]> {
    return this.db.select().from(questionImportBatches)
      .where(eq(questionImportBatches.uploadedBy, uploadedBy))
      .orderBy(desc(questionImportBatches.createdAt)).limit(limit);
  }
  /** Mọi đợt nhập (cho quản trị viên hệ thống), mới nhất trước. */
  async listAllBatches(limit = 100): Promise<ImportBatchRow[]> {
    return this.db.select().from(questionImportBatches)
      .orderBy(desc(questionImportBatches.createdAt)).limit(limit);
  }
  /** Sửa đợt nhập (đã lọc trường ở tầng service). */
  async updateBatch(id: string, v: Partial<typeof questionImportBatches.$inferInsert>): Promise<void> {
    await this.db.update(questionImportBatches).set({ ...v, updatedAt: new Date() }).where(eq(questionImportBatches.id, id));
  }

  /** Chèn mục chờ duyệt. */
  async insertItem(v: typeof questionImportItems.$inferInsert, tx?: DbTx): Promise<ImportItemRow> {
    const [row] = await (tx ?? this.db).insert(questionImportItems).values(v).returning();
    return row!;
  }
  /** Lấy mục chờ duyệt theo id. */
  async getItem(id: string): Promise<ImportItemRow | undefined> {
    const [row] = await this.db.select().from(questionImportItems).where(eq(questionImportItems.id, id));
    return row;
  }
  /** Các mục của một đợt, theo thứ tự trong file. */
  async listItems(batchId: string): Promise<ImportItemRow[]> {
    return this.db.select().from(questionImportItems)
      .where(eq(questionImportItems.batchId, batchId))
      .orderBy(asc(questionImportItems.ordinal), asc(questionImportItems.createdAt));
  }
  /** Sửa mục chờ duyệt (đã lọc trường ở tầng service). */
  async updateItem(id: string, v: Partial<typeof questionImportItems.$inferInsert>): Promise<void> {
    await this.db.update(questionImportItems).set({ ...v, updatedAt: new Date() }).where(eq(questionImportItems.id, id));
  }
  /** Đếm mục theo trạng thái cho nhiều đợt cùng lúc (phục vụ danh sách đợt). */
  async countItemsByStatus(batchIds: string[]): Promise<Map<string, { pending: number; approved: number; rejected: number }>> {
    const out = new Map<string, { pending: number; approved: number; rejected: number }>();
    if (batchIds.length === 0) return out;
    const rows = await this.db.select({
      batchId: questionImportItems.batchId,
      status: questionImportItems.status,
      count: sql<number>`count(*)::int`,
    }).from(questionImportItems)
      .where(inArray(questionImportItems.batchId, batchIds))
      .groupBy(questionImportItems.batchId, questionImportItems.status);
    for (const row of rows) {
      const entry = out.get(row.batchId) ?? { pending: 0, approved: 0, rejected: 0 };
      if (row.status === 'pending' || row.status === 'approved' || row.status === 'rejected') {
        entry[row.status] = row.count;
      }
      out.set(row.batchId, entry);
    }
    return out;
  }
  /** Còn mục nào đang chờ duyệt trong đợt không. */
  async countPendingItems(batchId: string): Promise<number> {
    const rows = await this.db.select({ count: sql<number>`count(*)::int` }).from(questionImportItems)
      .where(and(eq(questionImportItems.batchId, batchId), eq(questionImportItems.status, 'pending')));
    return rows[0]?.count ?? 0;
  }
}
