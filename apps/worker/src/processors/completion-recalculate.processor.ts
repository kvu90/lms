import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  courseCompletionCriteria, courseCompletions, courseCompletionSettings,
  courseModules, courseModulesCompletion, userEnrolments, enrol,
  gradeGrades, gradeItems,
} from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

export interface CompletionRecalculateJobData { courseId: string }
export interface CompletionRecalculateResult { courseId: string; users: number; completedUsers: string[] }

/**
 * Completion recalculation (report §2#9): when course criteria change
 * after completion data exists, the API flags reaggregation and enqueues
 * this job; the job recomputes every enrolled user's course_completions
 * from the CURRENT criteria (module completions AND/OR per method, date
 * criteria) — idempotently, in the worker, not inline in the request.
 */
@Processor('completion-recalculate')
/**
 * Xử lý job tính lại completion hàng loạt cho khoá học.
 */
export class CompletionRecalculateProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<CompletionRecalculateJobData>): Promise<CompletionRecalculateResult> {
    const { courseId } = job.data;
    const now = new Date();
    const criteria = await this.db.select().from(courseCompletionCriteria)
      .where(eq(courseCompletionCriteria.course, courseId));
    const [settings] = await this.db.select().from(courseCompletionSettings)
      .where(eq(courseCompletionSettings.course, courseId));
    const method = settings?.method ?? 1; // 1=ALL, 2=ANY

    // Candidate users: everyone enrolled in the course (any instance) plus
    // anyone who already has a stored course completion.
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseId, courseId));
    const userIds = new Set<string>();
    if (instances.length) {
      const ues = await this.db.select().from(userEnrolments)
        .where(inArray(userEnrolments.enrolId, instances.map((i) => i.id)));
      for (const ue of ues) userIds.add(ue.userId);
    }
    const existingCompletions = await this.db.select().from(courseCompletions)
      .where(eq(courseCompletions.course, courseId));
    for (const cc of existingCompletions) userIds.add(cc.userId);

    const cms = await this.db.select().from(courseModules).where(eq(courseModules.course, courseId));
    const completedUsers: string[] = [];
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
          // Grades: course grade criterion — the course total meets the course item's gradePass.
          const [courseItem] = await this.db.select().from(gradeItems)
            .where(and(eq(gradeItems.courseId, courseId), eq(gradeItems.itemType, 'course')));
          if (!courseItem) { results.push(false); continue; }
          const [g] = await this.db.select().from(gradeGrades)
            .where(and(eq(gradeGrades.itemId, courseItem.id), eq(gradeGrades.userId, userId)));
          results.push(!!g && g.finalGrade !== null && (courseItem.gradePass <= 0 || g.finalGrade >= courseItem.gradePass));
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
      if (complete) completedUsers.push(userId);
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
    return { courseId, users: userIds.size, completedUsers };
  }
}
