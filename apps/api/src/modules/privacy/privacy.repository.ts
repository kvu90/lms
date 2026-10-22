import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { privacyExportFiles, privacyRequests } from '../../db/schema';

export type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
export type ExportFileRow = typeof privacyExportFiles.$inferSelect;

/** Kho dữ liệu privacy_requests / privacy_export_files. */
@Injectable()
export class PrivacyRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertRequest(v: typeof privacyRequests.$inferInsert): Promise<PrivacyRequestRow> {
    const [row] = await this.db.insert(privacyRequests).values(v).returning(); return row!;
  }
  async getRequest(id: string): Promise<PrivacyRequestRow | undefined> {
    const [row] = await this.db.select().from(privacyRequests).where(eq(privacyRequests.id, id)); return row;
  }
  async listRequests(): Promise<PrivacyRequestRow[]> { return this.db.select().from(privacyRequests); }
  async listRequestsForUser(userid: string): Promise<PrivacyRequestRow[]> {
    return this.db.select().from(privacyRequests).where(eq(privacyRequests.userid, userid));
  }
  async updateRequest(id: string, v: Partial<typeof privacyRequests.$inferInsert>): Promise<void> {
    await this.db.update(privacyRequests).set({ ...v, timemodified: new Date() }).where(eq(privacyRequests.id, id));
  }
  async insertExportFile(v: typeof privacyExportFiles.$inferInsert): Promise<ExportFileRow> {
    const [row] = await this.db.insert(privacyExportFiles).values(v).returning(); return row!;
  }
  async listExportFiles(requestid: string): Promise<ExportFileRow[]> {
    return this.db.select().from(privacyExportFiles).where(eq(privacyExportFiles.requestid, requestid));
  }
}
