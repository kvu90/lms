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
export class CompetenciesRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async insertFramework(v: typeof competencyFramework.$inferInsert): Promise<FrameworkRow> {
    const [row] = await this.db.insert(competencyFramework).values(v).returning(); return row!;
  }
  async getFramework(id: number): Promise<FrameworkRow | undefined> {
    const [row] = await this.db.select().from(competencyFramework).where(eq(competencyFramework.id, id)); return row;
  }
  async listFrameworks(): Promise<FrameworkRow[]> {
    return this.db.select().from(competencyFramework).orderBy(asc(competencyFramework.sortorder), asc(competencyFramework.id));
  }

  async insertCompetency(v: typeof competency.$inferInsert): Promise<CompetencyRow> {
    const [row] = await this.db.insert(competency).values(v).returning(); return row!;
  }
  async getCompetency(id: number): Promise<CompetencyRow | undefined> {
    const [row] = await this.db.select().from(competency).where(eq(competency.id, id)); return row;
  }
  async listCompetencies(frameworkid: number): Promise<CompetencyRow[]> {
    return this.db.select().from(competency).where(eq(competency.frameworkid, frameworkid)).orderBy(asc(competency.path), asc(competency.sortorder));
  }
  async updateCompetency(id: number, patch: Partial<CompetencyRow>): Promise<void> {
    await this.db.update(competency).set({ ...patch, timemodified: new Date() }).where(eq(competency.id, id));
  }

  async insertCourseLink(v: typeof competencyCoursecomp.$inferInsert): Promise<CourseLinkRow> {
    const [row] = await this.db.insert(competencyCoursecomp).values(v)
      .onConflictDoUpdate({ target: [competencyCoursecomp.courseid, competencyCoursecomp.competencyid], set: { ruleoutcome: v.ruleoutcome } })
      .returning(); return row!;
  }
  async listCourseLinks(courseid: number): Promise<CourseLinkRow[]> {
    return this.db.select().from(competencyCoursecomp).where(eq(competencyCoursecomp.courseid, courseid));
  }
  async insertModuleLink(v: typeof competencyModulecomp.$inferInsert): Promise<ModuleLinkRow> {
    const [row] = await this.db.insert(competencyModulecomp).values(v)
      .onConflictDoUpdate({ target: [competencyModulecomp.coursemoduleid, competencyModulecomp.competencyid], set: { ruleoutcome: v.ruleoutcome } })
      .returning(); return row!;
  }
  async listModuleLinks(coursemoduleid: number): Promise<ModuleLinkRow[]> {
    return this.db.select().from(competencyModulecomp).where(eq(competencyModulecomp.coursemoduleid, coursemoduleid));
  }

  async insertTemplate(v: typeof competencyTemplate.$inferInsert): Promise<TemplateRow> {
    const [row] = await this.db.insert(competencyTemplate).values(v).returning(); return row!;
  }
  async getTemplate(id: number): Promise<TemplateRow | undefined> {
    const [row] = await this.db.select().from(competencyTemplate).where(eq(competencyTemplate.id, id)); return row;
  }
  async listTemplates(): Promise<TemplateRow[]> {
    return this.db.select().from(competencyTemplate).orderBy(asc(competencyTemplate.id));
  }
  async addTemplateCompetency(templateid: number, competencyid: number): Promise<void> {
    await this.db.insert(competencyTemplatecomp).values({ templateid, competencyid }).onConflictDoNothing();
  }
  async listTemplateCompetencies(templateid: number): Promise<CompetencyRow[]> {
    const links = await this.db.select().from(competencyTemplatecomp).where(eq(competencyTemplatecomp.templateid, templateid)).orderBy(asc(competencyTemplatecomp.sortorder));
    const out: CompetencyRow[] = [];
    for (const link of links) {
      const c = await this.getCompetency(link.competencyid);
      if (c) out.push(c);
    }
    return out;
  }
  async addTemplateCohort(templateid: number, cohortid: number): Promise<void> {
    await this.db.insert(competencyTemplatecohort).values({ templateid, cohortid }).onConflictDoNothing();
  }
  async listTemplateCohorts(templateid: number): Promise<number[]> {
    const rows = await this.db.select().from(competencyTemplatecohort).where(eq(competencyTemplatecohort.templateid, templateid));
    return rows.map((r) => r.cohortid);
  }

  async insertPlan(v: typeof learningPlans.$inferInsert, tx?: DbTx): Promise<PlanRow> {
    const [row] = await (tx ?? this.db).insert(learningPlans).values(v).returning(); return row!;
  }
  async getPlan(id: number): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(learningPlans).where(eq(learningPlans.id, id)); return row;
  }
  async listPlansForUser(userid: number): Promise<PlanRow[]> {
    return this.db.select().from(learningPlans).where(eq(learningPlans.userid, userid)).orderBy(asc(learningPlans.id));
  }
  async findPlanFromTemplate(userid: number, templateid: number): Promise<PlanRow | undefined> {
    const [row] = await this.db.select().from(learningPlans)
      .where(and(eq(learningPlans.userid, userid), eq(learningPlans.templateid, templateid)));
    return row;
  }
  async updatePlan(id: number, patch: Partial<PlanRow>): Promise<void> {
    await this.db.update(learningPlans).set({ ...patch, timemodified: new Date() }).where(eq(learningPlans.id, id));
  }
  async addPlanCompetency(planid: number, competencyid: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(competencyPlancomp).values({ planid, competencyid }).onConflictDoNothing();
  }
  async listPlanCompetencyIds(planid: number): Promise<number[]> {
    const rows = await this.db.select().from(competencyPlancomp).where(eq(competencyPlancomp.planid, planid)).orderBy(asc(competencyPlancomp.sortorder));
    return rows.map((r) => r.competencyid);
  }
  async insertPlanReview(v: typeof competencyPlanReview.$inferInsert): Promise<void> {
    await this.db.insert(competencyPlanReview).values(v);
  }
  async listPlanReviews(planid: number) {
    return this.db.select().from(competencyPlanReview).where(eq(competencyPlanReview.planid, planid)).orderBy(asc(competencyPlanReview.id));
  }

  async findUsercomp(userid: number, competencyid: number, planid: number, courseid: number): Promise<UsercompRow | undefined> {
    const [row] = await this.db.select().from(competencyUsercomp).where(and(
      eq(competencyUsercomp.userid, userid), eq(competencyUsercomp.competencyid, competencyid),
      eq(competencyUsercomp.planid, planid), eq(competencyUsercomp.courseid, courseid),
    ));
    return row;
  }
  async getUsercomp(id: number): Promise<UsercompRow | undefined> {
    const [row] = await this.db.select().from(competencyUsercomp).where(eq(competencyUsercomp.id, id)); return row;
  }
  async insertUsercomp(v: typeof competencyUsercomp.$inferInsert, tx?: DbTx): Promise<UsercompRow> {
    const [row] = await (tx ?? this.db).insert(competencyUsercomp).values(v).returning(); return row!;
  }
  async updateUsercomp(id: number, patch: Partial<UsercompRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(competencyUsercomp).set({ ...patch, timemodified: new Date() }).where(eq(competencyUsercomp.id, id));
  }
  async listUsercompsForPlan(planid: number, userid: number): Promise<UsercompRow[]> {
    return this.db.select().from(competencyUsercomp)
      .where(and(eq(competencyUsercomp.planid, planid), eq(competencyUsercomp.userid, userid)));
  }
  async listUsercompsForUser(userid: number): Promise<UsercompRow[]> {
    return this.db.select().from(competencyUsercomp).where(eq(competencyUsercomp.userid, userid)).orderBy(asc(competencyUsercomp.id));
  }

  async insertEvidence(v: typeof competencyEvidence.$inferInsert, tx?: DbTx): Promise<EvidenceRow> {
    const [row] = await (tx ?? this.db).insert(competencyEvidence).values(v).returning(); return row!;
  }
  async listEvidence(usercompetencyid: number): Promise<EvidenceRow[]> {
    return this.db.select().from(competencyEvidence).where(eq(competencyEvidence.usercompetencyid, usercompetencyid)).orderBy(asc(competencyEvidence.id));
  }
}
