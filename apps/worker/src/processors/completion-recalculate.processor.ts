import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job, Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  courseCompletionCriteria, courseCompletionCritCompl, courseCompletions, courseCompletionSettings,
  courseModules, courseModulesCompletion, userEnrolments, enrol,
  gradeGrades, gradeItems,
} from '@lms/db-schema';
import { tenantAls } from '../db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

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
    @InjectDrizzle() private readonly db: Database,
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
    const criteria = await this.db.select().from(courseCompletionCriteria)
      .where(eq(courseCompletionCriteria.course, courseId));
    const [settings] = await this.db.select().from(courseCompletionSettings)
      .where(eq(courseCompletionSettings.course, courseId));
    const method = settings?.method ?? 1; // 1=ALL, 2=ANY

    // User ứng viên: mọi người đã ghi danh vào khoá học (bất kỳ instance nào) cộng với
    // bất kỳ ai đã có một completion của khoá học được lưu.
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseId, courseId));
    const userIds = new Set<string>();
    const ues = instances.length
      ? await this.db.select().from(userEnrolments)
        .where(inArray(userEnrolments.enrolId, instances.map((i) => i.id)))
      : [];
    for (const ue of ues) userIds.add(ue.userId);
    const existingCompletions = await this.db.select().from(courseCompletions)
      .where(eq(courseCompletions.course, courseId));
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
      ? await this.db.select().from(courseCompletionCritCompl)
        .where(and(inArray(courseCompletionCritCompl.criteriaId, manualIds), inArray(courseCompletionCritCompl.userId, candidateIds)))
      : [];
    const markedKeys = new Set(marks.map((m) => `${m.criteriaId}|${m.userId}`));
    // Các completion tiên quyết (các dòng đã lưu của các khoá học được tham chiếu).
    const prereqIds = [...new Set(criteria.filter((c) => c.criteriaType === 'course' && c.courseInstance).map((c) => c.courseInstance as string))];
    const prereqRows = prereqIds.length && candidateIds.length
      ? await this.db.select().from(courseCompletions)
        .where(and(inArray(courseCompletions.course, prereqIds), inArray(courseCompletions.userId, candidateIds), eq(courseCompletions.status, 'complete')))
      : [];
    const prereqCompleteKeys = new Set(prereqRows.map((r) => `${r.course}|${r.userId}`));

    const cms = await this.db.select().from(courseModules).where(eq(courseModules.course, courseId));
    const completedUsers: string[] = [];
    const newlyCompletedUsers: string[] = [];
    for (const userId of userIds) {
      const results: boolean[] = [];
      for (const c of criteria) {
        if (c.criteriaType === 'module' && c.moduleInstance) {
          const [row] = await this.db.select().from(courseModulesCompletion)
            .where(and(eq(courseModulesCompletion.courseModuleId, c.moduleInstance), eq(courseModulesCompletion.userId, userId)));
          results.push(!!row && row.completionState !== 0);
        } else if (c.criteriaType === 'date' && c.date) {
          results.push(now >= c.date);
        } else if (c.criteriaType === 'grade') {
          // Điểm: tiêu chí điểm của khoá học — tổng điểm của khoá học đạt gradePass của item của khoá học.
          const [courseItem] = await this.db.select().from(gradeItems)
            .where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.itemType, 'course')));
          if (!courseItem) { results.push(false); continue; }
          const [g] = await this.db.select().from(gradeGrades)
            .where(and(eq(gradeGrades.itemId, courseItem.id), eq(gradeGrades.userId, userId)));
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
        const rows = await this.db.select().from(courseModulesCompletion)
          .where(and(eq(courseModulesCompletion.userId, userId), inArray(courseModulesCompletion.courseModuleId, cms.map((c) => c.id))));
        started = rows.length > 0;
      }
      const status = complete ? 'complete' : started || existing?.status === 'in_progress' ? 'in_progress' : 'not_started';
      if (complete) {
        completedUsers.push(userId);
        if (existing?.status !== 'complete') newlyCompletedUsers.push(userId);
      }
      await this.db.insert(courseCompletions).values({
        userId: userId, course: courseId, status,
        timeEnrolled: existing?.timeEnrolled ?? now,
        timeStarted: status === 'not_started' ? null : (existing?.timeStarted ?? now),
        timeCompleted: complete ? (existing?.timeCompleted ?? now) : null,
        reAggregate: now,
      }).onConflictDoUpdate({
        target: [courseCompletions.userId, courseCompletions.course],
        set: { status, timeCompleted: complete ? (existing?.timeCompleted ?? now) : null, reAggregate: now },
      });
    }

    // Lan truyền tiên quyết: user mới hoàn thành có thể thoả mãn tiêu chí 'course'
    // trong các khoá học phụ thuộc. Chỉ completion MỚI mới đưa vào queue, nên một
    // chu trình tiên quyết sẽ lắng xuống thay vì ping-pong mãi mãi.
    if (newlyCompletedUsers.length) {
      const dependents = await this.db.select({ course: courseCompletionCriteria.course }).from(courseCompletionCriteria)
        .where(and(eq(courseCompletionCriteria.criteriaType, 'course'), eq(courseCompletionCriteria.courseInstance, courseId)));
      for (const dependentId of [...new Set(dependents.map((d) => d.course))]) {
        if (dependentId === courseId) continue;
        await this.recalcQueue.add('recalculate', { courseId: dependentId },
          { jobId: `completion-recalc-${dependentId}-${Date.now()}`, attempts: 3 }).catch(() => undefined);
      }
    }
    return { courseId, users: userIds.size, completedUsers };
  }
}
