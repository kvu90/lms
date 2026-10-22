import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { reportbuilderAudience, reportbuilderReport, reportbuilderSchedule } from '../../db/schema';

export type ReportRow = typeof reportbuilderReport.$inferSelect;
export type AudienceRow = typeof reportbuilderAudience.$inferSelect;
export type ScheduleRow = typeof reportbuilderSchedule.$inferSelect;

/** Kho dữ liệu reportbuilder_*. */
@Injectable()
export class ReportsRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertReport(v: typeof reportbuilderReport.$inferInsert): Promise<ReportRow> {
    const [row] = await this.db.insert(reportbuilderReport).values(v).returning(); return row!;
  }
  async getReport(id: number): Promise<ReportRow | undefined> {
    const [row] = await this.db.select().from(reportbuilderReport).where(eq(reportbuilderReport.id, id)); return row;
  }
  async listReports(): Promise<ReportRow[]> { return this.db.select().from(reportbuilderReport); }
  async insertAudience(v: typeof reportbuilderAudience.$inferInsert): Promise<AudienceRow> {
    const [row] = await this.db.insert(reportbuilderAudience).values(v).returning(); return row!;
  }
  async listAudience(reportid: number): Promise<AudienceRow[]> {
    return this.db.select().from(reportbuilderAudience).where(eq(reportbuilderAudience.reportid, reportid));
  }
  async insertSchedule(v: typeof reportbuilderSchedule.$inferInsert): Promise<ScheduleRow> {
    const [row] = await this.db.insert(reportbuilderSchedule).values(v).returning(); return row!;
  }
  async getSchedule(id: number): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.select().from(reportbuilderSchedule).where(eq(reportbuilderSchedule.id, id)); return row;
  }
  async listSchedules(): Promise<ScheduleRow[]> { return this.db.select().from(reportbuilderSchedule); }
  async updateSchedule(id: number, v: Partial<typeof reportbuilderSchedule.$inferInsert>): Promise<void> {
    await this.db.update(reportbuilderSchedule).set(v).where(eq(reportbuilderSchedule.id, id));
  }
}
