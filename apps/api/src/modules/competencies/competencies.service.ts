import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { I18nService } from '@nestjs/i18n';
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
/**
 * Nghiệp vụ khung năng lực và kế hoạch học tập (learning plans).
 * Đối chiếu Moodle: competency/classes (framework, competency, plan, user_competency).
 * Quy tắc review: người học không được tự duyệt năng lực/kế hoạch của chính mình (assertNotSelfReview);
 * proficiency chỉ được đặt qua chấm (grade) hoặc duyệt evidence; hoàn thành khoá học/cm có thể tự động
 * cấp proficiency cho các competency đã liên kết khi framework cấu hình như vậy.
 */
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
    private readonly i18n: I18nService,
  ) {}

  /**
   * Khởi tạo: đăng ký hook hoàn thành course/cm để tự động xét proficiency.
   */
  onModuleInit(): void {
    this.completion.registerCourseCompletionHook(async ({ courseId, userId }) => {
      await this.applyCourseCompletion(courseId, userId);
    });
    this.completion.registerCmCompletionHook(async ({ cmId, courseId, userId }) => {
      void courseId;
      await this.applyCmCompletion(cmId, userId);
    });
  }

  private async systemCtx(): Promise<string> {
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async requireManage(actorId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'moodle/competency:competencymanage', await this.systemCtx());
  }

  // --- frameworks & competencies -------------------------------------------------

  /**
   * Tạo framework năng lực.
   */
  async createFramework(actorId: string, input: { shortname: string; idnumber?: string; description?: string; scale: ScaleConfiguration; visible?: boolean }): Promise<FrameworkRow> {
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
  /**
   * Lấy framework; ném competencies.framework_not_found khi vắng.
   */
  async getFramework(id: string): Promise<FrameworkRow> {
    const row = await this.repo.getFramework(id);
    if (!row) throw new NotFoundException({ message: `Framework ${id} not found`, code: 'competency.framework_not_found' });
    return row;
  }
  /**
   * Liệt kê framework.
   */
  async listFrameworks(): Promise<FrameworkRow[]> { return this.repo.listFrameworks(); }

  /**
   * Thêm competency vào framework (có thể lồng nhau theo parent).
   */
  async createCompetency(actorId: string, frameworkId: string, input: { shortname: string; idnumber?: string; description?: string; parentId?: string }): Promise<CompetencyRow> {
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
      description: input.description ?? '', parentid: parent?.id ?? null,
      path: '', depth: parent ? parent.depth + 1 : 1,
    });
    const path = parent ? `${parent.path}/${created.id}` : `/${created.id}`;
    await this.repo.updateCompetency(created.id, { path });
    return (await this.repo.getCompetency(created.id))!;
  }
  /**
   * Lấy competency; ném competencies.not_found khi vắng.
   */
  async getCompetency(id: string): Promise<CompetencyRow> {
    const row = await this.repo.getCompetency(id);
    if (!row) throw new NotFoundException({ message: `Competency ${id} not found`, code: 'competency.not_found' });
    return row;
  }
  /**
   * Competency của framework.
   */
  async listCompetencies(frameworkId: string): Promise<CompetencyRow[]> {
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

  /**
   * Liên kết competency với khoá học + quy tắc tự cấp proficiency.
   */
  async linkCourseCompetency(actorId: string, courseId: string, input: { competencyId: string; ruleoutcome: string }) {
    await this.courses.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'moodle/competency:coursecompetencymanage', await this.courses.courseContextId(courseId));
    const competencyRow = await this.getCompetency(input.competencyId);
    return this.repo.insertCourseLink({ courseid: courseId, competencyid: competencyRow.id, ruleoutcome: this.assertOutcome(input.ruleoutcome) });
  }
  /**
   * Competency đã liên kết với khoá học.
   */
  async listCourseCompetencies(courseId: string) {
    return this.repo.listCourseLinks(courseId);
  }
  /**
   * Liên kết competency với course module.
   */
  async linkModuleCompetency(actorId: string, cmId: string, input: { competencyId: string; ruleoutcome: string }) {
    const cm = await this.courses.getCm(cmId);
    await this.evaluator.requireCapability(actorId, 'moodle/competency:coursecompetencymanage', await this.courses.courseContextId(cm.course));
    const competencyRow = await this.getCompetency(input.competencyId);
    return this.repo.insertModuleLink({ coursemoduleid: cmId, competencyid: competencyRow.id, ruleoutcome: this.assertOutcome(input.ruleoutcome) });
  }
  /**
   * Competency đã liên kết với module.
   */
  async listModuleCompetencies(cmId: string) {
    return this.repo.listModuleLinks(cmId);
  }

  // --- user competencies + evidence -------------------------------------------------------

  /**
   * Lấy hoặc tạo bản ghi năng lực của user cho một competency.
   */
  async getOrCreateUsercomp(userId: string, competencyId: string, scope: { planId?: string; courseId?: string }): Promise<UsercompRow> {
    const planid = scope.planId ?? null;
    const courseid = scope.courseId ?? null;
    const existing = await this.repo.findUsercomp(userId, competencyId, planid, courseid);
    if (existing) return existing;
    return this.repo.insertUsercomp({ userid: userId, competencyid: competencyId, planid, courseid });
  }

  /**
   * Lấy usercomp theo id.
   */
  async getUsercomp(id: string): Promise<UsercompRow> {
    const row = await this.repo.getUsercomp(id);
    if (!row) throw new NotFoundException({ message: `User competency ${id} not found`, code: 'competency.usercomp_not_found' });
    return row;
  }
  /**
   * Usercomp của user.
   */
  async listUsercompsForUser(userId: string): Promise<UsercompRow[]> {
    return this.repo.listUsercompsForUser(userId);
  }

  /** Facade for BadgesModule: is this user proficient in this competency (any scope)? */
  /**
   * User đã đạt chuẩn competency hay chưa.
   */
  async isProficient(userId: string, competencyId: string): Promise<boolean> {
    const rows = await this.repo.listUsercompsForUser(userId);
    return rows.some((r) => r.competencyid === competencyId && r.proficiency === true);
  }

  private async validateGrade(competencyId: string, grade: number): Promise<FrameworkRow> {
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
  /**
   * Thêm bằng chứng cho usercomp (có thể đồng thời gửi duyệt).
   */
  async addEvidence(actorId: string, input: {
    userId: string; competencyId: string; planId?: string; courseId?: string;
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

  /**
   * Bằng chứng của usercomp.
   */
  async listEvidence(usercompId: string): Promise<EvidenceRow[]> {
    await this.getUsercomp(usercompId);
    return this.repo.listEvidence(usercompId);
  }

  // --- usercomp review workflow ---------------------------------------------------------

  private async transitionUsercompReview(actorId: string, usercompId: string, action: 'request' | 'start' | 'approve' | 'reject',
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

  /**
   * Gửi usercomp đi duyệt.
   */
  async requestUsercompReview(actorId: string, usercompId: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'request');
  }
  /**
   * Reviewer bắt đầu duyệt usercomp.
   */
  async startUsercompReview(actorId: string, usercompId: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'start');
  }
  /**
   * Duyệt đạt: đặt proficiency theo thang của framework.
   */
  async approveUsercompReview(actorId: string, usercompId: string, grade?: number, note?: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'approve', { grade, note });
  }
  /**
   * Từ chối duyệt usercomp.
   */
  async rejectUsercompReview(actorId: string, usercompId: string, note?: string): Promise<UsercompRow> {
    return this.transitionUsercompReview(actorId, usercompId, 'reject', { note });
  }

  /** Direct rating by a reviewer (oracle: test_add_evidence_complete / grade_competency_in_course). */
  /**
   * Chấm trực tiếp proficiency cho usercomp bởi người có capability.
   */
  async gradeUsercomp(actorId: string, input: { userId: string; competencyId: string; planId?: string; courseId?: string; grade: number; note?: string }): Promise<UsercompRow> {
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
  /**
   * Hook hoàn thành khoá học: cấp proficiency cho competency liên kết có quy tắc tự động.
   */
  async applyCourseCompletion(courseId: string, userId: string): Promise<void> {
    const links = await this.repo.listCourseLinks(courseId);
    for (const link of links) {
      if (link.ruleoutcome === 'nothing') continue;
      await this.applyOutcome(userId, link.competencyid, { courseId }, link.ruleoutcome as RuleOutcome, `Course ${courseId} completed`);
    }
  }
  /** Activity completed ⇒ apply each linked competency's ruleoutcome in the COURSE scope of the cm's course. */
  /**
   * Hook hoàn thành cm: cấp proficiency cho competency liên kết với module.
   */
  async applyCmCompletion(cmId: string, userId: string): Promise<void> {
    const links = await this.repo.listModuleLinks(cmId);
    if (!links.length) return;
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    for (const link of links) {
      if (link.ruleoutcome === 'nothing') continue;
      await this.applyOutcome(userId, link.competencyid, { courseId: cm?.course }, link.ruleoutcome as RuleOutcome, `Activity ${cmId} completed`);
    }
  }

  private async applyOutcome(userId: string, competencyId: string, scope: { planId?: string; courseId?: string },
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

  /**
   * Tạo template kế hoạch.
   */
  async createTemplate(actorId: string, input: { shortname: string; description?: string; duedate?: string }): Promise<TemplateRow> {
    await this.requireManage(actorId);
    return this.repo.insertTemplate({
      shortname: input.shortname, description: input.description ?? '',
      contextid: await this.systemCtx(), duedate: input.duedate ? new Date(input.duedate) : null,
    });
  }
  /**
   * Lấy template; ném competencies.template_not_found khi vắng.
   */
  async getTemplate(id: string): Promise<TemplateRow> {
    const row = await this.repo.getTemplate(id);
    if (!row) throw new NotFoundException({ message: `Template ${id} not found`, code: 'competency.template_not_found' });
    return row;
  }
  /**
   * Liệt kê template.
   */
  async listTemplates(): Promise<TemplateRow[]> { return this.repo.listTemplates(); }
  /**
   * Thêm competency vào template.
   */
  async addTemplateCompetency(actorId: string, templateId: string, competencyId: string): Promise<{ templateId: string; competencies: CompetencyRow[] }> {
    await this.requireManage(actorId);
    await this.getTemplate(templateId);
    await this.getCompetency(competencyId);
    await this.repo.addTemplateCompetency(templateId, competencyId);
    return { templateId, competencies: await this.repo.listTemplateCompetencies(templateId) };
  }
  /**
   * Gắn cohort vào template.
   */
  async addTemplateCohort(actorId: string, templateId: string, cohortId: string): Promise<{ templateId: string; cohorts: string[] }> {
    await this.requireManage(actorId);
    await this.getTemplate(templateId);
    await this.groups.getCohort(cohortId);
    await this.repo.addTemplateCohort(templateId, cohortId);
    return { templateId, cohorts: await this.repo.listTemplateCohorts(templateId) };
  }

  /** Generate plans for every member of every linked cohort (idempotent per user+template). */
  /**
   * Sinh plan cho mọi thành viên cohort của template (bỏ qua user đã có plan từ template này).
   */
  async createPlansFromTemplate(actorId: string, templateId: string): Promise<{ created: number; plans: PlanRow[] }> {
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

  private async createPlanFromTemplate(template: TemplateRow, userId: string): Promise<PlanRow | null> {
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

  /**
   * Tạo plan thủ công cho user.
   */
  async createPlan(actorId: string, input: { userId?: string; name: string; description?: string; templateId?: string }): Promise<PlanRow & { competencies: string[] }> {
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

  /**
   * Chi tiết plan kèm trạng thái từng competency.
   */
  async getPlanView(actorId: string, planId: string): Promise<{ plan: PlanRow; competencies: { competency: CompetencyRow; usercomp: UsercompRow | null }[]; reviews: unknown }> {
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

  /**
   * Plan của user.
   */
  async listPlansForUser(actorId: string, userId: string): Promise<PlanRow[]> {
    if (actorId !== userId) {
      await this.evaluator.requireCapability(actorId, 'moodle/competency:planview', await this.systemCtx());
    }
    return this.repo.listPlansForUser(userId);
  }

  private async planTransition(actorId: string, planId: string, action: 'activate' | 'request-review' | 'cancel-review' | 'start-review' | 'stop-review' | 'approve' | 'unapprove' | 'complete',
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
        subject: this.i18n.t('platform.planReviewRequestedSubject', { args: { name: plan.name } }),
        body: this.i18n.t('platform.planReviewRequestedBody', { args: { userId: plan.userid, planId: plan.id } }),
        contextUrl: `/competencies/plans/${plan.id}`,
      }).catch(() => undefined);
    }
    await this.outbox.enqueueStandalone({
      aggregate: 'competency', type: `competency_plan_${action.replace('-', '_')}`,
      payload: { planId, userId: plan.userid, from, to },
    });
    return (await this.repo.getPlan(planId))!;
  }

  /**
   * Kích hoạt plan (draft → active).
   */
  async activatePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'activate'); }
  /**
   * Gửi plan đi duyệt (notification nội dung lấy từ catalog i18n).
   */
  async requestPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'request-review'); }
  /**
   * Huỷ yêu cầu duyệt plan.
   */
  async cancelPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'cancel-review'); }
  /**
   * Reviewer bắt đầu duyệt plan.
   */
  async startPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'start-review'); }
  /**
   * Dừng vòng duyệt plan.
   */
  async stopPlanReview(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'stop-review'); }
  /**
   * Duyệt plan.
   */
  async approvePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'approve'); }
  /**
   * Gỡ duyệt plan.
   */
  async unapprovePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'unapprove'); }
  /**
   * Hoàn tất plan.
   */
  async completePlan(actorId: string, planId: string): Promise<PlanRow> { return this.planTransition(actorId, planId, 'complete'); }

  /** Forbidden import guard: plan owners may not review their own plans. */
  /**
   * Chặn tự duyệt: reviewer phải khác chủ plan/usercomp.
   */
  async assertNotSelfReview(actorId: string, userId: string): Promise<void> {
    if (actorId === userId) throw new ForbiddenException({ message: 'You cannot review your own competencies', code: 'competency.self_review' });
  }
}
