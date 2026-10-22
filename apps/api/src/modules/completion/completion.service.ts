import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { AvailabilityService } from '../availability/availability.service';
import { CoursesService } from '../courses/courses.service';
import { EnrolService } from '../enrol/enrol.service';
import { CompletionRepository, type CourseCompletionRow } from './completion.repository';

export const COMPLETION_INCOMPLETE = 0;
export const COMPLETION_COMPLETE = 1;
export const COMPLETION_COMPLETE_PASS = 2;
export const COMPLETION_COMPLETE_FAIL = 3;
export const COMPLETION_QUEUE = 'completion-recalculate';
export const AGGREGATION_ALL = 1;
export const AGGREGATION_ANY = 2;

/**
 * CompletionModule facade (Moodle core_completion), activity part (P2):
 *  - Completion state is STORED data (course_modules_completion) driven by
 *    criteria declared up-front on the cm: completionview, completionmanual,
 *    completionexpected, completionusegrade (declared; grade evaluation is
 *    the P3 hook — a cm requiring a grade cannot complete in P2).
 *  - `cm_viewed` events (from CoursesService) drive completionview.
 *  - Course completion aggregates criteria (module completions + date)
 *    with the course method ALL(AND)/ANY(OR) into course_completions.
 *  - Changing criteria after data exists flags reaggregation and enqueues
 *    the worker's completion-recalculate job (controlled recalculation,
 *    report §2#9) — never a silent in-place rewrite.
 */
@Injectable()
export class CompletionService implements OnModuleInit {
  private readonly logger = new Logger(CompletionService.name);
  /** Registered by GradesModule (P3): cm grade state (0 incomplete / 1 complete / 2 pass / 3 fail), null = no grade yet. */
  private gradeEvaluator?: (cmId: number, userId: number) => Promise<number | null>;
  /** Registered by GradesModule (P3): course 'grade' criterion check. */
  private courseGradeChecker?: (courseId: number, userId: number) => Promise<boolean>;

  registerGradeEvaluator(fn: (cmId: number, userId: number) => Promise<number | null>): void {
    this.gradeEvaluator = fn;
  }
  registerCourseGradeChecker(fn: (courseId: number, userId: number) => Promise<boolean>): void {
    this.courseGradeChecker = fn;
  }

  constructor(
    private readonly repo: CompletionRepository,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
    private readonly evaluator: PermissionEvaluator,
    private readonly availability: AvailabilityService,
    private readonly outbox: OutboxService,
    @InjectQueue(COMPLETION_QUEUE) private readonly recalcQueue: Queue,
  ) {}

  onModuleInit(): void {
    // Availability 'completion' leaf: complete when the referenced cm's
    // stored state for this user is COMPLETE (or pass/fail in P3).
    this.availability.register('completion', async (leaf, ctx) => {
      const cmId = Number(leaf.id ?? leaf.cmid ?? leaf.cm ?? 0);
      if (!cmId) return { available: false, description: 'Completion condition without cm id' };
      const row = await this.repo.getCmCompletion(cmId, ctx.userId);
      const state = Number(leaf.state ?? COMPLETION_COMPLETE);
      const available = !!row && row.completionstate >= state && row.completionstate !== COMPLETION_INCOMPLETE;
      return { available, description: `Activity ${cmId} must be complete` };
    });
    // Enrol unenrol probe: completion records are related data that must survive unenrol.
    this.enrol.registerRelatedDataProbe(async (courseId, userId) => {
      const cms = await this.courses.listCms(courseId);
      return this.repo.hasAnyCmCompletion(userId, cms.map((c) => c.id));
    });
  }

  // --- activity completion ---------------------------------------------------

