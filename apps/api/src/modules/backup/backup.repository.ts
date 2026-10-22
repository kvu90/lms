import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { backupIdMappings, backupJobSteps, backupJobs } from '../../db/schema';

export type JobRow = typeof backupJobs.$inferSelect;
export type StepRow = typeof backupJobSteps.$inferSelect;
export type MappingRow = typeof backupIdMappings.$inferSelect;

/** Kho dữ liệu backup_jobs / backup_job_steps / backup_id_mappings. */
@Injectable()
export class BackupRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }
  async insertJob(v: typeof backupJobs.$inferInsert): Promise<JobRow> {
    const [row] = await this.db.insert(backupJobs).values(v).returning(); return row!;
  }
  async getJob(id: string): Promise<JobRow | undefined> {
    const [row] = await this.db.select().from(backupJobs).where(eq(backupJobs.id, id)); return row;
  }
  async listJobs(): Promise<JobRow[]> { return this.db.select().from(backupJobs); }
  async updateJob(id: string, v: Partial<typeof backupJobs.$inferInsert>): Promise<void> {
    await this.db.update(backupJobs).set(v).where(eq(backupJobs.id, id));
  }
  async insertStep(v: typeof backupJobSteps.$inferInsert): Promise<StepRow> {
    const [row] = await this.db.insert(backupJobSteps).values(v).returning(); return row!;
  }
  async listSteps(jobid: string): Promise<StepRow[]> {
    return this.db.select().from(backupJobSteps).where(eq(backupJobSteps.jobid, jobid));
  }
  async updateStep(id: string, v: Partial<typeof backupJobSteps.$inferInsert>): Promise<void> {
    await this.db.update(backupJobSteps).set(v).where(eq(backupJobSteps.id, id));
  }
  async insertMapping(v: typeof backupIdMappings.$inferInsert): Promise<MappingRow> {
    const [row] = await this.db.insert(backupIdMappings).values(v)
      .onConflictDoUpdate({ target: [backupIdMappings.jobid, backupIdMappings.itemtype, backupIdMappings.oldid], set: { newid: v.newid } })
      .returning();
    return row!;
  }
  async listMappings(jobid: string): Promise<MappingRow[]> {
    return this.db.select().from(backupIdMappings).where(eq(backupIdMappings.jobid, jobid));
  }
  async getMapping(jobid: string, itemtype: string, oldid: string): Promise<MappingRow | undefined> {
    const [row] = await this.db.select().from(backupIdMappings)
      .where(and(eq(backupIdMappings.jobid, jobid), eq(backupIdMappings.itemtype, itemtype), eq(backupIdMappings.oldid, oldid)));
    return row;
  }
}
