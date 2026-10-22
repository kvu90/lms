import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { GroupsService } from '../groups/groups.service';
import { MessagingService } from '../messaging/messaging.service';
import { UsersService } from '../users/users.service';
import {
  CompetenciesRepository, type CompetencyRow, type EvidenceRow, type FrameworkRow,
  type PlanRow, type TemplateRow, type UsercompRow,
} from './competencies.repository';

export const PLAN_STATUS = { DRAFT: 0, ACTIVE: 1, WAITING_FOR_REVIEW: 2, IN_REVIEW: 3, COMPLETE: 4 } as const;
export const USERCOMP_REVIEW = { NONE: 0, WAITING: 1, IN_REVIEW: 2 } as const;
export const RULE_OUTCOMES = ['complete', 'attach-evidence', 'nothing'] as const;
export type RuleOutcome = (typeof RULE_OUTCOMES)[number];

export interface ScaleConfiguration { values: string[]; proficient: number[] }

export function parseScale(framework: FrameworkRow): ScaleConfiguration {
  const raw = (framework.scaleconfiguration ?? {}) as { values?: unknown; proficient?: unknown };
  const values = Array.isArray(raw.values) ? raw.values.map(String) : [];
  const proficient = Array.isArray(raw.proficient) ? raw.proficient.map(Number) : [];
  return { values, proficient };
}

/** Proficiency is a function of the FRAMEWORK SCALE only (report §2#15). */
export function isProficientGrade(framework: FrameworkRow, grade: number | null | undefined): boolean {
  if (grade === null || grade === undefined) return false;
  return parseScale(framework).proficient.includes(grade);
}

/**
 * CompetenciesModule facade (Moodle core_competency / tool_lp):
 *  - Frameworks own a competency TREE (path/depth) and a SCALE; proficiency
 *    is read off the scale configuration — NEVER inferred from grades. A
 *    grade can only become EVIDENCE when a link's ruleoutcome says
 *    'attach-evidence' (and even then it does not set proficiency).
 *  - Course/cm links carry an explicit ruleoutcome applied by THIS module
 *    when CompletionModule reports a completion (registered hooks — this
 *    module never reads completion tables).
 *  - Learning plans: template → cohort plans; lifecycle
 *    draft → active → waitingforreview → inreview → (approve → active |
 *    complete). Every transition is written to competency_plan_review.
 *  - User competencies carry proficiency + a review state machine
 *    (none → waiting → inreview → approve/reject); evidence rows are the
 *    immutable history of everything that happened.
 */
@Injectable()
export class CompetenciesService implements OnModuleInit {
  constructor(
    private readonly repo: CompetenciesRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly courses: CoursesService,
    private readonly groups: GroupsService,
    private readonly completion: CompletionService,
    private readonly messaging: MessagingService,
    private readonly users: UsersService,
    private readonly outbox: OutboxService,
    private readonly emitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    this.completion.registerCourseCompletionHook(async ({ courseId, userId }) => {
      await this.applyCourseCompletion(courseId, userId);
    });
    this.completion.registerCmCompletionHook(async ({ cmId, courseId, userId }) => {
      void courseId;
      await this.applyCmCompletion(cmId, userId);
    });
  }

