import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { I18nService } from '@nestjs/i18n';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { AvailabilityService } from '../availability/availability.service';
import { CoursesService } from '../courses/courses.service';
import { ENROL_WITHDRAWN, EnrolService } from '../enrol/enrol.service';
import { CompletionRepository, type CourseCompletionRow } from './completion.repository';

export const COMPLETION_INCOMPLETE = 0;
export const COMPLETION_COMPLETE = 1;
export const COMPLETION_COMPLETE_PASS = 2;
export const COMPLETION_COMPLETE_FAIL = 3;
export const COMPLETION_QUEUE = 'completion-recalculate';
export const AGGREGATION_ALL = 1;
export const AGGREGATION_ANY = 2;

/**
 * CompletionModule facade (Moodle core_completion), activity part:
 *  - Completion state is STORED data (course_modules_completion) driven by
 *    criteria declared up-front on the cm: completionView, completionManual,
 *    completionExpected, completionUseGrade (declared; grade evaluation is
 *    the Grades hook — a cm requiring a grade cannot complete without one).
 *  - `cm_viewed` events (from CoursesService) drive completionView.
 *  - Course completion aggregates criteria — all 8 Moodle types: module,
 *    date, grade, self, course (prerequisite), duration, role, unenrol —
 *    with the course method ALL(AND)/ANY(OR) into course_completions.
 *    Manual types (self, role) are evidenced by course_completion_crit_compl
 *    rows; the rest are evaluated from live data. Re-evaluation triggers:
 *    cm events, grade refresh, self/role marks, unenrol (Enrol hook), a
 *    prerequisite course flipping to complete (dependent reaggregation),
 *    criteria changes and explicit/bulk recalculation (date/duration are
 *    time-based and take effect on the next reaggregation, like Moodle's
 *    cron-driven aggregation).
 *  - Changing criteria after data exists flags reaggregation and enqueues
 *    the worker's completion-recalculate job (controlled recalculation,
 *    report §2#9) — never a silent in-place rewrite.
 */
@Injectable()
/**
 * Nghiệp vụ hoàn thành (completion tracking).
 * Đối chiếu Moodle: lib/completionlib.php (completion_info).
 * Trạng thái cm: incomplete / complete / complete-pass / complete-fail, suy từ điều kiện đã cấu hình
 * (xem, đạt điểm, hoàn thành thủ công, ngày…). Hoàn thành khoá học được tổng hợp từ bộ tiêu chí (criteria)
 * và trạng thái được tính lại qua hàng đợi khi có sự kiện điểm/lượt xem.
 */
export class CompletionService implements OnModuleInit {
  private readonly logger = new Logger(CompletionService.name);
  /** Registered by GradesModule: cm grade state (0 incomplete / 1 complete / 2 pass / 3 fail), null = no grade yet. */
  private gradeEvaluator?: (cmId: string, userId: string) => Promise<number | null>;
  /** Registered by GradesModule: course 'grade' criterion check. */
  private courseGradeChecker?: (courseId: string, userId: string) => Promise<boolean>;

  /**
   * Đăng ký evaluator điểm cho điều kiện hoàn thành theo điểm (module grades cắm vào).
   */
  registerGradeEvaluator(fn: (cmId: string, userId: string) => Promise<number | null>): void {
    this.gradeEvaluator = fn;
  }

  /**
   * Downstream hooks: modules (Badges, Competencies) register interest in
   * completion CHANGES instead of polling or reading this module's tables
   * (report §2#9: completion is an INPUT to badges/competency — consumers
   * subscribe, they never re-derive completion themselves).
   */
  private readonly cmCompletionHooks: ((e: { cmId: string; courseId: string; userId: string; state: number }) => Promise<void>)[] = [];
  private readonly courseCompletionHooks: ((e: { courseId: string; userId: string }) => Promise<void>)[] = [];
  /**
   * Đăng ký hook chạy sau khi trạng thái cm thay đổi (badges/competencies lắng nghe).
   */
  registerCmCompletionHook(fn: (e: { cmId: string; courseId: string; userId: string; state: number }) => Promise<void>): void {
    this.cmCompletionHooks.push(fn);
  }
  /**
   * Đăng ký hook chạy sau khi hoàn thành khoá học thay đổi.
   */
  registerCourseCompletionHook(fn: (e: { courseId: string; userId: string }) => Promise<void>): void {
    this.courseCompletionHooks.push(fn);
  }
  private async fireCmCompletion(cmId: string, courseId: string, userId: string, state: number): Promise<void> {
    if (state === COMPLETION_INCOMPLETE) return;
    for (const hook of this.cmCompletionHooks) {
      await hook({ cmId, courseId, userId, state }).catch((err) => this.logger.warn(`cm completion hook failed: ${String(err)}`));
    }
  }
  /**
   * Đăng ký hàm kiểm tra điểm khoá học đạt ngưỡng (cho tiêu chí theo điểm tổng).
   */
  registerCourseGradeChecker(fn: (courseId: string, userId: string) => Promise<boolean>): void {
    this.courseGradeChecker = fn;
  }

