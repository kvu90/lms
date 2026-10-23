import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  competency, competencyCourseComp, competencyEvidence, competencyFramework,
  competencyModuleComp, competencyPlanComp, competencyPlanReview, competencyTemplate,
  competencyTemplateCohort, competencyTemplateComp, competencyUserComp, learningPlans,
} from '../../db/schema';

export type FrameworkRow = typeof competencyFramework.$inferSelect;
export type CompetencyRow = typeof competency.$inferSelect;
export type TemplateRow = typeof competencyTemplate.$inferSelect;
export type PlanRow = typeof learningPlans.$inferSelect;
export type UsercompRow = typeof competencyUserComp.$inferSelect;
export type EvidenceRow = typeof competencyEvidence.$inferSelect;
export type CourseLinkRow = typeof competencyCourseComp.$inferSelect;
export type ModuleLinkRow = typeof competencyModuleComp.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu năng lực: framework, competency (cây), liên kết course/module, template, plan, user competency, evidence và review.
 */
export class CompetenciesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn framework năng lực.
   */
  async insertFramework(v: typeof competencyFramework.$inferInsert, tx?: DbTx): Promise<FrameworkRow> {
    const [row] = await (tx ?? this.db).insert(competencyFramework).values(v).returning(); return row!;
  }
  /**
   * Lấy framework theo id.
   */
  async getFramework(id: string): Promise<FrameworkRow | undefined> {
    const [row] = await this.db.select().from(competencyFramework).where(eq(competencyFramework.id, id)); return row;
  }
  /**
   * Liệt kê framework.
   */
  async listFrameworks(): Promise<FrameworkRow[]> {
    return this.db.select().from(competencyFramework).orderBy(asc(competencyFramework.sortOrder), asc(competencyFramework.id));
  }

  /**
   * Chèn competency.
   */
  async insertCompetency(v: typeof competency.$inferInsert, tx?: DbTx): Promise<CompetencyRow> {
    const [row] = await (tx ?? this.db).insert(competency).values(v).returning(); return row!;
  }
  /**
   * Các competency con TRỰC TIẾP của một competency (dùng để kiểm tra rule points).
   */
  async listChildren(parentId: string): Promise<CompetencyRow[]> {
    return this.db.select().from(competency).where(eq(competency.parentId, parentId)).orderBy(asc(competency.sortOrder), asc(competency.id));
  }
  /**
   * Lấy competency theo id.
   */
  async getCompetency(id: string): Promise<CompetencyRow | undefined> {
    const [row] = await this.db.select().from(competency).where(eq(competency.id, id)); return row;
  }
  /**
   * Competency trong framework.
   */
  async listCompetencies(frameworkId: string): Promise<CompetencyRow[]> {
    return this.db.select().from(competency).where(eq(competency.frameworkId, frameworkId)).orderBy(asc(competency.path), asc(competency.sortOrder));
  }
  /**
   * Cập nhật competency.
   */
  async updateCompetency(id: string, patch: Partial<CompetencyRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(competency).set({ ...patch, updatedAt: new Date() }).where(eq(competency.id, id));
  }

  /**
   * Liên kết competency với khoá học.
   */
  async insertCourseLink(v: typeof competencyCourseComp.$inferInsert): Promise<CourseLinkRow> {
    const [row] = await this.db.insert(competencyCourseComp).values(v)
      .onConflictDoUpdate({ target: [competencyCourseComp.courseId, competencyCourseComp.competencyId], set: { ruleOutcome: v.ruleOutcome } })
      .returning(); return row!;
  }
  /**
   * Liên kết của khoá học.
   */
  async listCourseLinks(courseId: string): Promise<CourseLinkRow[]> {
    return this.db.select().from(competencyCourseComp).where(eq(competencyCourseComp.courseId, courseId));
  }
  /**
   * Liên kết competency với course module.
   */
  async insertModuleLink(v: typeof competencyModuleComp.$inferInsert): Promise<ModuleLinkRow> {
    const [row] = await this.db.insert(competencyModuleComp).values(v)
      .onConflictDoUpdate({ target: [competencyModuleComp.courseModuleId, competencyModuleComp.competencyId], set: { ruleOutcome: v.ruleOutcome } })
      .returning(); return row!;
  }
  /**
   * Liên kết của module.
   */
  async listModuleLinks(courseModuleId: string): Promise<ModuleLinkRow[]> {
    return this.db.select().from(competencyModuleComp).where(eq(competencyModuleComp.courseModuleId, courseModuleId));
  }

  /**
   * Chèn template kế hoạch học tập.
   */
  async insertTemplate(v: typeof competencyTemplate.$inferInsert): Promise<TemplateRow> {
    const [row] = await this.db.insert(competencyTemplate).values(v).returning(); return row!;
  }
  /**
   * Lấy template theo id.
   */
  async getTemplate(id: string): Promise<TemplateRow | undefined> {
    const [row] = await this.db.select().from(competencyTemplate).where(eq(competencyTemplate.id, id)); return row;
  }
  /**
   * Liệt kê template.
   */
  async listTemplates(): Promise<TemplateRow[]> {
    return this.db.select().from(competencyTemplate).orderBy(asc(competencyTemplate.id));
  }
  /**
   * Thêm competency vào template.
   */
  async addTemplateCompetency(templateId: string, competencyId: string): Promise<void> {
    await this.db.insert(competencyTemplateComp).values({ templateId, competencyId }).onConflictDoNothing();
  }
  /**
   * Competency của template.
   */
  async listTemplateCompetencies(templateId: string): Promise<CompetencyRow[]> {
    const links = await this.db.select().from(competencyTemplateComp).where(eq(competencyTemplateComp.templateId, templateId)).orderBy(asc(competencyTemplateComp.sortOrder));
    const out: CompetencyRow[] = [];
    for (const link of links) {
      const c = await this.getCompetency(link.competencyId);
      if (c) out.push(c);
    }
    return out;
  }
  /**
   * Gắn cohort vào template (để sinh plan hàng loạt).
   */
  async addTemplateCohort(templateId: string, cohortId: string): Promise<void> {
    await this.db.insert(competencyTemplateCohort).values({ templateId, cohortId }).onConflictDoNothing();
  }
  /**
   * Cohort của template.
   */
  async listTemplateCohorts(templateId: string): Promise<string[]> {
    const rows = await this.db.select().from(competencyTemplateCohort).where(eq(competencyTemplateCohort.templateId, templateId));
    return rows.map((r) => r.cohortId);
  }

  /**
   * Chèn learning plan.
   */
  async insertPlan(v: typeof learningPlans.$inferInsert, tx?: DbTx): Promise<PlanRow> {
    const [row] = await (tx ?? this.db).insert(learningPlans).values(v).returning(); return row!;
  }
  /**
   * Lấy plan theo id.
   */
  async getPlan(id: string): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(learningPlans).where(eq(learningPlans.id, id)); return row;
  }
  /**
   * Plan của user.
   */
  async listPlansForUser(userId: string): Promise<PlanRow[]> {
    return this.db.select().from(learningPlans).where(eq(learningPlans.userId, userId)).orderBy(asc(learningPlans.id));
  }
  /**
   * Plan đã sinh từ template cho user (chống trùng).
   */
  async findPlanFromTemplate(userId: string, templateId: string): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(learningPlans)
      .where(and(eq(learningPlans.userId, userId), eq(learningPlans.templateId, templateId)));
    return row;
  }
  /**
   * Cập nhật plan (trạng thái, reviewer…).
   */
  async updatePlan(id: string, patch: Partial<PlanRow>): Promise<void> {
    await this.db.update(learningPlans).set({ ...patch, updatedAt: new Date() }).where(eq(learningPlans.id, id));
  }
  /**
   * Thêm competency vào plan.
   */
  async addPlanCompetency(planId: string, competencyId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(competencyPlanComp).values({ planId, competencyId }).onConflictDoNothing();
  }
  /**
   * Competency id trong plan.
   */
  async listPlanCompetencyIds(planId: string): Promise<string[]> {
    const rows = await this.db.select().from(competencyPlanComp).where(eq(competencyPlanComp.planId, planId)).orderBy(asc(competencyPlanComp.sortOrder));
    return rows.map((r) => r.competencyId);
  }
  /**
   * Ghi một vòng review của plan.
   */
  async insertPlanReview(v: typeof competencyPlanReview.$inferInsert): Promise<void> {
    await this.db.insert(competencyPlanReview).values(v);
  }
  /**
   * Các vòng review của plan.
   */
  async listPlanReviews(planId: string) {
    return this.db.select().from(competencyPlanReview).where(eq(competencyPlanReview.planId, planId)).orderBy(asc(competencyPlanReview.id));
  }

  /**
   * Tìm bản ghi năng lực của user (usercomp) theo user + competency.
   */
  async findUsercomp(userId: string, competencyId: string, planId: string | null, courseId: string | null): Promise<UsercompRow | undefined> {
    const [row] = await this.db.select().from(competencyUserComp).where(and(
      eq(competencyUserComp.userId, userId), eq(competencyUserComp.competencyId, competencyId),
      planId === null ? isNull(competencyUserComp.planId) : eq(competencyUserComp.planId, planId),
      courseId === null ? isNull(competencyUserComp.courseId) : eq(competencyUserComp.courseId, courseId),
    ));
    return row;
  }
  /**
   * Lấy usercomp theo id.
   */
  async getUsercomp(id: string): Promise<UsercompRow | undefined> {
    const [row] = await this.db.select().from(competencyUserComp).where(eq(competencyUserComp.id, id)); return row;
  }
  /**
   * Chèn usercomp.
   */
  async insertUsercomp(v: typeof competencyUserComp.$inferInsert, tx?: DbTx): Promise<UsercompRow> {
    const [row] = await (tx ?? this.db).insert(competencyUserComp).values(v).returning(); return row!;
  }
  /**
   * Cập nhật usercomp (proficiency, review status, grader).
   */
  async updateUsercomp(id: string, patch: Partial<UsercompRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(competencyUserComp).set({ ...patch, updatedAt: new Date() }).where(eq(competencyUserComp.id, id));
  }
  /**
   * Usercomp thuộc các competency của plan.
   */
  async listUsercompsForPlan(planId: string, userId: string): Promise<UsercompRow[]> {
    return this.db.select().from(competencyUserComp)
      .where(and(eq(competencyUserComp.planId, planId), eq(competencyUserComp.userId, userId)));
  }
  /**
   * Mọi usercomp của user.
   */
  async listUsercompsForUser(userId: string): Promise<UsercompRow[]> {
    return this.db.select().from(competencyUserComp).where(eq(competencyUserComp.userId, userId)).orderBy(asc(competencyUserComp.id));
  }

  /**
   * Ghi một bằng chứng (evidence) cho usercomp.
   */
  async insertEvidence(v: typeof competencyEvidence.$inferInsert, tx?: DbTx): Promise<EvidenceRow> {
    const [row] = await (tx ?? this.db).insert(competencyEvidence).values(v).returning(); return row!;
  }
  /**
   * Bằng chứng của usercomp.
   */
  async listEvidence(userCompetencyId: string): Promise<EvidenceRow[]> {
    return this.db.select().from(competencyEvidence).where(eq(competencyEvidence.userCompetencyId, userCompetencyId)).orderBy(asc(competencyEvidence.id));
  }
}
