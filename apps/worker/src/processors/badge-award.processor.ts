import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  badge, badgeCriteria, badgeIssued, badgeManualAward, cohortMembers, competencyUserComp,
  course, courseCompletions, courseModulesCompletion, customFieldCategory, customFieldData, customFieldField,
  outboxEvents, users,
} from '@lms/db';
import { tenantAls } from '../db/tenant-als';
import { resolveDefaultTenantId } from '../db/default-tenant';
import { NotificationDeliveryService } from '../notification-delivery.service';

/** Các trường hồ sơ chuẩn mà lá `profile` đọc từ bảng users (khớp phía API; ngoài ra lá nhận custom field theo shortName). */
const PROFILE_STANDARD_FIELDS = ['username', 'email', 'firstName', 'lastName'] as const;

type Database = NodePgDatabase<typeof relations>;

export interface BadgeAwardJobData { userId: string; trigger?: string }
export interface BadgeAwardResult { evaluated: number; issued: string[] }

/**
 * Đánh giá cấp huy hiệu tự động (badge auto-award): bản song sinh phía worker của evaluator phía API,
 * được nuôi bằng các sự kiện completion/competency qua queue 'badge-award'.
 * Nó suy lại cây tiêu chí của từng badge ACTIVE (overall ALL/ANY trên
 * course-completion — tôn trọng hạn by-date tuỳ chọn của lá /
 * các lá activity-completion / competency-proficiency / other-badge / manual /
 * cohort-membership / profile-field) từ ĐÚNG các dữ kiện đã lưu
 * mà API dùng,
 * và cấp các assertion còn thiếu. Hoàn toàn idempotent:
 * khoá duy nhất (badgeId, userId) cộng với bước kiểm tra tồn tại bảo đảm lần chạy thứ hai
 * không cấp trùng gì cả. Mỗi lần cấp mới cũng sinh ra thông báo badge_awarded
 * (kênh popup) và một sự kiện outbox badge_issued.
 *
 * Thông báo đi qua hàm luật phân phối trong-app dùng chung của worker
 * ({@link NotificationDeliveryService}, lát #174-A) — KHÔNG ghi thẳng
 * như trước (lớp G10): chính sách cấp site (NB-7), tắt tiếng theo
 * khoá (NB-4, qua courseId của huy hiệu) và tuỳ chọn của chính người
 * nhận đều áp dụng, và mọi kết quả đều để lại một dòng dispatch log.
 * Phát bị chặn không bao giờ thu hồi huy hiệu: assertion vẫn đứng,
 * chỉ thông báo bị giữ lại — đúng như đường phía API.
 */
@Processor('badge-award')
/**
 * Xử lý job cấp huy hiệu nền: đánh giá tiêu chí cho user được chỉ định và cấp nếu đủ điều kiện.
 */
