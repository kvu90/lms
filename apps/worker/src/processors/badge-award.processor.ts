import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import type { Job } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { sql, type CentreDB } from '@lms/db';
import { tenantAls } from '../db/tenant-als';
import { resolveDefaultTenantId } from '../db/default-tenant';
import { SpaceDatabaseService } from '../db/routing/space-database.service';
import { NotificationDeliveryService } from '../notification-delivery.service';

/** Các trường hồ sơ chuẩn mà lá `profile` đọc từ bảng users (khớp phía API; ngoài ra lá nhận custom field theo shortName). */
const PROFILE_STANDARD_FIELDS = ['username', 'email', 'firstName', 'lastName'] as const;

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
    private readonly i18n: I18nService,
    private readonly delivery: NotificationDeliveryService,
    private readonly spaceDb: SpaceDatabaseService,
  ) { super(); }

  private async leafSatisfied(leaf: { badgeId: string; criteriaType: string; params: unknown }, userId: string): Promise<boolean> {
    const params = (leaf.params ?? {}) as Record<string, unknown>;
    switch (leaf.criteriaType) {
      case 'coursecompletion': {
        const courseId = typeof params.courseId === 'string' ? params.courseId : '';
        if (!courseId) return false;
        const row = await this.spaceDb.routedKysely
          .selectFrom('course_completions')
          .select(['status', 'time_completed as timeCompleted'])
          .where('course', '=', courseId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
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
          const row = await this.spaceDb.routedKysely
            .selectFrom('cohort_members')
            .select('user_id as userId')
            .where('cohort_id', '=', cohortId)
            .where('user_id', '=', userId)
            .executeTakeFirst();
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
          const user = await this.spaceDb.routedKysely
            .selectFrom('users')
            .select(['username', 'email', 'first_name as firstName', 'last_name as lastName'])
            .where('id', '=', userId)
            .executeTakeFirst();
          actual = user ? String(user[field as keyof typeof user] ?? '') : undefined;
        } else {
          const fields = await this.spaceDb.routedKysely
            .selectFrom('custom_field_field')
            .innerJoin('custom_field_category', 'custom_field_category.id', 'custom_field_field.category_id')
            .select('custom_field_field.id')
            .where('custom_field_category.component', '=', 'core_user')
            .where('custom_field_category.area', '=', 'user')
            .where('custom_field_field.short_name', '=', field)
            .execute();
          const fieldId = fields[0]?.id;
          if (!fieldId) return false;
          const data = await this.spaceDb.routedKysely
            .selectFrom('custom_field_data')
            .select('value')
            .where('field_id', '=', fieldId)
            .where('instance_id', '=', userId)
            .executeTakeFirst();
          actual = data?.value;
        }
        if (actual === null || actual === undefined) return false;
        return typeof params.value === 'string' ? actual === params.value : actual.trim() !== '';
      }
      case 'activitycompletion': {
        const cmId = typeof params.cmId === 'string' ? params.cmId : '';
        if (!cmId) return false;
        const row = await this.spaceDb.routedKysely
          .selectFrom('course_modules_completion')
          .select('completion_state as completionState')
          .where('course_module_id', '=', cmId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        return !!row && row.completionState >= 1;
      }
      case 'competency': {
        const competencyId = typeof params.competencyId === 'string' ? params.competencyId : '';
        if (!competencyId) return false;
        const rows = await this.spaceDb.routedKysely
          .selectFrom('competency_user_comp')
          .select('proficiency')
          .where('user_id', '=', userId)
          .where('competency_id', '=', competencyId)
          .execute();
        return rows.some((r) => r.proficiency === true);
      }
      case 'badge': {
        const otherBadgeId = typeof params.badgeId === 'string' ? params.badgeId : '';
        if (!otherBadgeId) return false;
        const row = await this.spaceDb.routedKysely
          .selectFrom('badge_issued')
          .select(['id', 'revoked'])
          .where('badge_id', '=', otherBadgeId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
        return !!row && !row.revoked;
      }
      case 'manual': {
        const row = await this.spaceDb.routedKysely
          .selectFrom('badge_manual_award')
          .select('id')
          .where('badge_id', '=', leaf.badgeId)
          .where('recipient_id', '=', userId)
          .executeTakeFirst();
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
    const activeBadges = await this.spaceDb.routedKysely
      .selectFrom('badge')
      .select([
        'id', 'name', 'type', 'course_id as courseId', 'issuer_name as issuerName',
        'expire_date as expireDate', 'expire_period as expirePeriod',
      ])
      .where('status', '=', 1)
      .execute();
    const issuedIds: string[] = [];
    for (const badgeRow of activeBadges) {
      const existing = await this.spaceDb.routedKysely
        .selectFrom('badge_issued')
        .select('id')
        .where('badge_id', '=', badgeRow.id)
        .where('user_id', '=', userId)
        .executeTakeFirst();
      if (existing) continue;
      const criteriaRows = await this.spaceDb.routedKysely
        .selectFrom('badge_criteria')
        .select(['badge_id as badgeId', 'criteria_type as criteriaType', 'method', 'params'])
        .where('badge_id', '=', badgeRow.id)
        .execute();
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
      const issued = await this.spaceDb.routedKysely
        .insertInto('badge_issued')
        .values({
          badge_id: badgeRow.id, user_id: userId, unique_hash: uniqueHash,
          snapshot: sql<CentreDB['badge_issued']['snapshot']>`${JSON.stringify({
            badge: { id: badgeRow.id, name: badgeRow.name, type: badgeRow.type, courseId: badgeRow.courseId, issuerName: badgeRow.issuerName },
            criteria: leaves.map((c) => ({ criteriaType: c.criteriaType, method: c.method, params: c.params })),
          })}::jsonb`,
          evidence: sql<CentreDB['badge_issued']['evidence']>`${JSON.stringify({ via: 'worker-badge-award', trigger: job.data.trigger ?? null })}::jsonb`,
          date_expire: dateExpire, issuer_notified: true,
        })
        .onConflict((oc) => oc.columns(['badge_id', 'user_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
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
        const courseRow = await this.spaceDb.routedKysely
          .selectFrom('course')
          .select('tenant_id as tenantId')
          .where('id', '=', badgeRow.courseId)
          .executeTakeFirst();
        tenantId = courseRow?.tenantId ?? null;
      }
      if (!tenantId) tenantId = await resolveDefaultTenantId(this.spaceDb.routedKysely, userId);
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
      await this.spaceDb.routedKysely
        .insertInto('outbox_events')
        .values({
          aggregate: 'badges', type: 'badge_issued', tenant_id: tenantId,
          payload: sql<CentreDB['outbox_events']['payload']>`${JSON.stringify({ badgeId: badgeRow.id, userId, issuedId: issued.id, via: 'worker-badge-award', tenantId })}::jsonb`,
        })
        .execute();
    }
    return { evaluated: activeBadges.length, issued: issuedIds };
  }
}
