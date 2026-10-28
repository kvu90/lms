import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { searchDocuments } from '../../db/schema';

export type SearchDocRow = typeof searchDocuments.$inferSelect;

/**
 * Kho tài liệu tìm kiếm Postgres: engine adapter thật dùng tsvector
 * (to_tsvector/plainto_tsquery) trên bảng search_documents.
 */
@Injectable()
export class SearchRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /** Upsert một tài liệu theo (area, itemId). */
  async upsert(v: typeof searchDocuments.$inferInsert): Promise<SearchDocRow> {
    const [row] = await this.db.insert(searchDocuments).values(v)
      .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemId], set: { title: v.title, content: v.content, contextId: v.contextId, ownerId: v.ownerId ?? null, updatedAt: new Date() } })
      .returning();
    return row!;
  }
  async remove(area: string, itemId: string): Promise<void> {
    await this.db.delete(searchDocuments).where(and(eq(searchDocuments.area, area), eq(searchDocuments.itemId, itemId)));
  }
  async removeByOwner(ownerId: string): Promise<void> {
    await this.db.delete(searchDocuments).where(eq(searchDocuments.ownerId, ownerId));
  }
  async get(area: string, itemId: string): Promise<SearchDocRow | undefined> {
    const [row] = await this.db.select().from(searchDocuments).where(and(eq(searchDocuments.area, area), eq(searchDocuments.itemId, itemId)));
    return row;
  }
  async listAll(): Promise<SearchDocRow[]> { return this.db.select().from(searchDocuments); }
  /** Truy vấn engine Postgres: khớp tsvector, không lọc quyền ở đây — việc lọc là của service tại thời điểm truy vấn. */
  async queryEngine(q: string): Promise<SearchDocRow[]> {
    if (!q.trim()) return [];
    const res = (await this.db.execute(sql`select id, area, item_id as "itemId", title, content, context_id as "contextId", owner_id as "ownerId", updated_at as "updatedAt" from search_documents where to_tsvector('simple', title || ' ' || content) @@ plainto_tsquery('simple', ${q}) order by id`)) as unknown as { rows: SearchDocRow[] };
    return res.rows;
  }

  /**
   * Kiểm tra một cặp (title, content) CHO TRƯỚC có khớp truy vấn hay
   * không, dùng đúng biểu thức tsvector của engine (`to_tsvector` trên
   * `title || ' ' || content` với `plainto_tsquery`, cùng cấu hình
   * 'simple'). Service dùng phép kiểm này để đối chiếu ứng viên với nội
   * dung công khai hiện hành của bản ghi gốc — không qua hàng đã lập chỉ
   * mục — nên kết luận khớp không phụ thuộc dữ liệu cũ còn sót trong
   * bảng `search_documents`.
   */
  async matchesContent(title: string, content: string, q: string): Promise<boolean> {
    if (!q.trim()) return false;
    const res = (await this.db.execute(sql`select (to_tsvector('simple', ${title} || ' ' || ${content}) @@ plainto_tsquery('simple', ${q})) as matched`)) as unknown as { rows: { matched: boolean }[] };
    return res.rows[0]?.matched === true;
  }
}
