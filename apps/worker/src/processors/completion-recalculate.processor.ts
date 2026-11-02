import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { tenantAls } from '../db/tenant-als';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

export interface CompletionRecalculateJobData { courseId: string }
export interface CompletionRecalculateResult { courseId: string; users: number; completedUsers: string[] }

const ENROL_WITHDRAWN = 2;

/**
 * Tính lại completion (report §2#9): khi tiêu chí của khoá học thay đổi
 * sau khi dữ liệu completion đã tồn tại, API gắn cờ reaggregation và đưa
 * job này vào queue; job tính lại course_completions của mọi user đã ghi danh
 * từ các tiêu chí HIỆN TẠI — đủ 8 loại tiêu chí của Moodle với cùng
 * ngữ nghĩa như evaluator phía API (module/date/grade/self/course/
 * duration/role/unenrol) — một cách idempotent, trong worker, không chạy inline trong
 * request. Khi user mới hoàn thành một khoá học mà các khoá học khác liệt kê là
 * điều kiện tiên quyết, các job tính lại sẽ được đưa vào queue cho các khoá phụ thuộc đó.
 */
@Processor('completion-recalculate')
/**
 * Xử lý job tính lại completion hàng loạt cho khoá học.
 */
export class CompletionRecalculateProcessor extends WorkerHost {
  constructor(
    private readonly spaceDb: SpaceDatabaseService,
    @InjectQueue('completion-recalculate') private readonly recalcQueue: Queue,
  ) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<CompletionRecalculateJobData>): Promise<CompletionRecalculateResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<CompletionRecalculateJobData>): Promise<CompletionRecalculateResult> {
    const { courseId } = job.data;
    const now = new Date();
    const criteria = await this.spaceDb.routedKysely
      .selectFrom('course_completion_criteria')
      .select([
        'id', 'criteria_type as criteriaType', 'module_instance as moduleInstance',
        'course_instance as courseInstance', 'date', 'enrol_period_days as enrolPeriodDays', 'course',
      ])
      .where('course', '=', courseId)
      .execute();
    const settings = await this.spaceDb.routedKysely
      .selectFrom('course_completion_settings')
      .select('method')
      .where('course', '=', courseId)
      .executeTakeFirst();
    const method = settings?.method ?? 1; // 1=ALL, 2=ANY

    // User ứng viên: mọi người đã ghi danh vào khoá học (bất kỳ instance nào) cộng với
    // bất kỳ ai đã có một completion của khoá học được lưu.
    const instances = await this.spaceDb.routedKysely
      .selectFrom('enrol')
      .select(['id', 'status'])
      .where('course_id', '=', courseId)
      .execute();
    const userIds = new Set<string>();
    const ues = instances.length
      ? await this.spaceDb.routedKysely
        .selectFrom('user_enrolments')
        .select(['enrol_id as enrolId', 'user_id as userId', 'status', 'time_start as timeStart'])
        .where('enrol_id', 'in', instances.map((i) => i.id))
        .execute()
      : [];
    for (const ue of ues) userIds.add(ue.userId);
    const existingCompletions = await this.spaceDb.routedKysely
      .selectFrom('course_completions')
      .select([
        'user_id as userId', 'course', 'status', 'time_enrolled as timeEnrolled',
        'time_started as timeStarted', 'time_completed as timeCompleted',
      ])
      .where('course', '=', courseId)
      .execute();
    for (const cc of existingCompletions) userIds.add(cc.userId);
    const candidateIds = [...userIds];

    // Dữ kiện ghi danh theo từng user: mốc neo duration trải khắp mọi instance
    // (như trong evaluator phía API), trong khi trạng thái unenrol phản chiếu
    // EnrolService.isEnrolled — chỉ các instance ENABLED mới được tính.
    const liveUesByUser = new Map<string, typeof ues>();
    const enabledInstanceIds = new Set(instances.filter((i) => i.status === 0).map((i) => i.id));
    const enrolledUserIds = new Set<string>();
    for (const ue of ues) {
      if (ue.status === ENROL_WITHDRAWN) continue;
      const list = liveUesByUser.get(ue.userId) ?? [];
      list.push(ue);
      liveUesByUser.set(ue.userId, list);
      if (enabledInstanceIds.has(ue.enrolId)) enrolledUserIds.add(ue.userId);
    }
    // Các dòng bằng chứng của tiêu chí thủ công (self/role) cho mọi ứng viên trong một lần.
    const manualIds = criteria.filter((c) => c.criteriaType === 'self' || c.criteriaType === 'role').map((c) => c.id);
    const marks = manualIds.length && candidateIds.length
      ? await this.spaceDb.routedKysely
        .selectFrom('course_completion_crit_compl')
        .select(['criteria_id as criteriaId', 'user_id as userId'])
        .where('criteria_id', 'in', manualIds)
        .where('user_id', 'in', candidateIds)
        .execute()
      : [];
    const markedKeys = new Set(marks.map((m) => `${m.criteriaId}|${m.userId}`));
    // Các completion tiên quyết (các dòng đã lưu của các khoá học được tham chiếu).
    const prereqIds = [...new Set(criteria.filter((c) => c.criteriaType === 'course' && c.courseInstance).map((c) => c.courseInstance as string))];
    const prereqRows = prereqIds.length && candidateIds.length
      ? await this.spaceDb.routedKysely
        .selectFrom('course_completions')
        .select(['course', 'user_id as userId'])
        .where('course', 'in', prereqIds)
        .where('user_id', 'in', candidateIds)
        .where('status', '=', 'complete')
        .execute()
      : [];
    const prereqCompleteKeys = new Set(prereqRows.map((r) => `${r.course}|${r.userId}`));

    const cms = await this.spaceDb.routedKysely
      .selectFrom('course_modules')
      .select('id')
      .where('course', '=', courseId)
      .execute();
    const completedUsers: string[] = [];
    const newlyCompletedUsers: string[] = [];
    for (const userId of userIds) {
      const results: boolean[] = [];
      for (const c of criteria) {
        if (c.criteriaType === 'module' && c.moduleInstance) {
          const row = await this.spaceDb.routedKysely
            .selectFrom('course_modules_completion')
            .select('completion_state as completionState')
            .where('course_module_id', '=', c.moduleInstance)
            .where('user_id', '=', userId)
            .executeTakeFirst();
          results.push(!!row && row.completionState !== 0);
        } else if (c.criteriaType === 'date' && c.date) {
          results.push(now >= c.date);
        } else if (c.criteriaType === 'grade') {
          // Điểm: tiêu chí điểm của khoá học — tổng điểm của khoá học đạt gradePass của item của khoá học.
          const courseItem = await this.spaceDb.routedKysely
            .selectFrom('grade_items')
            .select(['id', 'grade_pass as gradePass'])
            .where('course_id', '=', courseId)
            .where('item_type', '=', 'course')
            .executeTakeFirst();
          if (!courseItem) { results.push(false); continue; }
          const g = await this.spaceDb.routedKysely
            .selectFrom('grade_grades')
            .select('final_grade as finalGrade')
            .where('item_id', '=', courseItem.id)
            .where('user_id', '=', userId)
            .executeTakeFirst();
          results.push(!!g && g.finalGrade !== null && (courseItem.gradePass <= 0 || g.finalGrade >= courseItem.gradePass));
        } else if (c.criteriaType === 'self' || c.criteriaType === 'role') {
          results.push(markedKeys.has(`${c.id}|${userId}`));
        } else if (c.criteriaType === 'course' && c.courseInstance) {
          results.push(prereqCompleteKeys.has(`${c.courseInstance}|${userId}`));
        } else if (c.criteriaType === 'duration' && c.enrolPeriodDays !== null && c.enrolPeriodDays !== undefined) {
          const live = liveUesByUser.get(userId) ?? [];
          const anchor = live.reduce<Date | null>((min, ue) => (min === null || ue.timeStart < min ? ue.timeStart : min), null);
          results.push(!!anchor && anchor.getTime() + c.enrolPeriodDays * 86_400_000 <= now.getTime());
        } else if (c.criteriaType === 'unenrol') {
          results.push(!enrolledUserIds.has(userId));
        } else {
          results.push(false);
        }
      }
      const complete = criteria.length > 0 && (method === 2 ? results.some(Boolean) : results.every(Boolean));
      const existing = existingCompletions.find((cc) => cc.userId === userId);
      let started = !!existing?.timeStarted;
      if (!started && cms.length) {
        const rows = await this.spaceDb.routedKysely
          .selectFrom('course_modules_completion')
          .select('id')
          .where('user_id', '=', userId)
          .where('course_module_id', 'in', cms.map((c) => c.id))
          .execute();
        started = rows.length > 0;
      }
      const status = complete ? 'complete' : started || existing?.status === 'in_progress' ? 'in_progress' : 'not_started';
      if (complete) {
        completedUsers.push(userId);
        if (existing?.status !== 'complete') newlyCompletedUsers.push(userId);
      }
      await this.spaceDb.routedKysely
        .insertInto('course_completions')
        .values({
          user_id: userId, course: courseId, status,
          time_enrolled: existing?.timeEnrolled ?? now,
          time_started: status === 'not_started' ? null : (existing?.timeStarted ?? now),
          time_completed: complete ? (existing?.timeCompleted ?? now) : null,
          re_aggregate: now,
        })
        .onConflict((oc) => oc
          .columns(['user_id', 'course'])
          .doUpdateSet({ status, time_completed: complete ? (existing?.timeCompleted ?? now) : null, re_aggregate: now }))
        .execute();
    }

    // Lan truyền tiên quyết: user mới hoàn thành có thể thoả mãn tiêu chí 'course'
    // trong các khoá học phụ thuộc. Chỉ completion MỚI mới đưa vào queue, nên một
    // chu trình tiên quyết sẽ lắng xuống thay vì ping-pong mãi mãi.
    if (newlyCompletedUsers.length) {
      const dependents = await this.spaceDb.routedKysely
        .selectFrom('course_completion_criteria')
        .select('course')
        .where('criteria_type', '=', 'course')
        .where('course_instance', '=', courseId)
        .execute();
      for (const dependentId of [...new Set(dependents.map((d) => d.course))]) {
        if (dependentId === courseId) continue;
        await this.recalcQueue.add('recalculate', { courseId: dependentId },
          { jobId: `completion-recalc-${dependentId}-${Date.now()}`, attempts: 3 }).catch(() => undefined);
      }
    }
    return { courseId, users: userIds.size, completedUsers };
  }
}