  /** Internal state computation from the cm's declared criteria (Moodle completionlib internal_get_state, P2 subset). */
  async computeCmState(cmId: number, userId: number): Promise<number> {
    const cm = await this.courses.getCm(cmId);
    const row = await this.repo.getCmCompletion(cmId, userId);
    if (cm.completion === 0) return row?.completionstate ?? COMPLETION_INCOMPLETE;
    if (cm.completionmanual || cm.completion === 1) {
      return row?.completionstate ?? COMPLETION_INCOMPLETE;
    }
    // Automatic (completion=2): every declared criterion must hold.
    let gradeState: number | null = null;
    if (cm.completionusegrade) {
      // P3: real grade evaluation through the GradesModule-registered evaluator.
      gradeState = this.gradeEvaluator ? await this.gradeEvaluator(cmId, userId) : null;
      if (gradeState === null) return COMPLETION_INCOMPLETE; // no grade yet
      if (gradeState === COMPLETION_COMPLETE_FAIL) return COMPLETION_COMPLETE_FAIL;
    }
    if (cm.completionview && !row?.viewed) return COMPLETION_INCOMPLETE;
    if (cm.completionexpected && new Date() < cm.completionexpected) return COMPLETION_INCOMPLETE;
    if (gradeState !== null) return gradeState; // 2 (pass) or 1 (graded, no pass mark)
    const anyCriterion = cm.completionview || !!cm.completionexpected;
    return anyCriterion ? COMPLETION_COMPLETE : (row?.completionstate ?? COMPLETION_INCOMPLETE);
  }

