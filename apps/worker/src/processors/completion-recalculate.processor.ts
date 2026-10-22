import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  courseCompletionCriteria, courseCompletions, courseCompletionSettings,
  courseModules, courseModulesCompletion, userEnrolments, enrol,
} from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

export interface CompletionRecalculateJobData { courseId: number }
export interface CompletionRecalculateResult { courseId: number; users: number; completedUsers: number[] }

/**
 * Completion recalculation (P2, report §2#9): when course criteria change
 * after completion data exists, the API flags reaggregation and enqueues
 * this job; the job recomputes every enrolled user's course_completions
 * from the CURRENT criteria (module completions AND/OR per method, date
 * criteria) — idempotently, in the worker, not inline in the request.
 */
@Processor('completion-recalculate')
export class CompletionRecalculateProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

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
    const instances = await this.db.select().from(enrol).where(eq(enrol.courseid, courseId));
    const userIds = new Set<number>();
    if (instances.length) {
      const ues = await this.db.select().from(userEnrolments)
        .where(inArray(userEnrolments.enrolid, instances.map((i) => i.id)));
      for (const ue of ues) userIds.add(ue.userid);
    }
    const existingCompletions = await this.db.select().from(courseCompletions)
      .where(eq(courseCompletions.course, courseId));
    for (const cc of existingCompletions) userIds.add(cc.userid);

    const cms = await this.db.select().from(courseModules).where(eq(courseModules.course, courseId));
    const completedUsers: number[] = [];
    for (const userId of userIds) {
      const results: boolean[] = [];
      for (const c of criteria) {
        if (c.criteriatype === 'module' && c.moduleinstance) {
          const [row] = await this.db.select().from(courseModulesCompletion)
            .where(and(eq(courseModulesCompletion.coursemoduleid, c.moduleinstance), eq(courseModulesCompletion.userid, userId)));
          results.push(!!row && row.completionstate !== 0);
        } else if (c.criteriatype === 'date' && c.date) {
          results.push(now >= c.date);
        } else {
          results.push(false); // grade criteria: P3 hook
        }
      }
      const complete = criteria.length > 0 && (method === 2 ? results.some(Boolean) : results.every(Boolean));
      const existing = existingCompletions.find((cc) => cc.userid === userId);
      let started = !!existing?.timestarted;
      if (!started && cms.length) {
        const rows = await this.db.select().from(courseModulesCompletion)
          .where(and(eq(courseModulesCompletion.userid, userId), inArray(courseModulesCompletion.coursemoduleid, cms.map((c) => c.id))));
        started = rows.length > 0;
      }
      const status = complete ? 'complete' : started || existing?.status === 'in_progress' ? 'in_progress' : 'not_started';
      if (complete) completedUsers.push(userId);
      await this.db.insert(courseCompletions).values({
        userid: userId, course: courseId, status,
        timeenrolled: existing?.timeenrolled ?? now,
        timestarted: status === 'not_started' ? null : (existing?.timestarted ?? now),
        timecompleted: complete ? (existing?.timecompleted ?? now) : null,
        reaggregate: now,
      }).onConflictDoUpdate({
        target: [courseCompletions.userid, courseCompletions.course],
        set: { status, timecompleted: complete ? (existing?.timecompleted ?? now) : null, reaggregate: now },
      });
    }
    return { courseId, users: userIds.size, completedUsers };
  }
}
