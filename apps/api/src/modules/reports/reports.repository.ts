import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { reportBuilderAudience, reportBuilderReport, reportBuilderSchedule } from '../../db/schema';

export type ReportRow = typeof reportBuilderReport.$inferSelect;
export type AudienceRow = typeof reportBuilderAudience.$inferSelect;
export type ScheduleRow = typeof reportBuilderSchedule.$inferSelect;

/** Kho dữ liệu reportbuilder_*. */
@Injectable()
export class ReportsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertReport(v: typeof reportBuilderReport.$inferInsert): Promise<ReportRow> {
    const [row] = await this.db.insert(reportBuilderReport).values(v).returning(); return row!;
  }
  async getReport(id: string): Promise<ReportRow | undefined> {
    const [row] = await this.db.select().from(reportBuilderReport).where(eq(reportBuilderReport.id, id)); return row;
  }
  async listReports(): Promise<ReportRow[]> { return this.db.select().from(reportBuilderReport); }
  async insertAudience(v: typeof reportBuilderAudience.$inferInsert): Promise<AudienceRow> {
    const [row] = await this.db.insert(reportBuilderAudience).values(v).returning(); return row!;
  }
  async listAudience(reportId: string): Promise<AudienceRow[]> {
    return this.db.select().from(reportBuilderAudience).where(eq(reportBuilderAudience.reportId, reportId));
  }
  async insertSchedule(v: typeof reportBuilderSchedule.$inferInsert): Promise<ScheduleRow> {
    const [row] = await this.db.insert(reportBuilderSchedule).values(v).returning(); return row!;
  }
  async getSchedule(id: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.select().from(reportBuilderSchedule).where(eq(reportBuilderSchedule.id, id)); return row;
  }
  async listSchedules(): Promise<ScheduleRow[]> { return this.db.select().from(reportBuilderSchedule); }
  async updateSchedule(id: string, v: Partial<typeof reportBuilderSchedule.$inferInsert>): Promise<void> {
    await this.db.update(reportBuilderSchedule).set(v).where(eq(reportBuilderSchedule.id, id));
  }
}
