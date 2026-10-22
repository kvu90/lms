import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  competency, competencyCoursecomp, competencyEvidence, competencyFramework,
  competencyModulecomp, competencyPlancomp, competencyPlanReview, competencyTemplate,
  competencyTemplatecohort, competencyTemplatecomp, competencyUsercomp, learningPlans,
} from '../../db/schema';

export type FrameworkRow = typeof competencyFramework.$inferSelect;
export type CompetencyRow = typeof competency.$inferSelect;
export type TemplateRow = typeof competencyTemplate.$inferSelect;
export type PlanRow = typeof learningPlans.$inferSelect;
export type UsercompRow = typeof competencyUsercomp.$inferSelect;
export type EvidenceRow = typeof competencyEvidence.$inferSelect;
export type CourseLinkRow = typeof competencyCoursecomp.$inferSelect;
export type ModuleLinkRow = typeof competencyModulecomp.$inferSelect;
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
  async insertFramework(v: typeof competencyFramework.$inferInsert): Promise<FrameworkRow> {
    const [row] = await this.db.insert(competencyFramework).values(v).returning(); return row!;
  }
  /**
   * Lấy framework theo id.
   */
  async getFramework(id: number): Promise<FrameworkRow | undefined> {
    const [row] = await this.db.select().from(competencyFramework).where(eq(competencyFramework.id, id)); return row;
  }
  /**
   * Liệt kê framework.
   */
  async listFrameworks(): Promise<FrameworkRow[]> {
    return this.db.select().from(competencyFramework).orderBy(asc(competencyFramework.sortorder), asc(competencyFramework.id));
  }

  /**
   * Chèn competency.
   */
  async insertCompetency(v: typeof competency.$inferInsert): Promise<CompetencyRow> {
    const [row] = await this.db.insert(competency).values(v).returning(); return row!;
  }
  /**
   * Lấy competency theo id.
   */
  async getCompetency(id: number): Promise<CompetencyRow | undefined> {
    const [row] = await this.db.select().from(competency).where(eq(competency.id, id)); return row;
  }
  /**
   * Competency trong framework.
   */
  async listCompetencies(frameworkid: number): Promise<CompetencyRow[]> {
    return this.db.select().from(competency).where(eq(competency.frameworkid, frameworkid)).orderBy(asc(competency.path), asc(competency.sortorder));
  }
  /**
   * Cập nhật competency.
   */
  async updateCompetency(id: number, patch: Partial<CompetencyRow>): Promise<void> {
    await this.db.update(competency).set({ ...patch, timemodified: new Date() }).where(eq(competency.id, id));
  }

  /**
   * Liên kết competency với khoá học.
   */
  async insertCourseLink(v: typeof competencyCoursecomp.$inferInsert): Promise<CourseLinkRow> {
    const [row] = await this.db.insert(competencyCoursecomp).values(v)
      .onConflictDoUpdate({ target: [competencyCoursecomp.courseid, competencyCoursecomp.competencyid], set: { ruleoutcome: v.ruleoutcome } })
      .returning(); return row!;
  }
  /**
   * Liên kết của khoá học.
   */
  async listCourseLinks(courseid: number): Promise<CourseLinkRow[]> {
    return this.db.select().from(competencyCoursecomp).where(eq(competencyCoursecomp.courseid, courseid));
  }
  /**
   * Liên kết competency với course module.
   */
  async insertModuleLink(v: typeof competencyModulecomp.$inferInsert): Promise<ModuleLinkRow> {
    const [row] = await this.db.insert(competencyModulecomp).values(v)
      .onConflictDoUpdate({ target: [competencyModulecomp.coursemoduleid, competencyModulecomp.competencyid], set: { ruleoutcome: v.ruleoutcome } })
      .returning(); return row!;
  }
  /**
   * Liên kết của module.
   */
  async listModuleLinks(coursemoduleid: number): Promise<ModuleLinkRow[]> {
    return this.db.select().from(competencyModulecomp).where(eq(competencyModulecomp.coursemoduleid, coursemoduleid));
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
  async getTemplate(id: number): Promise<TemplateRow | undefined> {
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
  async addTemplateCompetency(templateid: number, competencyid: number): Promise<void> {
    await this.db.insert(competencyTemplatecomp).values({ templateid, competencyid }).onConflictDoNothing();
  }
  /**
   * Competency của template.
   */
  async listTemplateCompetencies(templateid: number): Promise<CompetencyRow[]> {
    const links = await this.db.select().from(competencyTemplatecomp).where(eq(competencyTemplatecomp.templateid, templateid)).orderBy(asc(competencyTemplatecomp.sortorder));
    const out: CompetencyRow[] = [];
    for (const link of links) {
      const c = await this.getCompetency(link.competencyid);
      if (c) out.push(c);
    }
    return out;
  }
  /**
   * Gắn cohort vào template (để sinh plan hàng loạt).
   */
  async addTemplateCohort(templateid: number, cohortid: number): Promise<void> {
    await this.db.insert(competencyTemplatecohort).values({ templateid, cohortid }).onConflictDoNothing();
  }
  /**
   * Cohort của template.
   */
  async listTemplateCohorts(templateid: number): Promise<number[]> {
    const rows = await this.db.select().from(competencyTemplatecohort).where(eq(competencyTemplatecohort.templateid, templateid));
    return rows.map((r) => r.cohortid);
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
  async getPlan(id: number): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(learningPlans).where(eq(learningPlans.id, id)); return row;
  }
  /**
   * Plan của user.
   */
  async listPlansForUser(userid: number): Promise<PlanRow[]> {
    return this.db.select().from(learningPlans).where(eq(learningPlans.userid, userid)).orderBy(asc(learningPlans.id));
  }
  /**
   * Plan đã sinh từ template cho user (chống trùng).
   */
  async findPlanFromTemplate(userid: number, templateid: number): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(learningPlans)
      .where(and(eq(learningPlans.userid, userid), eq(learningPlans.templateid, templateid)));
    return row;
  }
  /**
   * Cập nhật plan (trạng thái, reviewer…).
   */
  async updatePlan(id: number, patch: Partial<PlanRow>): Promise<void> {
    await this.db.update(learningPlans).set({ ...patch, timemodified: new Date() }).where(eq(learningPlans.id, id));
  }
  /**
   * Thêm competency vào plan.
   */
  async addPlanCompetency(planid: number, competencyid: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(competencyPlancomp).values({ planid, competencyid }).onConflictDoNothing();
  }
  /**
   * Competency id trong plan.
   */
  async listPlanCompetencyIds(planid: number): Promise<number[]> {
    const rows = await this.db.select().from(competencyPlancomp).where(eq(competencyPlancomp.planid, planid)).orderBy(asc(competencyPlancomp.sortorder));
    return rows.map((r) => r.competencyid);
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
  async listPlanReviews(planid: number) {
    return this.db.select().from(competencyPlanReview).where(eq(competencyPlanReview.planid, planid)).orderBy(asc(competencyPlanReview.id));
  }

  /**
   * Tìm bản ghi năng lực của user (usercomp) theo user + competency.
   */
  async findUsercomp(userid: number, competencyid: number, planid: number, courseid: number): Promise<UsercompRow | undefined> {
    const [row] = await this.db.select().from(competencyUsercomp).where(and(
      eq(competencyUsercomp.userid, userid), eq(competencyUsercomp.competencyid, competencyid),
      eq(competencyUsercomp.planid, planid), eq(competencyUsercomp.courseid, courseid),
    ));
    return row;
  }
  /**
   * Lấy usercomp theo id.
   */
  async getUsercomp(id: number): Promise<UsercompRow | undefined> {
    const [row] = await this.db.select().from(competencyUsercomp).where(eq(competencyUsercomp.id, id)); return row;
  }
  /**
   * Chèn usercomp.
   */
  async insertUsercomp(v: typeof competencyUsercomp.$inferInsert, tx?: DbTx): Promise<UsercompRow> {
    const [row] = await (tx ?? this.db).insert(competencyUsercomp).values(v).returning(); return row!;
  }
  /**
   * Cập nhật usercomp (proficiency, review status, grader).
   */
  async updateUsercomp(id: number, patch: Partial<UsercompRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(competencyUsercomp).set({ ...patch, timemodified: new Date() }).where(eq(competencyUsercomp.id, id));
  }
  /**
   * Usercomp thuộc các competency của plan.
   */
  async listUsercompsForPlan(planid: number, userid: number): Promise<UsercompRow[]> {
    return this.db.select().from(competencyUsercomp)
      .where(and(eq(competencyUsercomp.planid, planid), eq(competencyUsercomp.userid, userid)));
  }
  /**
   * Mọi usercomp của user.
   */
  async listUsercompsForUser(userid: number): Promise<UsercompRow[]> {
    return this.db.select().from(competencyUsercomp).where(eq(competencyUsercomp.userid, userid)).orderBy(asc(competencyUsercomp.id));
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
  async listEvidence(usercompetencyid: number): Promise<EvidenceRow[]> {
    return this.db.select().from(competencyEvidence).where(eq(competencyEvidence.usercompetencyid, usercompetencyid)).orderBy(asc(competencyEvidence.id));
  }
}
