import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { cohort, cohortMembers, contentBankContent } from '../../db/schema';

export type ContentRow = typeof contentBankContent.$inferSelect;
export type CohortRow = typeof cohort.$inferSelect;

export interface ContentFilters {
  scope?: string;
  spaceId?: string;
  creatorId?: string;
  subjectId?: string;
  grade?: number;
  level?: string;
  curriculumNodeId?: string;
  resourceType?: string;
  reviewStatus?: string;
}

/** Kho dữ liệu content_bank_content + truy vấn cohort (tổ chuyên môn) phục vụ scope org của Kho học liệu. */
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
  /** Liệt kê theo bộ lọc của Kho học liệu (scope/metadata/trạng thái duyệt), mới nhất trước. Việc gác quyền xem nằm ở service. */
  async listFiltered(f: ContentFilters): Promise<ContentRow[]> {
    const conds = [];
    if (f.scope) conds.push(eq(contentBankContent.scope, f.scope));
    if (f.spaceId) conds.push(eq(contentBankContent.spaceId, f.spaceId));
    if (f.creatorId) conds.push(eq(contentBankContent.creatorId, f.creatorId));
    if (f.subjectId) conds.push(eq(contentBankContent.subjectId, f.subjectId));
    if (f.grade) conds.push(eq(contentBankContent.grade, f.grade));
    if (f.level) conds.push(eq(contentBankContent.level, f.level));
    if (f.curriculumNodeId) conds.push(eq(contentBankContent.curriculumNodeId, f.curriculumNodeId));
    if (f.resourceType) conds.push(eq(contentBankContent.resourceType, f.resourceType));
    if (f.reviewStatus) conds.push(eq(contentBankContent.reviewStatus, f.reviewStatus));
    const q = this.db.select().from(contentBankContent);
    return (conds.length ? q.where(and(...conds)) : q).orderBy(desc(contentBankContent.updatedAt));
  }
  async update(id: string, v: Partial<typeof contentBankContent.$inferInsert>): Promise<void> {
    await this.db.update(contentBankContent).set({ ...v, updatedAt: new Date() }).where(eq(contentBankContent.id, id));
  }
  async remove(id: string): Promise<void> { await this.db.delete(contentBankContent).where(eq(contentBankContent.id, id)); }

  // --- cohort (tổ chuyên môn) -------------------------------------------------
  async getCohort(id: string): Promise<CohortRow | undefined> {
    const [row] = await this.db.select().from(cohort).where(eq(cohort.id, id)); return row;
  }
  async listAllCohorts(): Promise<CohortRow[]> { return this.db.select().from(cohort); }
  async listCohortsForUser(userId: string): Promise<CohortRow[]> {
    return this.db.select({ cohort }).from(cohortMembers)
      .innerJoin(cohort, eq(cohortMembers.cohortId, cohort.id))
      .where(eq(cohortMembers.userId, userId))
      .then((rows) => rows.map((r) => r.cohort));
  }
  async isCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select().from(cohortMembers)
      .where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId)));
    return !!row;
  }
}
