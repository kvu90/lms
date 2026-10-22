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

  /** Upsert một tài liệu theo (area, itemid). */
  async upsert(v: typeof searchDocuments.$inferInsert): Promise<SearchDocRow> {
    const [row] = await this.db.insert(searchDocuments).values(v)
      .onConflictDoUpdate({ target: [searchDocuments.area, searchDocuments.itemid], set: { title: v.title, content: v.content, contextid: v.contextid, ownerid: v.ownerid ?? null, timemodified: new Date() } })
      .returning();
    return row!;
  }
  async remove(area: string, itemid: number): Promise<void> {
    await this.db.delete(searchDocuments).where(and(eq(searchDocuments.area, area), eq(searchDocuments.itemid, itemid)));
  }
  async removeByOwner(ownerid: number): Promise<void> {
    await this.db.delete(searchDocuments).where(eq(searchDocuments.ownerid, ownerid));
  }
  async get(area: string, itemid: number): Promise<SearchDocRow | undefined> {
    const [row] = await this.db.select().from(searchDocuments).where(and(eq(searchDocuments.area, area), eq(searchDocuments.itemid, itemid)));
    return row;
  }
  async listAll(): Promise<SearchDocRow[]> { return this.db.select().from(searchDocuments); }
  /** Truy vấn engine Postgres: khớp tsvector, không lọc quyền ở đây — việc lọc là của service tại thời điểm truy vấn. */
  async queryEngine(q: string): Promise<SearchDocRow[]> {
    if (!q.trim()) return [];
    const res = (await this.db.execute(sql`select * from search_documents where to_tsvector('simple', title || ' ' || content) @@ plainto_tsquery('simple', ${q}) order by id`)) as unknown as { rows: SearchDocRow[] };
    return res.rows;
  }
}
