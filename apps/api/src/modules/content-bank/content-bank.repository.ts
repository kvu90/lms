import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { contentBankContent } from '../../db/schema';

export type ContentRow = typeof contentBankContent.$inferSelect;

/** Kho dữ liệu content_bank_content. */
@Injectable()
export class ContentBankRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insert(v: typeof contentBankContent.$inferInsert): Promise<ContentRow> {
    const [row] = await this.db.insert(contentBankContent).values(v).returning(); return row!;
  }
  async get(id: string): Promise<ContentRow | undefined> {
    const [row] = await this.db.select().from(contentBankContent).where(eq(contentBankContent.id, id)); return row;
  }
  async list(): Promise<ContentRow[]> { return this.db.select().from(contentBankContent); }
  async listByContext(contextId: string): Promise<ContentRow[]> {
    return this.db.select().from(contentBankContent).where(eq(contentBankContent.contextId, contextId));
  }
  async update(id: string, v: Partial<typeof contentBankContent.$inferInsert>): Promise<void> {
    await this.db.update(contentBankContent).set({ ...v, updatedAt: new Date() }).where(eq(contentBankContent.id, id));
  }
  async remove(id: string): Promise<void> { await this.db.delete(contentBankContent).where(eq(contentBankContent.id, id)); }
}
