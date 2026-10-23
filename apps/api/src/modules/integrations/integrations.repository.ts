import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { externalServices, externalTokens } from '../../db/schema';

export type ServiceRow = typeof externalServices.$inferSelect;
export type TokenRow = typeof externalTokens.$inferSelect;

/** Kho dữ liệu external_services / external_tokens. */
@Injectable()
export class IntegrationsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertService(v: typeof externalServices.$inferInsert): Promise<ServiceRow> {
    const [row] = await this.db.insert(externalServices).values(v).returning(); return row!;
  }
  async getService(id: string): Promise<ServiceRow | undefined> {
    const [row] = await this.db.select().from(externalServices).where(eq(externalServices.id, id)); return row;
  }
  async listServices(): Promise<ServiceRow[]> { return this.db.select().from(externalServices); }
  async updateService(id: string, v: Partial<typeof externalServices.$inferInsert>): Promise<void> {
    await this.db.update(externalServices).set(v).where(eq(externalServices.id, id));
  }
  async insertToken(v: typeof externalTokens.$inferInsert): Promise<TokenRow> {
    const [row] = await this.db.insert(externalTokens).values(v).returning(); return row!;
  }
  async getTokenByHash(tokenHash: string): Promise<TokenRow | undefined> {
    const [row] = await this.db.select().from(externalTokens).where(eq(externalTokens.tokenHash, tokenHash)); return row;
  }
  async getToken(id: string): Promise<TokenRow | undefined> {
    const [row] = await this.db.select().from(externalTokens).where(eq(externalTokens.id, id)); return row;
  }
  async listTokens(): Promise<TokenRow[]> { return this.db.select().from(externalTokens); }
  async updateToken(id: string, v: Partial<typeof externalTokens.$inferInsert>): Promise<void> {
    await this.db.update(externalTokens).set(v).where(eq(externalTokens.id, id));
  }
}
