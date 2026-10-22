import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { files } from '../../db/schema';

export type FileRow = typeof files.$inferSelect;

@Injectable()
/**
 * Kho dữ liệu metadata file (bảng files kiểu Moodle): mỗi bản ghi là một file tại (context, component, filearea, itemid, filepath, filename).
 * Nội dung vật lý được deduplicate theo contenthash; refcount suy ra từ số bản ghi cùng hash.
 */
export class FilesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  /**
   * Chèn bản ghi file mới.
   */
  async insert(v: typeof files.$inferInsert): Promise<FileRow> {
    const [row] = await this.db.insert(files).values(v).returning(); return row!;
  }
  /**
   * Lấy bản ghi theo id.
   */
  async getById(id: number): Promise<FileRow | undefined> {
    const [row] = await this.db.select().from(files).where(eq(files.id, id)); return row;
  }
  /**
   * Xoá bản ghi theo id.
   */
  async deleteById(id: number): Promise<void> { await this.db.delete(files).where(eq(files.id, id)); }
  /** Refcount = number of logical records pointing at a contenthash (Moodle semantics: physical lives while refcount > 0). */
  /**
   * Đếm bản ghi cùng contenthash (refcount nội dung vật lý).
   */
  async countByHash(contenthash: string): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(files).where(eq(files.contenthash, contenthash));
    return row?.n ?? 0;
  }
  /**
   * Liệt kê file trong một context.
   */
  async listByContext(contextid: number): Promise<FileRow[]> {
    return this.db.select().from(files).where(eq(files.contextid, contextid)).orderBy(files.id);
  }
}
