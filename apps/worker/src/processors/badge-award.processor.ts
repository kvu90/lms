import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  badge, badgeCriteria, badgeIssued, badgeManualAward, cohortMembers, competencyUsercomp,
  courseCompletions, courseModulesCompletion, customfieldCategory, customfieldData, customfieldField,
  notifications, outboxEvents, users,
} from '../db/schema';

/** Các trường hồ sơ chuẩn mà lá `profile` đọc từ bảng users (khớp phía API; ngoài ra lá nhận custom field theo shortname). */
const PROFILE_STANDARD_FIELDS = ['username', 'email', 'firstname', 'lastname'] as const;

type Database = NodePgDatabase<typeof relations>;

export interface BadgeAwardJobData { userId: string; trigger?: string }
export interface BadgeAwardResult { evaluated: number; issued: string[] }

/**
 * Badge auto-award evaluation: the worker twin of the API evaluator,
 * fed by completion/competency events through the 'badge-award' queue.
 * It re-derives each ACTIVE badge's criteria tree (overall ALL/ANY over
 * course-completion — honouring the leaf's optional by-date deadline /
 * activity-completion / competency-proficiency / other-badge / manual /
 * cohort-membership / profile-field leaves) from the SAME stored facts
 * the API uses,
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

  private async leafSatisfied(leaf: { badgeid: string; criteriatype: string; params: unknown }, userId: string): Promise<boolean> {
    const params = (leaf.params ?? {}) as Record<string, unknown>;
    switch (leaf.criteriatype) {
      case 'coursecompletion': {
        const courseId = typeof params.courseId === 'string' ? params.courseId : '';
        if (!courseId) return false;
        const [row] = await this.db.select().from(courseCompletions)
          .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userid, userId)));
        if (row?.status !== 'complete') return false;
        // By-date (khớp phía API): có `byDate` thì timecompleted phải ≤ ngày cắt.
        const byDate = typeof params.byDate === 'string' ? params.byDate : undefined;
        if (byDate !== undefined) {
          const cutoff = Date.parse(byDate);
          if (Number.isNaN(cutoff) || !row.timecompleted) return false;
          return row.timecompleted.getTime() <= cutoff;
        }
        return true;
      }
      case 'cohort': {
        // Lá cohort (khớp phía API): thuộc cohort chỉ định; `cohortIds` yêu cầu thuộc TẤT CẢ.
        const ids = typeof params.cohortId === 'string'
          ? [params.cohortId]
          : Array.isArray(params.cohortIds) ? params.cohortIds.filter((i): i is string => typeof i === 'string') : [];
        if (!ids.length) return false;
        for (const cohortId of ids) {
          const [row] = await this.db.select().from(cohortMembers)
            .where(and(eq(cohortMembers.cohortid, cohortId), eq(cohortMembers.userid, userId)));
          if (!row) return false;
        }
        return true;
      }
      case 'profile': {
        // Lá profile (khớp phía API): trường chuẩn trên users hoặc custom
        // field (shortname, scope core_user/user); có `value` thì phải bằng
        // đúng, không có thì trường phải được điền (khác rỗng).
        const field = typeof params.field === 'string' ? params.field : '';
        if (!field) return false;
        let actual: string | null | undefined;
        if ((PROFILE_STANDARD_FIELDS as readonly string[]).includes(field)) {
          const [user] = await this.db.select().from(users).where(eq(users.id, userId));
          actual = user ? String(user[field as keyof typeof user] ?? '') : undefined;
        } else {
          const fields = await this.db.select({ id: customfieldField.id })
            .from(customfieldField)
            .innerJoin(customfieldCategory, eq(customfieldField.categoryid, customfieldCategory.id))
            .where(and(
              eq(customfieldCategory.component, 'core_user'), eq(customfieldCategory.area, 'user'),
              eq(customfieldField.shortname, field),
            ));
          const fieldId = fields[0]?.id;
          if (!fieldId) return false;
          const [data] = await this.db.select().from(customfieldData)
            .where(and(eq(customfieldData.fieldid, fieldId), eq(customfieldData.instanceid, userId)));
          actual = data?.value;
        }
        if (actual === null || actual === undefined) return false;
        return typeof params.value === 'string' ? actual === params.value : actual.trim() !== '';
      }
      case 'activitycompletion': {
        const cmId = typeof params.cmId === 'string' ? params.cmId : '';
        if (!cmId) return false;
        const [row] = await this.db.select().from(courseModulesCompletion)
          .where(and(eq(courseModulesCompletion.coursemoduleid, cmId), eq(courseModulesCompletion.userid, userId)));
        return !!row && row.completionstate >= 1;
      }
      case 'competency': {
        const competencyId = typeof params.competencyId === 'string' ? params.competencyId : '';
        if (!competencyId) return false;
        const rows = await this.db.select().from(competencyUsercomp)
          .where(and(eq(competencyUsercomp.userid, userId), eq(competencyUsercomp.competencyid, competencyId)));
        return rows.some((r) => r.proficiency === true);
      }
      case 'badge': {
        const otherBadgeId = typeof params.badgeId === 'string' ? params.badgeId : '';
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
    const issuedIds: string[] = [];
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