  private async systemCtx(): Promise<number> {
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async requireManage(actorId: number): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'moodle/competency:competencymanage', await this.systemCtx());
  }

  // --- frameworks & competencies -------------------------------------------------

  async createFramework(actorId: number, input: { shortname: string; idnumber?: string; description?: string; scale: ScaleConfiguration; visible?: boolean }): Promise<FrameworkRow> {
    await this.requireManage(actorId);
    if (!input.scale.values.length) throw new BadRequestException({ message: 'A framework scale needs at least one value', code: 'competency.scale_empty' });
    for (const idx of input.scale.proficient) {
      if (idx < 0 || idx >= input.scale.values.length) {
        throw new BadRequestException({ message: `Proficient index ${idx} is outside the scale`, code: 'competency.scale_proficient_range' });
      }
    }
    return this.repo.insertFramework({
      shortname: input.shortname, idnumber: input.idnumber ?? '', description: input.description ?? '',
      contextid: await this.systemCtx(), scaleconfiguration: input.scale, visible: input.visible ?? true,
    });
  }
  async getFramework(id: number): Promise<FrameworkRow> {
    const row = await this.repo.getFramework(id);
    if (!row) throw new NotFoundException({ message: `Framework ${id} not found`, code: 'competency.framework_not_found' });
    return row;
  }
  async listFrameworks(): Promise<FrameworkRow[]> { return this.repo.listFrameworks(); }

  async createCompetency(actorId: number, frameworkId: number, input: { shortname: string; idnumber?: string; description?: string; parentId?: number }): Promise<CompetencyRow> {
    await this.requireManage(actorId);
    const framework = await this.getFramework(frameworkId);
    void framework;
    let parent: CompetencyRow | undefined;
    if (input.parentId) {
      parent = await this.getCompetency(input.parentId);
      if (parent.frameworkid !== frameworkId) throw new BadRequestException({ message: 'Parent competency belongs to another framework', code: 'competency.parent_framework_mismatch' });
    }
    const created = await this.repo.insertCompetency({
      frameworkid: frameworkId, shortname: input.shortname, idnumber: input.idnumber ?? '',
      description: input.description ?? '', parentid: parent?.id ?? 0,
      path: '', depth: parent ? parent.depth + 1 : 1,
    });
    const path = parent ? `${parent.path}/${created.id}` : `/${created.id}`;
    await this.repo.updateCompetency(created.id, { path });
    return (await this.repo.getCompetency(created.id))!;
  }
  async getCompetency(id: number): Promise<CompetencyRow> {
    const row = await this.repo.getCompetency(id);
    if (!row) throw new NotFoundException({ message: `Competency ${id} not found`, code: 'competency.not_found' });
    return row;
  }
  async listCompetencies(frameworkId: number): Promise<CompetencyRow[]> {
    await this.getFramework(frameworkId);
    return this.repo.listCompetencies(frameworkId);
  }

  // --- course / cm links --------------------------------------------------------------

  private assertOutcome(outcome: string): RuleOutcome {
    if (!RULE_OUTCOMES.includes(outcome as RuleOutcome)) {
      throw new BadRequestException({ message: `Unknown ruleoutcome ${outcome} (expected complete | attach-evidence | nothing)`, code: 'competency.bad_ruleoutcome' });
    }
    return outcome as RuleOutcome;
  }

  async linkCourseCompetency(actorId: number, courseId: number, input: { competencyId: number; ruleoutcome: string }) {
    await this.courses.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'moodle/competency:coursecompetencymanage', await this.courses.courseContextId(courseId));
    const competencyRow = await this.getCompetency(input.competencyId);
    return this.repo.insertCourseLink({ courseid: courseId, competencyid: competencyRow.id, ruleoutcome: this.assertOutcome(input.ruleoutcome) });
  }
  async listCourseCompetencies(courseId: number) {
    return this.repo.listCourseLinks(courseId);
  }
  async linkModuleCompetency(actorId: number, cmId: number, input: { competencyId: number; ruleoutcome: string }) {
    const cm = await this.courses.getCm(cmId);
    await this.evaluator.requireCapability(actorId, 'moodle/competency:coursecompetencymanage', await this.courses.courseContextId(cm.course));
    const competencyRow = await this.getCompetency(input.competencyId);
    return this.repo.insertModuleLink({ coursemoduleid: cmId, competencyid: competencyRow.id, ruleoutcome: this.assertOutcome(input.ruleoutcome) });
  }
  async listModuleCompetencies(cmId: number) {
    return this.repo.listModuleLinks(cmId);
  }

  // --- user competencies + evidence -------------------------------------------------------

  async getOrCreateUsercomp(userId: number, competencyId: number, scope: { planId?: number; courseId?: number }): Promise<UsercompRow> {
    const planid = scope.planId ?? 0;
    const courseid = scope.courseId ?? 0;
    const existing = await this.repo.findUsercomp(userId, competencyId, planid, courseid);
    if (existing) return existing;
    return this.repo.insertUsercomp({ userid: userId, competencyid: competencyId, planid, courseid });
  }

  async getUsercomp(id: number): Promise<UsercompRow> {
    const row = await this.repo.getUsercomp(id);
    if (!row) throw new NotFoundException({ message: `User competency ${id} not found`, code: 'competency.usercomp_not_found' });
    return row;
  }
  async listUsercompsForUser(userId: number): Promise<UsercompRow[]> {
    return this.repo.listUsercompsForUser(userId);
  }

  /** Facade for BadgesModule: is this user proficient in this competency (any scope)? */
  async isProficient(userId: number, competencyId: number): Promise<boolean> {
    const rows = await this.repo.listUsercompsForUser(userId);
    return rows.some((r) => r.competencyid === competencyId && r.proficiency === true);
  }

  private async validateGrade(competencyId: number, grade: number): Promise<FrameworkRow> {
    const competencyRow = await this.getCompetency(competencyId);
    const framework = await this.getFramework(competencyRow.frameworkid);
    const scale = parseScale(framework);
    if (!Number.isInteger(grade) || grade < 0 || grade >= scale.values.length) {
      throw new BadRequestException({
        message: `Grade ${grade} is not a value of the framework scale (0..${scale.values.length - 1})`,
        code: 'competency.grade_outside_scale',
      });
    }
    return framework;
  }

  /**
   * Attach evidence to a user's competency (oracle: api_test
   * test_add_evidence_*). A grade on evidence is a SCALE INDEX: it sets
   * proficiency per the framework scale — but only when the actor may rate
   * (review capability, or the plan/course manager path). Evidence submitted
   * by the learner themselves is recorded WITHOUT a proficiency effect
   * unless sendForReview moves it into the review workflow.
   */
  async addEvidence(actorId: number, input: {
    userId: number; competencyId: number; planId?: number; courseId?: number;
    description: string; url?: string; grade?: number; note?: string; sendForReview?: boolean;
  }): Promise<{ usercomp: UsercompRow; evidence: EvidenceRow }> {
    const competencyRow = await this.getCompetency(input.competencyId);
    void competencyRow;
    await this.users.getUser(input.userId);
    if (input.grade !== undefined) await this.validateGrade(input.competencyId, input.grade);
    const canRate = await this.evaluator.hasCapability(actorId, 'moodle/competency:usercompetencyreview', await this.systemCtx());
    const usercomp = await this.getOrCreateUsercomp(input.userId, input.competencyId, { planId: input.planId, courseId: input.courseId });
    let evidence!: EvidenceRow;
    await this.repo.dbHandle.transaction(async (tx) => {
      evidence = await this.repo.insertEvidence({
        usercompetencyid: usercomp.id, actionuserid: actorId, action: 'evidence',
        description: input.description, url: input.url ?? null,
        grade: input.grade ?? null, note: input.note ?? '',
        contextid: await this.systemCtx(),
      }, tx as never);
      if (input.grade !== undefined && canRate) {
        const framework = await this.getFramework(competencyRow.frameworkid);
        await this.repo.updateUsercomp(usercomp.id, {
          grade: input.grade, proficiency: isProficientGrade(framework, input.grade),
        }, tx as never);
        await this.emitter.emitAsync('competency_proficiency_changed', { userId: input.userId, competencyId: input.competencyId });
      }
      if (input.sendForReview) {
        await this.repo.updateUsercomp(usercomp.id, { status: USERCOMP_REVIEW.WAITING }, tx as never);
        await this.repo.insertEvidence({
          usercompetencyid: usercomp.id, actionuserid: actorId, action: 'review_requested',
          description: 'Sent for review with evidence', grade: null,
        }, tx as never);
      }
      await this.outbox.enqueue(tx as never, {
        aggregate: 'competency', type: 'competency_evidence_added',
        payload: { userId: input.userId, competencyId: input.competencyId, evidenceId: evidence.id },
      });
    });
    return { usercomp: await this.getUsercomp(usercomp.id), evidence };
  }

  async listEvidence(usercompId: number): Promise<EvidenceRow[]> {
    await this.getUsercomp(usercompId);
    return this.repo.listEvidence(usercompId);
  }

  // --- usercomp review workflow ---------------------------------------------------------

  private async transitionUsercompReview(actorId: number, usercompId: number, action: 'request' | 'start' | 'approve' | 'reject',
    opts?: { grade?: number; note?: string }): Promise<UsercompRow> {
    const usercomp = await this.getUsercomp(usercompId);
    const systemCtx = await this.systemCtx();
    if (action === 'request') {
      if (actorId !== usercomp.userid) {
        await this.evaluator.requireCapability(actorId, 'moodle/competency:planmanage', systemCtx);
      }
      if (usercomp.status !== USERCOMP_REVIEW.NONE) {
        throw new BadRequestException({ message: 'A review is already in progress for this competency', code: 'competency.review_in_progress' });
      }
      await this.repo.updateUsercomp(usercompId, { status: USERCOMP_REVIEW.WAITING });
      await this.repo.insertEvidence({ usercompetencyid: usercompId, actionuserid: actorId, action: 'review_requested', description: 'Review requested', note: opts?.note ?? '' });
    } else {
      await this.evaluator.requireCapability(actorId, 'moodle/competency:usercompetencyreview', systemCtx);
      if (action === 'start') {
        if (usercomp.status !== USERCOMP_REVIEW.WAITING) {
          throw new BadRequestException({ message: 'Review can only start from waitingforreview', code: 'competency.review_not_waiting' });
        }
        await this.repo.updateUsercomp(usercompId, { status: USERCOMP_REVIEW.IN_REVIEW, reviewerid: actorId });
        await this.repo.insertEvidence({ usercompetencyid: usercompId, actionuserid: actorId, action: 'review_started', description: 'Review started', note: opts?.note ?? '' });
      } else if (action === 'approve') {
        if (usercomp.status !== USERCOMP_REVIEW.IN_REVIEW && usercomp.status !== USERCOMP_REVIEW.WAITING) {
          throw new BadRequestException({ message: 'Only a competency in review can be approved', code: 'competency.review_not_in_review' });
        }
        if (opts?.grade !== undefined) await this.validateGrade(usercomp.competencyid, opts.grade);
        const competencyRow = await this.getCompetency(usercomp.competencyid);
        const framework = await this.getFramework(competencyRow.frameworkid);
        const scale = parseScale(framework);
        const grade = opts?.grade ?? scale.proficient[0];
        if (grade === undefined) throw new BadRequestException({ message: 'The framework scale has no proficient value to approve with', code: 'competency.scale_no_proficient' });
        await this.repo.updateUsercomp(usercompId, {
          status: USERCOMP_REVIEW.NONE, grade, proficiency: isProficientGrade(framework, grade), reviewerid: actorId,
        });
        await this.repo.insertEvidence({
          usercompetencyid: usercompId, actionuserid: actorId, action: 'review_approved',
          description: 'Review approved', grade, note: opts?.note ?? '',
        });
        await this.emitter.emitAsync('competency_proficiency_changed', { userId: usercomp.userid, competencyId: usercomp.competencyid });
        await this.outbox.enqueueStandalone({
          aggregate: 'competency', type: 'competency_proficiency_changed',
          payload: { userId: usercomp.userid, competencyId: usercomp.competencyid, proficient: true },
        });
      } else {
        if (usercomp.status !== USERCOMP_REVIEW.IN_REVIEW && usercomp.status !== USERCOMP_REVIEW.WAITING) {
          throw new BadRequestException({ message: 'Only a competency in review can be rejected', code: 'competency.review_not_in_review' });
        }
        await this.repo.updateUsercomp(usercompId, { status: USERCOMP_REVIEW.NONE, reviewerid: actorId });
        await this.repo.insertEvidence({
          usercompetencyid: usercompId, actionuserid: actorId, action: 'review_rejected',
          description: 'Review rejected', note: opts?.note ?? '',
        });
      }
    }
    return this.getUsercomp(usercompId);
  }

  async requestUsercompReview(actorId: number, usercompId: number): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'request');
  }
  async startUsercompReview(actorId: number, usercompId: number): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'start');
  }
  async approveUsercompReview(actorId: number, usercompId: number, grade?: number, note?: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'approve', { grade, note });
  }
  async rejectUsercompReview(actorId: number, usercompId: number, note?: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'reject', { note });
  }

  /** Direct rating by a reviewer (oracle: test_add_evidence_complete / grade_competency_in_course). */
  async gradeUsercomp(actorId: number, input: { userId: number; competencyId: number; planId?: number; courseId?: number; grade: number; note?: string }): Promise<UsercompRow> {
    await this.evaluator.requireCapability(actorId, 'moodle/competency:usercompetencyreview', await this.systemCtx());
    const framework = await this.validateGrade(input.competencyId, input.grade);
    const usercomp = await this.getOrCreateUsercomp(input.userId, input.competencyId, { planId: input.planId, courseId: input.courseId });
    await this.repo.updateUsercomp(usercomp.id, { grade: input.grade, proficiency: isProficientGrade(framework, input.grade) });
    await this.repo.insertEvidence({
      usercompetencyid: usercomp.id, actionuserid: actorId, action: 'graded',
      description: 'Rated by reviewer', grade: input.grade, note: input.note ?? '',
    });
    await this.emitter.emitAsync('competency_proficiency_changed', { userId: input.userId, competencyId: input.competencyId });
    return this.getUsercomp(usercomp.id);
  }

  // --- completion-driven rule outcomes (registered hooks) --------------------------------

  /** Course completed ⇒ apply each linked competency's ruleoutcome in the COURSE scope. */
  async applyCourseCompletion(courseId: number, userId: number): Promise<void> {
    const links = await this.repo.listCourseLinks(courseId);
    for (const link of links) {
      if (link.ruleoutcome === 'nothing') continue;
      await this.applyOutcome(userId, link.competencyid, { courseId }, link.ruleoutcome as RuleOutcome, `Course ${courseId} completed`);
    }
  }
  /** Activity completed ⇒ apply each linked competency's ruleoutcome in the COURSE scope of the cm's course. */
  async applyCmCompletion(cmId: number, userId: number): Promise<void> {
    const links = await this.repo.listModuleLinks(cmId);
    if (!links.length) return;
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    for (const link of links) {
      if (link.ruleoutcome === 'nothing') continue;
      await this.applyOutcome(userId, link.competencyid, { courseId: cm?.course ?? 0 }, link.ruleoutcome as RuleOutcome, `Activity ${cmId} completed`);
    }
  }

  private async applyOutcome(userId: number, competencyId: number, scope: { planId?: number; courseId?: number },
    outcome: RuleOutcome, description: string): Promise<void> {
    const usercomp = await this.getOrCreateUsercomp(userId, competencyId, scope);
    if (outcome === 'attach-evidence') {
      // Evidence ONLY: proficiency is untouched — grades/points never leak
      // into proficiency (report §2#15).
      await this.repo.insertEvidence({
        usercompetencyid: usercomp.id, actionuserid: userId, action: 'course_completed',
        description, grade: null,
      });
      return;
    }
    // 'complete': proficiency from the framework scale's first proficient value.
    const competencyRow = await this.getCompetency(competencyId);
    const framework = await this.getFramework(competencyRow.frameworkid);
    const scale = parseScale(framework);
    const grade = scale.proficient[0];
    await this.repo.insertEvidence({
      usercompetencyid: usercomp.id, actionuserid: userId, action: 'course_completed',
      description, grade: grade ?? null,
    });
    if (grade !== undefined) {
      await this.repo.updateUsercomp(usercomp.id, { grade, proficiency: true });
      await this.emitter.emitAsync('competency_proficiency_changed', { userId, competencyId });
      await this.outbox.enqueueStandalone({
        aggregate: 'competency', type: 'competency_proficiency_changed',
        payload: { userId, competencyId, proficient: true, via: 'course-completion' },
      });
    }
  }

  // --- templates ---------------------------------------------------------------------------

  async createTemplate(actorId: number, input: { shortname: string; description?: string; duedate?: string }): Promise<TemplateRow> {
    await this.requireManage(actorId);
    return this.repo.insertTemplate({
      shortname: input.shortname, description: input.description ?? '',
      contextid: await this.systemCtx(), duedate: input.duedate ? new Date(input.duedate) : null,
    });
  }
  async getTemplate(id: number): Promise<TemplateRow> {
    const row = await this.repo.getTemplate(id);
    if (!row) throw new NotFoundException({ message: `Template ${id} not found`, code: 'competency.template_not_found' });
    return row;
  }
  async listTemplates(): Promise<TemplateRow[]> { return this.repo.listTemplates(); }
  async addTemplateCompetency(actorId: number, templateId: number, competencyId: number): Promise<{ templateId: number; competencies: CompetencyRow[] }> {
    await this.requireManage(actorId);
    await this.getTemplate(templateId);
    await this.getCompetency(competencyId);
    await this.repo.addTemplateCompetency(templateId, competencyId);
    return { templateId, competencies: await this.repo.listTemplateCompetencies(templateId) };
  }
  async addTemplateCohort(actorId: number, templateId: number, cohortId: number): Promise<{ templateId: number; cohorts: number[] }> {
    await this.requireManage(actorId);
    await this.getTemplate(templateId);
    await this.groups.getCohort(cohortId);
    await this.repo.addTemplateCohort(templateId, cohortId);
    return { templateId, cohorts: await this.repo.listTemplateCohorts(templateId) };
  }

  /** Generate plans for every member of every linked cohort (idempotent per user+template). */
  async createPlansFromTemplate(actorId: number, templateId: number): Promise<{ created: number; plans: PlanRow[] }> {
    await this.requireManage(actorId);
    const template = await this.getTemplate(templateId);
    const cohortIds = await this.repo.listTemplateCohorts(templateId);
    const plans: PlanRow[] = [];
    for (const cohortId of cohortIds) {
      const members = await this.groups.listCohortMembers(cohortId);
      for (const member of members) {
        const plan = await this.createPlanFromTemplate(template, member.userid);
        if (plan) plans.push(plan);
      }
    }
    return { created: plans.length, plans };
  }

  private async createPlanFromTemplate(template: TemplateRow, userId: number): Promise<PlanRow | null> {
    const existing = await this.repo.findPlanFromTemplate(userId, template.id);
    if (existing) return null;
    const competencies = await this.repo.listTemplateCompetencies(template.id);
    const plan = await this.repo.dbHandle.transaction(async (tx) => {
      const created = await this.repo.insertPlan({
        name: template.shortname, description: template.description, userid: userId,
        templateid: template.id, status: PLAN_STATUS.ACTIVE, duedate: template.duedate,
      }, tx as never);
      for (const c of competencies) await this.repo.addPlanCompetency(created.id, c.id, tx as never);
      return created;
    });
    for (const c of competencies) {
      await this.getOrCreateUsercomp(userId, c.id, { planId: plan.id });
    }
    return plan;
  }

  // --- plans ---------------------------------------------------------------------------------

  async createPlan(actorId: number, input: { userId?: number; name: string; description?: string; templateId?: number }): Promise<PlanRow & { competencies: number[] }> {
    const userId = input.userId ?? actorId;
    if (userId !== actorId) {
      await this.evaluator.requireCapability(actorId, 'moodle/competency:planmanage', await this.systemCtx());
    }
    await this.users.getUser(userId);
    if (input.templateId) {
      const template = await this.getTemplate(input.templateId);
      const created = await this.createPlanFromTemplate(template, userId);
      const plan = created ?? (await this.repo.findPlanFromTemplate(userId, template.id))!;
      return { ...plan, competencies: await this.repo.listPlanCompetencyIds(plan.id) };
    }
    const plan = await this.repo.insertPlan({
      name: input.name, description: input.description ?? '', userid: userId,
      templateid: null, status: PLAN_STATUS.DRAFT,
    });
    return { ...plan, competencies: [] };
  }

  async getPlanView(actorId: number, planId: number): Promise<{ plan: PlanRow; competencies: { competency: CompetencyRow; usercomp: UsercompRow | null }[]; reviews: unknown }> {
    const plan = await this.repo.getPlan(planId);
    if (!plan) throw new NotFoundException({ message: `Learning plan ${planId} not found`, code: 'competency.plan_not_found' });
    if (plan.userid !== actorId) {
      await this.evaluator.requireCapability(actorId, 'moodle/competency:planview', await this.systemCtx());
    }
    const ids = plan.templateid
      ? (await this.repo.listTemplateCompetencies(plan.templateid)).map((c) => c.id)
      : await this.repo.listPlanCompetencyIds(planId);
    const usercomps = await this.repo.listUsercompsForPlan(planId, plan.userid);
    const competencies = [];
    for (const id of ids) {
      competencies.push({
        competency: await this.getCompetency(id),
        usercomp: usercomps.find((u) => u.competencyid === id) ?? null,
      });
    }
    return { plan, competencies, reviews: await this.repo.listPlanReviews(planId) };
  }

  async listPlansForUser(actorId: number, userId: number): Promise<PlanRow[]> {
    if (actorId !== userId) {
      await this.evaluator.requireCapability(actorId, 'moodle/competency:planview', await this.systemCtx());
    }
    return this.repo.listPlansForUser(userId);
  }

  private async planTransition(actorId: number, planId: number, action: 'activate' | 'request-review' | 'cancel-review' | 'start-review' | 'stop-review' | 'approve' | 'unapprove' | 'complete',
    note?: string): Promise<PlanRow> {
    const plan = await this.repo.getPlan(planId);
    if (!plan) throw new NotFoundException({ message: `Learning plan ${planId} not found`, code: 'competency.plan_not_found' });
    const from = plan.status;
    const bad = (msg: string): never => { throw new BadRequestException({ message: msg, code: 'competency.plan_bad_transition' }); };
    let to = from;
    switch (action) {
      case 'activate':
        if (plan.userid !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.DRAFT) bad('Only a draft plan can be activated');
        to = PLAN_STATUS.ACTIVE;
        break;
      case 'request-review':
        if (plan.userid !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.ACTIVE) bad('Only an active plan can be sent for review');
        to = PLAN_STATUS.WAITING_FOR_REVIEW;
        break;
      case 'cancel-review':
        if (plan.userid !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.WAITING_FOR_REVIEW) bad('Only a plan waiting for review can cancel the request');
        to = PLAN_STATUS.ACTIVE;
        break;
      case 'start-review':
        await this.evaluator.requireCapability(actorId, 'moodle/competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.WAITING_FOR_REVIEW) bad('Review can only start for a plan waiting for review');
        to = PLAN_STATUS.IN_REVIEW;
        break;
      case 'stop-review':
        await this.evaluator.requireCapability(actorId, 'moodle/competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.IN_REVIEW) bad('Only a plan in review can stop review');
        to = PLAN_STATUS.ACTIVE;
        break;
      case 'approve':
        await this.evaluator.requireCapability(actorId, 'moodle/competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.IN_REVIEW) bad('Only a plan in review can be approved');
        to = PLAN_STATUS.ACTIVE; // approved review returns the plan to active (Moodle approve_plan)
        break;
      case 'unapprove':
        await this.evaluator.requireCapability(actorId, 'moodle/competency:usercompetencyreview', await this.systemCtx());
        if (from !== PLAN_STATUS.ACTIVE) bad('Only an active (previously approved) plan can be unapproved');
        to = PLAN_STATUS.IN_REVIEW;
        break;
      case 'complete':
        if (plan.userid !== actorId) await this.evaluator.requireCapability(actorId, 'moodle/competency:planmanage', await this.systemCtx());
        if (from !== PLAN_STATUS.ACTIVE && from !== PLAN_STATUS.IN_REVIEW) bad('Only an active plan can be completed');
        to = PLAN_STATUS.COMPLETE;
        break;
    }
    await this.repo.updatePlan(planId, { status: to, reviewerid: ['start-review', 'approve', 'unapprove'].includes(action) ? actorId : plan.reviewerid });
    await this.repo.insertPlanReview({ planid: planId, actorid: actorId, action, statusfrom: from, statusto: to, note: note ?? '' });
    if (action === 'request-review' && plan.reviewerid) {
      await this.messaging.notify(plan.reviewerid, 'competency_review_requested', {
        subject: `Learning plan review requested: ${plan.name}`,
        body: `User ${plan.userid} requested a review of learning plan ${plan.id}.`,
        contextUrl: `/competencies/plans/${plan.id}`,
      }).catch(() => undefined);
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'competency', type: `competency_plan_${action.replace('-', '_')}`,
      payload: { planId, userId: plan.userid, from, to },
    });
    return (await this.repo.getPlan(planId))!;
  }

  async activatePlan(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'activate'); }
  async requestPlanReview(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'request-review'); }
  async cancelPlanReview(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'cancel-review'); }
  async startPlanReview(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'start-review'); }
  async stopPlanReview(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'stop-review'); }
  async approvePlan(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'approve'); }
  async unapprovePlan(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'unapprove'); }
  async completePlan(actorId: number, planId: number): Promise<PlanRow> { return this.planTransition(actorId, planId, 'complete'); }

  /** Forbidden import guard: plan owners may not review their own plans. */
  async assertNotSelfReview(actorId: number, userId: number): Promise<void> {
    if (actorId === userId) throw new ForbiddenException({ message: 'You cannot review your own competencies', code: 'competency.self_review' });
  }
}