export class BadgeAwardProcessor extends WorkerHost {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly i18n: I18nService,
    private readonly delivery: NotificationDeliveryService,
  ) { super(); }

  private async leafSatisfied(leaf: { badgeId: string; criteriaType: string; params: unknown }, userId: string): Promise<boolean> {
    const params = (leaf.params ?? {}) as Record<string, unknown>;
    switch (leaf.criteriaType) {
      case 'coursecompletion': {
        const courseId = typeof params.courseId === 'string' ? params.courseId : '';
        if (!courseId) return false;
        const [row] = await this.db.select().from(courseCompletions)
          .where(and(eq(courseCompletions.course, courseId), eq(courseCompletions.userId, userId)));
        if (row?.status !== 'complete') return false;
        // By-date (khớp phía API): có `byDate` thì timeCompleted phải ≤ ngày cắt.
        const byDate = typeof params.byDate === 'string' ? params.byDate : undefined;
        if (byDate !== undefined) {
          const cutoff = Date.parse(byDate);
          if (Number.isNaN(cutoff) || !row.timeCompleted) return false;
          return row.timeCompleted.getTime() <= cutoff;
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
            .where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId)));
          if (!row) return false;
        }
        return true;
      }
      case 'profile': {
        // Lá profile (khớp phía API): trường chuẩn trên users hoặc custom
        // field (shortName, scope core_user/user); có `value` thì phải bằng
        // đúng, không có thì trường phải được điền (khác rỗng).
        const field = typeof params.field === 'string' ? params.field : '';
        if (!field) return false;
        let actual: string | null | undefined;
        if ((PROFILE_STANDARD_FIELDS as readonly string[]).includes(field)) {
          const [user] = await this.db.select().from(users).where(eq(users.id, userId));
          actual = user ? String(user[field as keyof typeof user] ?? '') : undefined;
        } else {
          const fields = await this.db.select({ id: customFieldField.id })
            .from(customFieldField)
            .innerJoin(customFieldCategory, eq(customFieldField.categoryId, customFieldCategory.id))
            .where(and(
              eq(customFieldCategory.component, 'core_user'), eq(customFieldCategory.area, 'user'),
              eq(customFieldField.shortName, field),
            ));
          const fieldId = fields[0]?.id;
          if (!fieldId) return false;
          const [data] = await this.db.select().from(customFieldData)
            .where(and(eq(customFieldData.fieldId, fieldId), eq(customFieldData.instanceId, userId)));
          actual = data?.value;
        }
        if (actual === null || actual === undefined) return false;
        return typeof params.value === 'string' ? actual === params.value : actual.trim() !== '';
      }
      case 'activitycompletion': {
        const cmId = typeof params.cmId === 'string' ? params.cmId : '';
        if (!cmId) return false;
        const [row] = await this.db.select().from(courseModulesCompletion)
          .where(and(eq(courseModulesCompletion.courseModuleId, cmId), eq(courseModulesCompletion.userId, userId)));
        return !!row && row.completionState >= 1;
      }
      case 'competency': {
        const competencyId = typeof params.competencyId === 'string' ? params.competencyId : '';
        if (!competencyId) return false;
        const rows = await this.db.select().from(competencyUserComp)
          .where(and(eq(competencyUserComp.userId, userId), eq(competencyUserComp.competencyId, competencyId)));
        return rows.some((r) => r.proficiency === true);
      }
      case 'badge': {
        const otherBadgeId = typeof params.badgeId === 'string' ? params.badgeId : '';
        if (!otherBadgeId) return false;
        const [row] = await this.db.select().from(badgeIssued)
          .where(and(eq(badgeIssued.badgeId, otherBadgeId), eq(badgeIssued.userId, userId)));
        return !!row && !row.revoked;
      }
      case 'manual': {
        const [row] = await this.db.select().from(badgeManualAward)
          .where(and(eq(badgeManualAward.badgeId, leaf.badgeId), eq(badgeManualAward.recipientId, userId)));
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
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<BadgeAwardJobData>): Promise<BadgeAwardResult> {
    const { userId } = job.data;
    const activeBadges = await this.db.select().from(badge).where(eq(badge.status, 1));
    const issuedIds: string[] = [];
    for (const badgeRow of activeBadges) {
      const [existing] = await this.db.select().from(badgeIssued)
        .where(and(eq(badgeIssued.badgeId, badgeRow.id), eq(badgeIssued.userId, userId)));
      if (existing) continue;
      const criteriaRows = await this.db.select().from(badgeCriteria).where(eq(badgeCriteria.badgeId, badgeRow.id));
      const overall = criteriaRows.find((c) => c.criteriaType === 'overall');
      const leaves = criteriaRows.filter((c) => c.criteriaType !== 'overall');
      if (!leaves.length) continue;
      const results: boolean[] = [];
      for (const leaf of leaves) results.push(await this.leafSatisfied(leaf, userId));
      const method = overall?.method ?? 1;
      const satisfied = method === 2 ? results.some(Boolean) : results.every(Boolean);
      if (!satisfied) continue;
      const dateExpire = badgeRow.expireDate ?? (badgeRow.expirePeriod
        ? new Date(Date.now() + badgeRow.expirePeriod * 86400_000) : null);
      const uniqueHash = createHash('sha256').update(`${badgeRow.id}:${userId}:${randomUUID()}`).digest('hex');
      const [issued] = await this.db.insert(badgeIssued).values({
        badgeId: badgeRow.id, userId: userId, uniqueHash,
        snapshot: {
          badge: { id: badgeRow.id, name: badgeRow.name, type: badgeRow.type, courseId: badgeRow.courseId, issuerName: badgeRow.issuerName },
          criteria: leaves.map((c) => ({ criteriaType: c.criteriaType, method: c.method, params: c.params })),
        },
        evidence: { via: 'worker-badge-award', trigger: job.data.trigger ?? null },
        dateExpire, issuerNotified: true,
      }).onConflictDoNothing({ target: [badgeIssued.badgeId, badgeIssued.userId] }).returning();
      if (!issued) continue;
      issuedIds.push(issued.id);
      // Text thông báo tra catalog i18n; worker ngoài request context nên
      // truyền locale tường minh (mặc định 'vi' như các processor nền tảng).
      const recipientLocale = 'vi';
      // TENANT-1 (#196): tenant của notification = tenant của khoá chứa
      // huy hiệu; huy hiệu cấp platform (không gắn khoá) thì lấy tenant
      // mặc định của người nhận theo membership.
      let tenantId: string | null = null;
      if (badgeRow.courseId) {
        const [courseRow] = await this.db.select({ tenantId: course.tenantId }).from(course)
          .where(eq(course.id, badgeRow.courseId));
        tenantId = courseRow?.tenantId ?? null;
      }
      if (!tenantId) tenantId = await resolveDefaultTenantId(this.db, userId);
      // Phát qua hàm luật phân phối chung của worker (lát #174-A, xem
      // docblock đầu file): truyền `courseId` của huy hiệu để ghi đè
      // tắt tiếng theo khoá (NB-4) áp đúng như đường API — huy hiệu
      // cấp site (không gắn khoá) truyền null, ghi đè không áp. Nội
      // dung giữ nguyên văn như đường ghi thẳng trước đây (subject /
      // body / smallMessage từ cùng khoá i18n); kết quả phát bị chặn
      // (mute / admin tắt / tuỳ chọn tắt) KHÔNG ảnh hưởng assertion
      // vừa cấp ở trên.
      await this.delivery.deliverInApp(userId, 'badge_awarded', {
        subject: this.i18n.t('platform.badgeAwardedSubject', { locale: recipientLocale, args: { name: badgeRow.name } }),
        body: this.i18n.t('platform.badgeAwardedBody', { locale: recipientLocale, args: { name: badgeRow.name, issuer: badgeRow.issuerName } }),
        smallMessage: this.i18n.t('platform.badgeAwardedSmall', { locale: recipientLocale, args: { name: badgeRow.name } }),
        contextUrl: `/badges/${badgeRow.id}`,
        tenantId,
        courseId: badgeRow.courseId ?? null,
      });
      await this.db.insert(outboxEvents).values({
        aggregate: 'badges', type: 'badge_issued', tenantId,
        payload: { badgeId: badgeRow.id, userId, issuedId: issued.id, via: 'worker-badge-award', tenantId },
      });
    }
    return { evaluated: activeBadges.length, issued: issuedIds };
  }
}