  constructor(
    private readonly repo: CompletionRepository,
    private readonly courses: CoursesService,
    private readonly enrol: EnrolService,
    private readonly roles: RolesService,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly availability: AvailabilityService,
    private readonly outbox: OutboxService,
    private readonly i18n: I18nService,
    @InjectQueue(COMPLETION_QUEUE) private readonly recalcQueue: Queue,
  ) {}

  /**
   * Khởi tạo: nối các hook liên module.
   */
  onModuleInit(): void {
    // Availability 'completion' leaf: complete when the referenced cm's
    // stored state for this user is COMPLETE (or pass/fail once graded).
    this.availability.register('completion', async (leaf, ctx) => {
      const cmId = String(leaf.id ?? leaf.cmid ?? leaf.cm ?? '');
      if (!cmId) return { available: false, description: this.i18n.t('availability.completionMissingCm') };
      const row = await this.repo.getCmCompletion(cmId, ctx.userId);
      const state = Number(leaf.state ?? COMPLETION_COMPLETE);
      const available = !!row && row.completionState >= state && row.completionState !== COMPLETION_INCOMPLETE;
      return { available, description: this.i18n.t('availability.activityMustComplete', { args: { cmId } }) };
    });
    // Enrol unenrol probe: completion records are related data that must survive unenrol.
    this.enrol.registerRelatedDataProbe(async (courseId, userId) => {
      const cms = await this.courses.listCms(courseId);
      return this.repo.hasAnyCmCompletion(userId, cms.map((c) => c.id));
    });
    // Unenrol trigger: leaving a course can itself complete it (Moodle
    // 'unenrol' criterion), so re-evaluate that user right away.
    this.enrol.registerUnenrolHook(async ({ courseId, userId }) => {
      await this.reaggregateCourseCompletion(userId, courseId);
    });
  }

  // --- activity completion ---------------------------------------------------

  /** Internal state computation from the cm's declared criteria (Moodle completionlib internal_get_state, activity subset). */
  /**
   * Tính trạng thái hoàn thành của một cm cho user từ các điều kiện đã cấu hình.
   */
  async computeCmState(cmId: string, userId: string): Promise<number> {
    const cm = await this.courses.getCm(cmId);
    const row = await this.repo.getCmCompletion(cmId, userId);
    if (cm.completion === 0) return row?.completionState ?? COMPLETION_INCOMPLETE;
    if (cm.completionManual || cm.completion === 1) {
      return row?.completionState ?? COMPLETION_INCOMPLETE;
    }
    // Automatic (completion=2): every declared criterion must hold.
    let gradeState: number | null = null;
    if (cm.completionUseGrade) {
      // Grades: real grade evaluation through the GradesModule-registered evaluator.
      gradeState = this.gradeEvaluator ? await this.gradeEvaluator(cmId, userId) : null;
      if (gradeState === null) return COMPLETION_INCOMPLETE; // no grade yet
      if (gradeState === COMPLETION_COMPLETE_FAIL) return COMPLETION_COMPLETE_FAIL;
    }
    if (cm.completionView && !row?.viewed) return COMPLETION_INCOMPLETE;
    if (cm.completionExpected && new Date() < cm.completionExpected) return COMPLETION_INCOMPLETE;
    if (gradeState !== null) return gradeState; // 2 (pass) or 1 (graded, no pass mark)
    const anyCriterion = cm.completionView || !!cm.completionExpected;
    return anyCriterion ? COMPLETION_COMPLETE : (row?.completionState ?? COMPLETION_INCOMPLETE);
  }

