import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  badge, badgeCriteria, badgeIssued, badgeManualAward, competencyUsercomp,
  courseCompletions, courseModulesCompletion, notifications, outboxEvents,
} from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

export interface BadgeAwardJobData { userId: number; trigger?: string }
export interface BadgeAwardResult { evaluated: number; issued: number[] }

/**
 * Badge auto-award evaluation: the worker twin of the API evaluator,
 * fed by completion/competency events through the 'badge-award' queue.
 * It re-derives each ACTIVE badge's criteria tree (overall ALL/ANY over
 * course-completion / activity-completion / competency-proficiency /
 * other-badge / manual leaves) from the SAME stored facts the API uses,
 * and issues missing assertions. Fully idempotent: the
 * (badgeid, userid) unique key plus an existence check mean a second run
 * issues nothing twice. Each new issue also produces the badge_awarded
 * notification (popup channel) and a badge_issued outbox event.
 */
@Processor('badge-award')
/**
 * Xử lý job cấp huy hiệu nền: đánh giá tiêu chí cho user được chỉ định và cấp nếu đủ điều kiện.
 */
export class BadgeAwardProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly i18n: I18nService) { super(); }

  private async leafSatisfied(leaf: { badgeid: number; criteriatype: string; params: unknown }, userId: number): Promise<boolean> {
    const params = (leaf.params ?? {}) as Record<string, unknown>;
    switch (leaf.criteriatype) {
      case 'coursecompletion': {
        const courseId = Number(params.courseId ?? 0);
        if (!courseId) return false;
        const [row] = await this.db.select().from(courseCompletions)
          .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
        return row?.status === 'complete';
      }
      case 'activitycompletion': {
        const cmId = Number(params.cmId ?? 0);
        if (!cmId) return false;
        const [row] = await this.db.select().from(courseModulesCompletion)
          .where(and(eq(courseModulesCompletion.coursemoduleid, cmId), eq(courseModulesCompletion.userid, userId)));
        return !!row && row.completionstate >= 1;
      }
      case 'competency': {
        const competencyId = Number(params.competencyId ?? 0);
        if (!competencyId) return false;
        const rows = await this.db.select().from(competencyUsercomp)
          .where(and(eq(competencyUsercomp.userid, userId), eq(competencyUsercomp.competencyid, competencyId)));
        return rows.some((r) => r.proficiency === true);
      }
      case 'badge': {
        const otherBadgeId = Number(params.badgeId ?? 0);
        if (!otherBadgeId) return false;
        const [row] = await this.db.select().from(badgeIssued)
          .where(and(eq(badgeIssued.badgeid, otherBadgeId), eq(badgeIssued.userid, userId)));
        return !!row && !row.revoked;
      }
      case 'manual': {
        const [row] = await this.db.select().from(badgeManualAward)
          .where(and(eq(badgeManualAward.badgeid, leaf.badgeid), eq(badgeManualAward.recipientid, userId)));
        return !!row;
      }
      default:
        return false;
    }
  }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<BadgeAwardJobData>): Promise<BadgeAwardResult> {
    const { userId } = job.data;
    const activeBadges = await this.db.select().from(badge).where(eq(badge.status, 1));
    const issuedIds: number[] = [];
    for (const badgeRow of activeBadges) {
      const [existing] = await this.db.select().from(badgeIssued)
        .where(and(eq(badgeIssued.badgeid, badgeRow.id), eq(badgeIssued.userid, userId)));
      if (existing) continue;
      const criteriaRows = await this.db.select().from(badgeCriteria).where(eq(badgeCriteria.badgeid, badgeRow.id));
      const overall = criteriaRows.find((c) => c.criteriatype === 'overall');
      const leaves = criteriaRows.filter((c) => c.criteriatype !== 'overall');
      if (!leaves.length) continue;
      const results: boolean[] = [];
      for (const leaf of leaves) results.push(await this.leafSatisfied(leaf, userId));
      const method = overall?.method ?? 1;
      const satisfied = method === 2 ? results.some(Boolean) : results.every(Boolean);
      if (!satisfied) continue;
      const dateexpire = badgeRow.expiredate ?? (badgeRow.expireperiod
        ? new Date(Date.now() + badgeRow.expireperiod * 86400_000) : null);
      const uniquehash = createHash('sha256').update(`${badgeRow.id}:${userId}:${randomUUID()}`).digest('hex');
      const [issued] = await this.db.insert(badgeIssued).values({
        badgeid: badgeRow.id, userid: userId, uniquehash,
        snapshot: {
          badge: { id: badgeRow.id, name: badgeRow.name, type: badgeRow.type, courseid: badgeRow.courseid, issuername: badgeRow.issuername },
          criteria: leaves.map((c) => ({ criteriatype: c.criteriatype, method: c.method, params: c.params })),
        },
        evidence: { via: 'worker-badge-award', trigger: job.data.trigger ?? null },
        dateexpire, issuernotified: true,
      }).onConflictDoNothing({ target: [badgeIssued.badgeid, badgeIssued.userid] }).returning();
      if (!issued) continue;
      issuedIds.push(issued.id);
      // Text thông báo tra catalog i18n; worker ngoài request context nên
      // truyền locale tường minh (mặc định 'vi' như các processor nền tảng).
      const recipientLocale = 'vi';
      await this.db.insert(notifications).values({
        useridto: userId,
        subject: this.i18n.t('platform.badgeAwardedSubject', { locale: recipientLocale, args: { name: badgeRow.name } }),
        fullmessage: this.i18n.t('platform.badgeAwardedBody', { locale: recipientLocale, args: { name: badgeRow.name, issuer: badgeRow.issuername } }),
        smallmessage: this.i18n.t('platform.badgeAwardedSmall', { locale: recipientLocale, args: { name: badgeRow.name } }),
        component: 'core_badges', eventtype: 'badge_awarded',
        contexturl: `/badges/${badgeRow.id}`,
      });
      await this.db.insert(outboxEvents).values({
        aggregate: 'badges', type: 'badge_issued',
        payload: { badgeId: badgeRow.id, userId, issuedId: issued.id, via: 'worker-badge-award' },
      });
    }
    return { evaluated: activeBadges.length, issued: issuedIds };
  }
}
