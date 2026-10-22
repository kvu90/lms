import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { contentbankContent } from '../../db/schema';

export type ContentRow = typeof contentbankContent.$inferSelect;

/** Kho dữ liệu contentbank_content. */
@Injectable()
export class ContentBankRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insert(v: typeof contentbankContent.$inferInsert): Promise<ContentRow> {
    const [row] = await this.db.insert(contentbankContent).values(v).returning(); return row!;
  }
  async get(id: number): Promise<ContentRow | undefined> {
    const [row] = await this.db.select().from(contentbankContent).where(eq(contentbankContent.id, id)); return row;
  }
  async list(): Promise<ContentRow[]> { return this.db.select().from(contentbankContent); }
  async listByContext(contextid: number): Promise<ContentRow[]> {
    return this.db.select().from(contentbankContent).where(eq(contentbankContent.contextid, contextid));
  }
  async update(id: number, v: Partial<typeof contentbankContent.$inferInsert>): Promise<void> {
    await this.db.update(contentbankContent).set({ ...v, timemodified: new Date() }).where(eq(contentbankContent.id, id));
  }
  async remove(id: number): Promise<void> { await this.db.delete(contentbankContent).where(eq(contentbankContent.id, id)); }
}