  /**
   * Called by GradesModule after a regrade (facade call): recompute the
   * stored completion state of a grade-driven cm and reAggregate the course.
   * Emits cm_completion_changed through the outbox when the state moves.
   */
  /**
   * Tính lại completion theo điểm của cm sau khi điểm thay đổi.
   */
  async refreshGradeCompletion(cmId: string, userId: string): Promise<void> {
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (!cm || cm.completion === 0 || !cm.completionUseGrade) return;
    const state = await this.computeCmState(cmId, userId);
    const existing = await this.repo.getCmCompletion(cmId, userId);
    if (existing && existing.completionState === state) return;
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.upsertCmCompletion({
        courseModuleId: cmId, userId: userId, completionState: state,
        viewed: existing?.viewed ?? false, overrideBy: existing?.overrideBy ?? null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'completion', type: 'cm_completion_changed',
        payload: { cmId, courseId: cm.course, userId, state, via: 'grade' },
      });
    });
    await this.fireCmCompletion(cmId, cm.course, userId, state);
    await this.reaggregateCourseCompletion(userId, cm.course);
  }

  private async refreshCmState(cmId: string, userId: string): Promise<number> {
    const state = await this.computeCmState(cmId, userId);
    const cm = await this.courses.getCm(cmId).catch(() => undefined);
    if (cm && cm.completion !== 0) {
      const existing = await this.repo.getCmCompletion(cmId, userId);
      // Manual marks are authoritative until toggled; only auto-refresh non-manual cms or view-only updates.
      if (!cm.completionManual) {
        await this.repo.upsertCmCompletion({ courseModuleId: cmId, userId: userId, completionState: state, viewed: existing?.viewed ?? false, overrideBy: existing?.overrideBy ?? null });
      }
    }
    return state;
  }

  @OnEvent('cm_viewed')
  /**
   * Xử lý sự kiện xem cm: cập nhật completion theo lượt xem nếu cm cấu hình điều kiện view.
   */
  async onCmViewed(payload: { cmId: string; courseId: string; userId: string }): Promise<void> {
    const cm = await this.courses.getCm(payload.cmId).catch(() => undefined);
    if (!cm || cm.completion === 0) return;
    const existing = await this.repo.getCmCompletion(payload.cmId, payload.userId);
    await this.repo.upsertCmCompletion({
      courseModuleId: payload.cmId, userId: payload.userId,
      completionState: existing?.completionState ?? COMPLETION_INCOMPLETE,
      viewed: true, overrideBy: existing?.overrideBy ?? null,
    });
    const state = await this.refreshCmState(payload.cmId, payload.userId);
    await this.fireCmCompletion(payload.cmId, payload.courseId, payload.userId, state);
    await this.reaggregateCourseCompletion(payload.userId, payload.courseId);
  }

  /** cm_deleted cleanup owned by this module: all completion records for the cm go away with it. */
  @OnEvent('cm_deleted')
  /**
   * Xử lý sự kiện xoá cm: dọn trạng thái hoàn thành của cm.
   */
  async onCmDeleted(payload: { cmId: string; courseId: string }): Promise<void> {
    const removed = await this.repo.deleteCmCompletionsForCm(payload.cmId);
    if (removed) this.logger.log(`cm_deleted: removed ${removed} completion record(s) for cm ${payload.cmId}`);
  }

  /**
   * Trạng thái hoàn thành hiện tại của cm cho user.
   */
  async getCmCompletion(cmId: string, userId: string): Promise<{ cmId: string; userId: string; state: number; viewed: boolean }> {
    const row = await this.repo.getCmCompletion(cmId, userId);
    const state = await this.computeCmState(cmId, userId).catch(() => row?.completionState ?? 0);
    return { cmId, userId, state: row && row.completionState !== COMPLETION_INCOMPLETE ? row.completionState : state, viewed: row?.viewed ?? false };
  }

  /**
   * Tiến độ hoàn thành cm của mọi học viên trong khoá học.
   */
  async listCmCompletionsForCourse(courseId: string, userId: string): Promise<{ cmId: string; state: number; viewed: boolean }[]> {
    const cms = await this.courses.listCms(courseId);
    const rows = await this.repo.listCmCompletionsForUser(userId, cms.map((c) => c.id));
    return cms.map((cm) => {
      const row = rows.find((r) => r.courseModuleId === cm.id);
      return { cmId: cm.id, state: row?.completionState ?? COMPLETION_INCOMPLETE, viewed: row?.viewed ?? false };
    });
  }

  /**
   * Manual marking (completionManual / completion=1): the user themselves,
   * or an actor with lms/completion:markothers at the course context.
   */
  /**
   * Đánh dấu hoàn thành thủ công (self hoặc giáo viên ghi thay theo capability).
   */
  async markManual(actorId: string, cmId: string, targetUserId: string, complete: boolean): Promise<{ cmId: string; userId: string; state: number }> {
    const cm = await this.courses.getCm(cmId);
    if (cm.completion === 0) throw new BadRequestException({ message: 'Completion tracking is not enabled for this activity', code: 'completion.not_enabled' });
    if (!cm.completionManual && cm.completion !== 1) {
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
        courseModuleId: cmId, userId: targetUserId, completionState: state,
        viewed: existing?.viewed ?? false, overrideBy: actorId !== targetUserId ? actorId : null,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'completion', type: 'cm_completion_changed',
        payload: { cmId, courseId: cm.course, userId: targetUserId, state, manual: true },
      });
    });
    await this.fireCmCompletion(cmId, cm.course, targetUserId, state);
    await this.reaggregateCourseCompletion(targetUserId, cm.course);
    return { cmId, userId: targetUserId, state };
  }

  // --- course completion ---------------------------------------------------------

  /**
   * Đặt bộ tiêu chí hoàn thành khoá học (thay thế toàn bộ). Đủ 8 loại của
   * Moodle; tham số bắt buộc theo từng loại được kiểm tại đây (module →
   * moduleInstance, date → date, course → courseInstance trỏ tới khoá khác
   * có thật, duration → enrolPeriodDays, role → roleId có thật; self,
   * grade, unenrol không tham số).
   */
  async setCriteria(actorId: string, courseId: string, input: {
    method?: number;
    criteria: {
      criteriaType: string; moduleInstance?: string; date?: string;
      courseInstance?: string; enrolPeriodDays?: number; roleId?: string;
    }[];
  }): Promise<{ method: number; criteria: unknown[] }> {
    await this.courses.getCourse(courseId);
    await this.evaluator.requireCapability(actorId, 'lms/completion:manage', await this.courses.courseContextId(courseId));
    const method = input.method ?? AGGREGATION_ALL;
    if (![AGGREGATION_ALL, AGGREGATION_ANY].includes(method)) {
      throw new BadRequestException({ message: `Unknown aggregation method ${method}`, code: 'completion.bad_method' });
    }
    for (const c of input.criteria) {
      if (!['module', 'date', 'grade', 'self', 'course', 'duration', 'role', 'unenrol'].includes(c.criteriaType)) {
        throw new BadRequestException({ message: `Unknown criteria type ${c.criteriaType}`, code: 'completion.bad_criteria_type' });
      }
      if (c.criteriaType === 'module' && !c.moduleInstance) {
        throw new BadRequestException({ message: 'Module criteria require moduleInstance (a cm id)', code: 'completion.criteria_cm_required' });
      }
      if (c.criteriaType === 'date' && !c.date) {
        throw new BadRequestException({ message: 'Date criteria require a date', code: 'completion.criteria_date_required' });
      }
      if (c.criteriaType === 'course') {
        if (!c.courseInstance) {
          throw new BadRequestException({ message: 'Course criteria require courseInstance (the prerequisite course id)', code: 'completion.criteria_course_required' });
        }
        if (c.courseInstance === courseId) {
          throw new BadRequestException({ message: 'A course cannot be its own completion prerequisite', code: 'completion.criteria_course_self_reference' });
        }
        await this.courses.getCourse(c.courseInstance).catch(() => {
          throw new BadRequestException({ message: `Prerequisite course ${c.courseInstance} does not exist`, code: 'completion.criteria_course_not_found' });
        });
      }
      if (c.criteriaType === 'duration' && (c.enrolPeriodDays === undefined || c.enrolPeriodDays === null)) {
        throw new BadRequestException({ message: 'Duration criteria require enrolPeriodDays (days after enrolment)', code: 'completion.criteria_duration_required' });
      }
      if (c.criteriaType === 'role') {
        if (!c.roleId) {
          throw new BadRequestException({ message: 'Role criteria require roleId (the role allowed to mark completion)', code: 'completion.criteria_role_required' });
        }
        await this.roles.getRole(c.roleId).catch(() => {
          throw new BadRequestException({ message: `Role ${c.roleId} does not exist`, code: 'completion.criteria_role_not_found' });
        });
      }
    }
    const existing = await this.repo.listCriteria(courseId);
    const hadData = (await this.repo.listCourseCompletions(courseId)).length > 0;
    for (const old of existing) await this.repo.deleteCriteria(old.id);
    let sortOrder = 0;
    for (const c of input.criteria) {
      await this.repo.insertCriteria({
        course: courseId, criteriaType: c.criteriaType,
        moduleInstance: c.moduleInstance ?? null,
        date: c.date ? new Date(c.date) : null,
        courseInstance: c.courseInstance ?? null,
        enrolPeriodDays: c.enrolPeriodDays ?? null,
        roleId: c.roleId ?? null,
        sortOrder: sortOrder++,
      });
    }
    await this.repo.setSettings(courseId, method);
    if (hadData || existing.length) {
      // Criteria changed after data exists ⇒ controlled reaggregation:
      // flag every stored completion for recalculation and enqueue the worker job.
      const completions = await this.repo.listCourseCompletions(courseId);
      for (const cc of completions) {
        await this.repo.upsertCourseCompletion({ ...cc, reAggregate: new Date() });
      }
      await this.recalcQueue.add('recalculate', { courseId }, { jobId: `completion-recalc-${courseId}-${Date.now()}`, attempts: 3 });
      await this.outbox.enqueueStandalone({ aggregate: 'completion', type: 'completion_criteria_changed', payload: { courseId, reAggregate: true } });
    }
    return { method, criteria: await this.repo.listCriteria(courseId) };
  }

  /**
   * Bộ tiêu chí hiện tại của khoá học.
   */
  async getCriteria(courseId: string): Promise<{ method: number; criteria: unknown[] }> {
    const settings = await this.repo.getSettings(courseId);
    return { method: settings.method, criteria: await this.repo.listCriteria(courseId) };
  }

  /** Evaluate every criterion for a user. Returns per-criterion results + aggregate. */
  /**
   * Đánh giá bộ tiêu chí cho một user: đạt tất cả/bất kỳ theo cấu hình tổng hợp.
   * Ngữ nghĩa từng loại theo Moodle: module = cm đã hoàn thành; date = đã tới
   * ngày; grade = qua checker của Grades; self/role = có dấu crit_compl;
   * course = bản ghi hoàn thành của khoá tiên quyết ở trạng thái complete;
   * duration = đã ghi danh đủ số ngày (neo vào timeStart ghi danh sớm nhất
   * chưa rút); unenrol = user hiện không còn ghi danh trong khoá.
   */
  async evaluateCriteria(courseId: string, userId: string, now = new Date()): Promise<{ results: boolean[]; complete: boolean; method: number }> {
    const criteria = await this.repo.listCriteria(courseId);
    const { method } = await this.repo.getSettings(courseId);
    // Manual criteria (self/role) evidence: load the user's crit_compl marks once.
    const manualIds = criteria.filter((c) => c.criteriaType === 'self' || c.criteriaType === 'role').map((c) => c.id);
    const marks = manualIds.length ? await this.repo.listCritComplForUser(manualIds, userId) : [];
    const markedCriteria = new Set(marks.map((m) => m.criteriaId));
    // Duration anchor: earliest enrolment start among the user's live
    // (not withdrawn) enrolments in this course; loaded at most once.
    const needsEnrolments = criteria.some((c) => c.criteriaType === 'duration');
    const enrolments = needsEnrolments ? await this.enrol.listEnrolmentsForCourse(courseId) : [];
    const enrolAnchor = enrolments
      .filter((e) => e.userId === userId && e.status !== ENROL_WITHDRAWN)
      .reduce<Date | null>((min, e) => (min === null || e.timeStart < min ? e.timeStart : min), null);
    const results: boolean[] = [];
    for (const c of criteria) {
      if (c.criteriaType === 'module' && c.moduleInstance) {
        const row = await this.repo.getCmCompletion(c.moduleInstance, userId);
        results.push(!!row && row.completionState !== COMPLETION_INCOMPLETE);
      } else if (c.criteriaType === 'date' && c.date) {
        results.push(now >= c.date);
      } else if (c.criteriaType === 'grade') {
        // Grades: course grade criterion via the GradesModule-registered checker.
        results.push(this.courseGradeChecker ? await this.courseGradeChecker(courseId, userId) : false);
      } else if (c.criteriaType === 'self' || c.criteriaType === 'role') {
        results.push(markedCriteria.has(c.id));
      } else if (c.criteriaType === 'course' && c.courseInstance) {
        // Prerequisite: read the prerequisite course's STORED completion
        // (never recursive evaluation — dependent courses are reaggregated
        // when the prerequisite flips to complete, see below).
        const prereq = await this.repo.getCourseCompletion(userId, c.courseInstance);
        results.push(prereq?.status === 'complete');
      } else if (c.criteriaType === 'duration' && c.enrolPeriodDays !== null && c.enrolPeriodDays !== undefined) {
        results.push(!!enrolAnchor && enrolAnchor.getTime() + c.enrolPeriodDays * 86_400_000 <= now.getTime());
      } else if (c.criteriaType === 'unenrol') {
        results.push(!(await this.enrol.isEnrolled(courseId, userId)));
      } else {
        results.push(false);
      }
    }
    const complete = criteria.length === 0 ? false
      : method === AGGREGATION_ANY ? results.some(Boolean) : results.every(Boolean);
    return { results, complete, method };
  }

  /** Recompute and store one user's course completion from the current criteria (idempotent). */
  /**
   * Tổng hợp lại trạng thái hoàn thành khoá học của user và phát hook khi thay đổi.
   */
  async reaggregateCourseCompletion(userId: string, courseId: string): Promise<CourseCompletionRow> {
    const existing = await this.repo.getCourseCompletion(userId, courseId);
    const { complete } = await this.evaluateCriteria(courseId, userId);
    const criteria = await this.repo.listCriteria(courseId);
    let status = existing?.status ?? 'not_started';
    if (complete) status = 'complete';
    else if (criteria.length && (existing?.timeStarted || (await this.hasStarted(userId, courseId)))) status = 'in_progress';
    const row = await this.repo.upsertCourseCompletion({
      userId: userId, course: courseId, status,
      timeEnrolled: existing?.timeEnrolled ?? new Date(),
      timeStarted: status === 'not_started' ? null : (existing?.timeStarted ?? new Date()),
      timeCompleted: complete ? (existing?.timeCompleted ?? new Date()) : null,
    });
    if (complete && existing?.status !== 'complete') {
      // Sự kiện course_completed (Moodle \core\event\course_completed) cho
      // logstore: chỉ phát đúng lần chuyển trạng thái sang hoàn thành.
      await this.outbox.enqueueStandalone({
        aggregate: 'completion', type: 'course_completed',
        payload: { courseId, userId, actorId: userId },
      });
      for (const hook of this.courseCompletionHooks) {
        await hook({ courseId, userId }).catch((err) => this.logger.warn(`course completion hook failed: ${String(err)}`));
      }
      // Prerequisite propagation: courses listing THIS course as a 'course'
      // criterion may now complete for their users. Only a flip INTO
      // complete triggers this, and a dependent can only flip the same way,
      // so prerequisite cycles settle instead of looping.
      const dependentIds = await this.repo.listDependentCourseIds(courseId);
      for (const dependentId of dependentIds) {
        if (dependentId === courseId) continue;
        await this.recalculateCourse(dependentId)
          .catch((err) => this.logger.warn(`dependent course reaggregation failed for ${dependentId}: ${String(err)}`));
      }
    }
    return row;
  }

  // --- manual course criteria (self / role) -----------------------------------

  /**
   * Self completion (Moodle completion_criteria_self): the learner marks
   * THEMSELVES complete for the course's self criterion/criteria. The mark
   * is a crit_compl row (who + when recorded); unmarking removes it. The
   * learner must have course access; a course without a self criterion
   * rejects the call.
   */
  /**
   * Học viên tự đánh dấu hoàn thành khoá học (tiêu chí self).
   */
  async markSelfCompletion(actorId: string, courseId: string, complete: boolean): Promise<{ courseId: string; userId: string; complete: boolean; status: string }> {
    await this.courses.getCourse(courseId);
    await this.courses.assertCourseAccess(actorId, courseId);
    const selfCriteria = (await this.repo.listCriteria(courseId)).filter((c) => c.criteriaType === 'self');
    if (!selfCriteria.length) {
      throw new BadRequestException({ message: 'This course has no self completion criterion', code: 'completion.no_self_criterion' });
    }
    for (const c of selfCriteria) {
      if (complete) await this.repo.upsertCritCompl({ criteriaId: c.id, userId: actorId, markedBy: actorId });
      else await this.repo.deleteCritCompl(c.id, actorId);
    }
    const row = await this.reaggregateCourseCompletion(actorId, courseId);
    return { courseId, userId: actorId, complete, status: row.status };
  }

  /**
   * Manual completion by others (Moodle completion_criteria_role): a user
   * holding the criterion's role marks a learner complete (or removes the
   * mark). The mark is a crit_compl row recording who marked whom, and
   * when. Role assignments inherit down the context tree (Moodle
   * role_assign semantics), so holding the role at the course context OR
   * at any ancestor context (category, system) authorises the mark — the
   * same ancestor-path lookup PermissionEvaluator performs; assignments
   * in unrelated branches do not count. Role assignment is the
   * permission, per Moodle.
   */
  /**
   * Người giữ vai trò trong tiêu chí role (tại context khoá học hoặc bất kỳ context tổ tiên nào) đánh dấu hoàn thành cho học viên.
   */
  async markCriterionByRole(actorId: string, courseId: string, criteriaId: string, targetUserId: string, complete: boolean): Promise<{ courseId: string; criteriaId: string; userId: string; complete: boolean; status: string }> {
    await this.courses.getCourse(courseId);
    const criterion = await this.repo.getCriteria(criteriaId);
    if (!criterion || criterion.course !== courseId || criterion.criteriaType !== 'role' || !criterion.roleId) {
      throw new BadRequestException({ message: 'Criterion is not a role criterion of this course', code: 'completion.criteria_not_role' });
    }
    const contextId = await this.courses.courseContextId(courseId);
    const courseContext = await this.contexts.getContext(contextId);
    const pathIds = (await this.contexts.getPathContexts(courseContext)).map((c) => c.id);
    const assignments = await this.roles.listAssignmentsInContexts(actorId, pathIds);
    if (!assignments.some((a) => a.roleId === criterion.roleId)) {
      throw new ForbiddenException({ message: 'Only holders of the role named by this criterion may mark completion', code: 'completion.role_marker_forbidden' });
    }
    if (complete) await this.repo.upsertCritCompl({ criteriaId, userId: targetUserId, markedBy: actorId });
    else await this.repo.deleteCritCompl(criteriaId, targetUserId);
    const row = await this.reaggregateCourseCompletion(targetUserId, courseId);
    return { courseId, criteriaId, userId: targetUserId, complete, status: row.status };
  }
  private async hasStarted(userId: string, courseId: string): Promise<boolean> {
    const cms = await this.courses.listCms(courseId);
    return this.repo.hasAnyCmCompletion(userId, cms.map((c) => c.id));
  }

  /** Worker-facing bulk recalculation (the worker runs its own copy; this is the API-side twin used by tests/manual triggers). */
  /**
   * Tính lại completion toàn khoá học (hàng loạt, qua worker khi cần).
   */
  async recalculateCourse(courseId: string): Promise<{ courseId: string; users: number }> {
    const enrolments = await this.enrol.listEnrolmentsForCourse(courseId);
    const userIds = [...new Set(enrolments.map((e) => e.userId))];
    // Also include users who already have a stored course completion.
    for (const cc of await this.repo.listCourseCompletions(courseId)) {
      if (!userIds.includes(cc.userId)) userIds.push(cc.userId);
    }
    for (const userId of userIds) await this.reaggregateCourseCompletion(userId, courseId);
    return { courseId, users: userIds.length };
  }

  /**
   * Bản ghi hoàn thành khoá học của user.
   */
  async getCourseCompletion(userId: string, courseId: string): Promise<CourseCompletionRow> {
    const existing = await this.repo.getCourseCompletion(userId, courseId);
    if (existing) return existing;
    return this.reaggregateCourseCompletion(userId, courseId);
  }
  /**
   * Tiến độ hoàn thành khoá học của mọi học viên.
   */
  async listCourseCompletions(courseId: string): Promise<CourseCompletionRow[]> {
    return this.repo.listCourseCompletions(courseId);
  }

  /**
   * Cổng capability quản trị completion tại context khoá học.
   */
  async requireCompletionManage(actorId: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'lms/completion:manage', await this.courses.courseContextId(courseId));
  }
  notFound(): never { throw new NotFoundException({ message: 'Completion record not found', code: 'completion.not_found' }); }
  /** Ném lỗi 403 chuẩn hoá của module (hàm hỗ trợ nội bộ). */
  forbidden(msg: string): never { throw new ForbiddenException({ message: msg, code: 'completion.forbidden' }); }
}