  /**
   * Called by GradesModule after a regrade (facade call): recompute the
   * stored completion state of a grade-driven cm and reaggregate the course.
   * Emits cm_completion_changed through the outbox when the state moves.
   */
  async refreshGradeCompletion(cmId: number, userId: number): Promise<void> {
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (!cm || cm.completion === 0 || !cm.completionusegrade) return;
    const state = await this.computeCmState(cmId, userId);
    const existing = await this.repo.getCmCompletion(cmId, userId);
    if (existing && existing.completionstate === state) return;
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.upsertCmCompletion({
        coursemoduleid: cmId, userid: userId, completionstate: state,
        viewed: existing?.viewed ?? false, overrideby: existing?.overrideby ?? null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'completion', type: 'cm_completion_changed',
        payload: { cmId, courseId: cm.course, userId, state, via: 'grade' },
      });
    });
    await this.reaggregateCourseCompletion(userId, cm.course);
  }

  private async refreshCmState(cmId: number, userId: number): Promise<number> {
    const state = await this.computeCmState(cmId, userId);
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (cm && cm.completion !== 0) {
      const existing = await this.repo.getCmCompletion(cmId, userId);
      // Manual marks are authoritative until toggled; only auto-refresh non-manual cms or view-only updates.
      if (!cm.completionmanual) {
        await this.repo.upsertCmCompletion({ coursemoduleid: cmId, userid: userId, completionstate: state, viewed: existing?.viewed ?? false, overrideby: existing?.overrideby ?? null });
      }
    }
    return state;
  }

  @OnEvent('cm_viewed')
  async onCmViewed(payload: { cmId: number; courseId: number; userId: number }): Promise<void> {
    const cm = await this.courses.getCm(payload.cmId).catch(() => undefined);
    if (!cm || cm.completion === 0) return;
    const existing = await this.repo.getCmCompletion(payload.cmId, payload.userId);
    await this.repo.upsertCmCompletion({
      coursemoduleid: payload.cmId, userid: payload.userId,
      completionstate: existing?.completionstate ?? COMPLETION_INCOMPLETE,
      viewed: true, overrideby: existing?.overrideby ?? null,
    });
    await this.refreshCmState(payload.cmId, payload.userId);
    await this.reaggregateCourseCompletion(payload.userId, payload.courseId);
  }

  /** cm_deleted cleanup owned by this module: all completion records for the cm go away with it. */
  @OnEvent('cm_deleted')
  async onCmDeleted(payload: { cmId: number; courseId: number }): Promise<void> {
    const removed = await this.repo.deleteCmCompletionsForCm(payload.cmId);
    if (removed) this.logger.log(`cm_deleted: removed ${removed} completion record(s) for cm ${payload.cmId}`);
  }

  async getCmCompletion(cmId: number, userId: number): Promise<{ cmId: number; userId: number; state: number; viewed: boolean }> {
    const row = await this.repo.getCmCompletion(cmId, userId);
    const state = await this.computeCmState(cmId, userId).catch(() => row?.completionstate ?? 0);
    return { cmId, userId, state: row && row.completionstate !== COMPLETION_INCOMPLETE ? row.completionstate : state, viewed: row?.viewed ?? false };
  }

  async listCmCompletionsForCourse(courseId: number, userId: number): Promise<{ cmId: number; state: number; viewed: boolean }[]> {
    const cms = await this.courses.listCms(courseId);
    const rows = await this.repo.listCmCompletionsForUser(userId, cms.map((c) => c.id));
    return cms.map((cm) => {
      const row = rows.find((r) => r.coursemoduleid === cm.id);
      return { cmId: cm.id, state: row?.completionstate ?? COMPLETION_INCOMPLETE, viewed: row?.viewed ?? false };
    });
  }

  /**
   * Manual marking (completionmanual / completion=1): the user themselves,
   * or an actor with lms/completion:markothers at the course context.
   */
  async markManual(actorId: number, cmId: number, targetUserId: number, complete: boolean): Promise<{ cmId: number; userId: number; state: number }> {
    const cm = await this.courses.getCm(cmId);
    if (cm.completion === 0) throw new BadRequestException({ message: 'Completion tracking is not enabled for this activity', code: 'completion.not_enabled' });
    if (!cm.completionmanual && cm.completion !== 1) {
      throw new BadRequestException({ message: 'This activity does not use manual completion', code: 'completion.not_manual' });
    }
    if (actorId !== targetUserId) {
      await this.evaluator.requireCapability(actorId, 'lms/completion:markothers', await this.courses.courseContextId(cm.course));
    } else {
      await this.courses.assertCourseAccess(actorId, cm.course);
    }
    const existing = await this.repo.getCmCompletion(cmId, targetUserId);
    const state = complete ? COMPLETION_COMPLETE : COMPLETION_INCOMPLETE;
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.upsertCmCompletion({
        coursemoduleid: cmId, userid: targetUserId, completionstate: state,
        viewed: existing?.viewed ?? false, overrideby: actorId !== targetUserId ? actorId : null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'completion', type: 'cm_completion_changed',
        payload: { cmId, courseId: cm.course, userId: targetUserId, state, manual: true },
      });
    });
    await this.reaggregateCourseCompletion(targetUserId, cm.course);
    return { cmId, userId: targetUserId, state };
  }

  // --- course completion ---------------------------------------------------------

  async setCriteria(actorId: number, courseId: number, input: {
    method?: number;
    criteria: { criteriatype: string; moduleinstance?: number; date?: string }[];
  }): Promise<{ method: number; criteria: unknown[] }> {
    await this.courses.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'lms/completion:manage', await this.courses.courseContextId(courseId));
    const method = input.method ?? AGGREGATION_ALL;
    if (![AGGREGATION_ALL, AGGREGATION_ANY].includes(method)) {
      throw new BadRequestException({ message: `Unknown aggregation method ${method}`, code: 'completion.bad_method' });
    }
    for (const c of input.criteria) {
      if (!['module', 'date', 'grade'].includes(c.criteriatype)) {
        throw new BadRequestException({ message: `Unknown criteria type ${c.criteriatype}`, code: 'completion.bad_criteria_type' });
      }
      if (c.criteriatype === 'module' && !c.moduleinstance) {
        throw new BadRequestException({ message: 'Module criteria require moduleinstance (a cm id)', code: 'completion.criteria_cm_required' });
      }
      if (c.criteriatype === 'date' && !c.date) {
        throw new BadRequestException({ message: 'Date criteria require a date', code: 'completion.criteria_date_required' });
      }
    }
    const existing = await this.repo.listCriteria(courseId);
    const hadData = (await this.repo.listCourseCompletions(courseId)).length > 0;
    for (const old of existing) await this.repo.deleteCriteria(old.id);
    let sortorder = 0;
    for (const c of input.criteria) {
      await this.repo.insertCriteria({
        course: courseId, criteriatype: c.criteriatype,
        moduleinstance: c.moduleinstance ?? null,
        date: c.date ? new Date(c.date) : null, sortorder: sortorder++,
      });
    }
    await this.repo.setSettings(courseId, method);
    if (hadData || existing.length) {
      // Criteria changed after data exists ⇒ controlled reaggregation:
      // flag every stored completion for recalculation and enqueue the worker job.
      const completions = await this.repo.listCourseCompletions(courseId);
      for (const cc of completions) {
        await this.repo.upsertCourseCompletion({ ...cc, reaggregate: new Date() });
      }
      await this.recalcQueue.add('recalculate', { courseId }, { jobId: `completion-recalc-${courseId}-${Date.now()}`, attempts: 3 });
      await this.outbox.enqueueStandalone({ aggregate: 'completion', type: 'completion_criteria_changed', payload: { courseId, reaggregate: true } });
    }
    return { method, criteria: await this.repo.listCriteria(courseId) };
  }

  async getCriteria(courseId: number): Promise<{ method: number; criteria: unknown[] }> {
    const settings = await this.repo.getSettings(courseId);
    return { method: settings.method, criteria: await this.repo.listCriteria(courseId) };
  }

  /** Evaluate every criterion for a user. Returns per-criterion results + aggregate. */
  async evaluateCriteria(courseId: number, userId: number, now = new Date()): Promise<{ results: boolean[]; complete: boolean; method: number }> {
    const criteria = await this.repo.listCriteria(courseId);
    const { method } = await this.repo.getSettings(courseId);
    const results: boolean[] = [];
    for (const c of criteria) {
      if (c.criteriatype === 'module' && c.moduleinstance) {
        const row = await this.repo.getCmCompletion(c.moduleinstance, userId);
        results.push(!!row && row.completionstate !== COMPLETION_INCOMPLETE);
      } else if (c.criteriatype === 'date' && c.date) {
        results.push(now >= c.date);
      } else if (c.criteriatype === 'grade') {
        // P3: course grade criterion via the GradesModule-registered checker.
        results.push(this.courseGradeChecker ? await this.courseGradeChecker(courseId, userId) : false);
      } else {
        results.push(false);
      }
    }
    const complete = criteria.length === 0 ? false
      : method === AGGREGATION_ANY ? results.some(Boolean) : results.every(Boolean);
    return { results, complete, method };
  }

  /** Recompute and store one user's course completion from the current criteria (idempotent). */
  async reaggregateCourseCompletion(userId: number, courseId: number): Promise<CourseCompletionRow> {
    const existing = await this.repo.getCourseCompletion(userId, courseId);
    const { complete } = await this.evaluateCriteria(courseId, userId);
    const criteria = await this.repo.listCriteria(courseId);
    let status = existing?.status ?? 'not_started';
    if (complete) status = 'complete';
    else if (criteria.length && (existing?.timestarted || (await this.hasStarted(userId, courseId)))) status = 'in_progress';
    const row = await this.repo.upsertCourseCompletion({
      userid: userId, course: courseId, status,
      timeenrolled: existing?.timeenrolled ?? new Date(),
      timestarted: status === 'not_started' ? null : (existing?.timestarted ?? new Date()),
      timecompleted: complete ? (existing?.timecompleted ?? new Date()) : null,
    });
    return row;
  }
  private async hasStarted(userId: number, courseId: number): Promise<boolean> {
    const cms = await this.courses.listCms(courseId);
    return this.repo.hasAnyCmCompletion(userId, cms.map((c) => c.id));
  }

  /** Worker-facing bulk recalculation (the worker runs its own copy; this is the API-side twin used by tests/manual triggers). */
  async recalculateCourse(courseId: number): Promise<{ courseId: number; users: number }> {
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userid))];
    // Also include users who already have a stored course completion.
    for (const cc of await this.repo.listCourseCompletions(courseId)) {
      if (!userIds.includes(cc.userid)) userIds.push(cc.userid);
    }
    for (const userId of userIds) await this.reaggregateCourseCompletion(userId, courseId);
    return { courseId, users: userIds.length };
  }

  async getCourseCompletion(userId: number, courseId: number): Promise<CourseCompletionRow> {
    const existing = await this.repo.getCourseCompletion(userId, courseId);
    if (existing) return existing;
    return this.reaggregateCourseCompletion(userId, courseId);
  }
  async listCourseCompletions(courseId: number): Promise<CourseCompletionRow[]> {
    return this.repo.listCourseCompletions(courseId);
  }

  async requireCompletionManage(actorId: number, courseId: number): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'lms/completion:manage', await this.courses.courseContextId(courseId));
  }
  notFound(): never { throw new NotFoundException({ message: 'Completion record not found', code: 'completion.not_found' }); }
  forbidden(msg: string): never { throw new ForbiddenException({ message: msg, code: 'completion.forbidden' }); }
}
