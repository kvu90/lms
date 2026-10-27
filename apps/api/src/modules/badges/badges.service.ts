import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { I18nService } from '@nestjs/i18n';
import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CompetenciesService } from '../competencies/competencies.service';
import { CompletionService } from '../completion/completion.service';
import { CoursesService } from '../courses/courses.service';
import { CustomFieldsService } from '../custom-fields/custom-fields.service';
import { GroupsService } from '../groups/groups.service';
import { MessagingService } from '../messaging/messaging.service';
import { USER_AREA, USER_COMPONENT, UsersService } from '../users/users.service';
import { BadgesRepository, type BadgeRow, type CriteriaRow, type IssuedRow } from './badges.repository';

export const BADGE_AWARD_QUEUE = 'badge-award';
export const BADGE_STATUS = { INACTIVE: 0, ACTIVE: 1, RETIRED: 2, ARCHIVED: 3, DISABLED: 4 } as const;
export const CRITERIA_AGGREGATION = { ALL: 1, ANY: 2 } as const;
export const LEAF_TYPES = ['coursecompletion', 'activitycompletion', 'competency', 'badge', 'manual', 'cohort', 'profile'] as const;

/** Các trường hồ sơ chuẩn mà lá `profile` đọc trực tiếp từ bản ghi user (ngoài ra lá nhận custom field theo shortName). */
const PROFILE_STANDARD_FIELDS = ['username', 'email', 'firstName', 'lastName'] as const;

export interface CriteriaInput {
  method: number; // 1=ALL, 2=ANY trên các lá
  criteria: { criteriaType: string; params?: Record<string, unknown>; description?: string }[];
}

/**
 * Facade của BadgesModule (core_badges của Moodle):
 *  - Tiêu chí tạo thành cây hai cấp: MỘT dòng 'overall' mang tổng hợp ALL/ANY,
 *    cộng các dòng lá (hoàn thành khoá học — tuỳ chọn theo một
 *    ngày hạn, hoàn thành hoạt động, đạt competency, một
 *    badge khác, thủ công theo role, thành viên cohort, trường hồ sơ).
 *  - LUẬT ĐÓNG BĂNG: tiêu chí của một badge ACTIVE — hoặc của bất kỳ badge nào đã cấp
 *    award — không thể thay đổi. Nhân bản badge để sửa tiêu chí của nó.
 *  - Cấp phát tạo một assertion BẤT BIẾN (bản chụp badge + tiêu chí,
 *    bằng chứng, ngày cấp/hết hạn). Thu hồi đánh dấu assertion đã thu hồi;
 *    dòng không bao giờ bị xoá.
 *  - Tự cấp: module này đăng ký hook completion với
 *    CompletionService và lắng nghe sự kiện đạt competency; bộ
 *    đánh giá chỉ đọc các module KHÁC qua facade của chúng
 *    (CompletionService, CompetenciesService), không bao giờ đọc bảng của chúng. Worker
 *    chạy cùng đánh giá từ hàng đợi 'badge-award'.
 */
@Injectable()
/**
 * Nghiệp vụ huy hiệu (Open Badges).
 * Đối chiếu Moodle: badges/classes (badge, criteria) và lib/badgeslib.php.
 * Vòng đời: badge nháp (inactive) → đặt tiêu chí → kích hoạt (active); badge đã kích hoạt hoặc đã cấp
 * thì bộ tiêu chí bị đóng băng — muốn sửa phải nhân bản (duplicate). Đánh giá tiêu chí chạy theo sự kiện
 * (hoàn thành khoá học/cm, năng lực đạt) và theo yêu cầu; mỗi lần cấp sinh assertion có uniqueHash kiểm chứng được.
 */
export class BadgesService implements OnModuleInit {
  constructor(
    private readonly repo: BadgesRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly roles: RolesService,
    private readonly courses: CoursesService,
    private readonly completion: CompletionService,
    private readonly competencies: CompetenciesService,
    private readonly messaging: MessagingService,
    private readonly users: UsersService,
    private readonly groups: GroupsService,
    private readonly customFields: CustomFieldsService,
    private readonly outbox: OutboxService,
    private readonly i18n: I18nService,
    @InjectQueue(BADGE_AWARD_QUEUE) private readonly awardQueue: Queue,
  ) {}

  /**
   * Khởi tạo: đăng ký hook hoàn thành để tự động đánh giá huy hiệu.
   */
  onModuleInit(): void {
    this.completion.registerCourseCompletionHook(async ({ userId, courseId }) => {
      void courseId;
      await this.enqueueEvaluation(userId, 'course-completion');
      await this.evaluateUserBadges(userId);
    });
    this.completion.registerCmCompletionHook(async ({ userId }) => {
      await this.evaluateUserBadges(userId);
    });
  }

  /** Năng lực đạt chuẩn đã thay đổi (sự kiện trong tiến trình từ CompetenciesService) ⇒ đánh giá lại. */
  @OnEvent('competency_proficiency_changed')
  /**
   * Sự kiện năng lực đạt chuẩn → đánh giá lại huy hiệu có tiêu chí năng lực.
   */
  async onProficiencyChanged(payload: { userId: string; competencyId: string }): Promise<void> {
    await this.enqueueEvaluation(payload.userId, 'competency');
    await this.evaluateUserBadges(payload.userId);
  }

  private async enqueueEvaluation(userId: string, trigger: string): Promise<void> {
    await this.awardQueue.add('evaluate', { userId, trigger }, {
      jobId: `badge-award-${userId}-${trigger}-${Date.now()}`,
      attempts: 3, removeOnComplete: true,
    }).catch(() => undefined);
  }

  private async systemCtx(): Promise<string> {
    return (await this.contexts.ensureSystemContext()).id;
  }
  private async badgeContextId(badgeRow: BadgeRow): Promise<string> {
    return badgeRow.type === 2 && badgeRow.courseId
      ? this.courses.courseContextId(badgeRow.courseId)
      : this.systemCtx();
  }

  // --- CRUD badge -----------------------------------------------------------------

  /**
   * Tạo badge ở trạng thái inactive.
   */
  async createBadge(actorId: string, input: {
    name: string; description?: string; type?: number; courseId?: string;
    issuerName?: string; issuerUrl?: string; issuerContact?: string;
    expireDate?: string; expirePeriod?: number; version?: string;
  }): Promise<BadgeRow> {
    const type = input.type ?? 1;
    if (type === 2 && !input.courseId) throw new BadRequestException({ message: 'A course badge requires courseId', code: 'badges.course_required' });
    const ctx = type === 2 ? await this.courses.courseContextId(input.courseId!) : await this.systemCtx();
    await this.evaluator.requireCapability(actorId, 'badges:createbadge', ctx);
    if (type === 1 && !(await this.evaluator.isSiteAdmin(actorId))) {
      // Badge cấp site là artefact ở context hệ thống: chỉ đường manager/site-admin.
      const manager = await this.roles.getRoleByShortname('manager');
      const assignments = manager ? await this.evaluator.hasCapability(actorId, 'badges:createbadge', ctx) : false;
      if (!assignments) throw new ForbiddenException({ message: 'Site badges require a manager role at the system context', code: 'badges.site_badge_manager_only' });
    }
    return this.repo.insertBadge({
      name: input.name, description: input.description ?? '', type,
      courseId: type === 2 ? input.courseId! : null,
      issuerName: input.issuerName ?? 'LMS', issuerUrl: input.issuerUrl ?? '', issuerContact: input.issuerContact ?? '',
      expireDate: input.expireDate ? new Date(input.expireDate) : null,
      expirePeriod: input.expirePeriod ?? null, status: BADGE_STATUS.INACTIVE,
      version: input.version ?? '', userCreated: actorId, userModified: actorId,
    });
  }

  /**
   * Lấy badge; ném badges.not_found khi vắng.
   */
  async getBadge(id: string): Promise<BadgeRow> {
    const row = await this.repo.getBadge(id);
    if (!row) throw new NotFoundException({ message: `Badge ${id} not found`, code: 'badges.not_found' });
    return row;
  }
  /**
   * Liệt kê badge.
   */
  async listBadges(): Promise<BadgeRow[]> { return this.repo.listBadges(); }

  /**
   * Cập nhật thông tin badge (trước khi kích hoạt).
   */
  async updateBadge(actorId: string, id: string, input: { name?: string; description?: string; issuerName?: string; expirePeriod?: number }): Promise<BadgeRow> {
    const badgeRow = await this.getBadge(id);
    await this.evaluator.requireCapability(actorId, 'badges:configurecriteria', await this.badgeContextId(badgeRow));
    const patch: Partial<BadgeRow> = { userModified: actorId };
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description;
    if (input.issuerName !== undefined) patch.issuerName = input.issuerName;
    if (input.expirePeriod !== undefined) patch.expirePeriod = input.expirePeriod;
    await this.repo.updateBadge(id, patch);
    return this.getBadge(id);
  }

  /** Xoá kiểu Moodle = lưu trữ (badgeslib_test test_delete_badge): badge không bao giờ bị xoá cứng theo mặc định. */
  /**
   * Lưu trữ badge (không cấp thêm).
   */
  async archiveBadge(actorId: string, id: string): Promise<BadgeRow> {
    const badgeRow = await this.getBadge(id);
    await this.evaluator.requireCapability(actorId, 'badges:configurecriteria', await this.badgeContextId(badgeRow));
    await this.repo.updateBadge(id, { status: BADGE_STATUS.ARCHIVED, userModified: actorId });
    return this.getBadge(id);
  }

  /**
   * Đổi trạng thái vòng đời của badge; kích hoạt yêu cầu đã có tiêu chí.
   */
  async setStatus(actorId: string, id: string, status: number): Promise<BadgeRow> {
    const badgeRow = await this.getBadge(id);
    await this.evaluator.requireCapability(actorId, 'badges:configurecriteria', await this.badgeContextId(badgeRow));
    if (![BADGE_STATUS.INACTIVE, BADGE_STATUS.ACTIVE, BADGE_STATUS.DISABLED].includes(status as never)) {
      throw new BadRequestException({ message: `Status ${status} cannot be set directly`, code: 'badges.bad_status' });
    }
    if (status === BADGE_STATUS.ACTIVE) {
      const leaves = (await this.repo.listCriteria(id)).filter((c) => c.criteriaType !== 'overall');
      if (!leaves.length) {
        throw new BadRequestException({ message: 'A badge cannot be enabled without criteria', code: 'badges.no_criteria' });
      }
    }
    await this.repo.updateBadge(id, { status, userModified: actorId });
    await this.outbox.enqueueStandalone({ aggregate: 'badges', type: 'badge_status_changed', payload: { badgeId: id, status } });
    return this.getBadge(id);
  }

  // --- tiêu chí -----------------------------------------------------------------------

  /**
   * Bộ tiêu chí của badge.
   */
  async getCriteria(badgeId: string): Promise<{ method: number; criteria: CriteriaRow[] }> {
    await this.getBadge(badgeId);
    const rows = await this.repo.listCriteria(badgeId);
    const overall = rows.find((r) => r.criteriaType === 'overall');
    return { method: overall?.method ?? CRITERIA_AGGREGATION.ALL, criteria: rows.filter((r) => r.criteriaType !== 'overall') };
  }

  /** Luật đóng băng (report §2#14): badge đang active và badge đã có award có tiêu chí bất biến. */
  /**
   * Chặn sửa tiêu chí khi badge đã kích hoạt/đã cấp (badges.criteria_frozen).
   */
  async assertCriteriaEditable(badgeRow: BadgeRow): Promise<void> {
    if (badgeRow.status === BADGE_STATUS.ACTIVE || badgeRow.status === BADGE_STATUS.DISABLED) {
      throw new ForbiddenException({
        message: 'Criteria of an active badge are frozen. Duplicate the badge to change its criteria.',
        code: 'badges.criteria_frozen',
      });
    }
    if ((await this.repo.countIssued(badgeRow.id)) > 0) {
      throw new ForbiddenException({
        message: 'This badge has already been issued; its criteria are frozen. Duplicate the badge to change them.',
        code: 'badges.criteria_frozen',
      });
    }
  }

  /**
   * Đặt bộ tiêu chí (ALL/ANY) cho badge chưa bị đóng băng.
   */
  async setCriteria(actorId: string, badgeId: string, input: CriteriaInput): Promise<{ method: number; criteria: CriteriaRow[] }> {
    const badgeRow = await this.getBadge(badgeId);
    await this.evaluator.requireCapability(actorId, 'badges:configurecriteria', await this.badgeContextId(badgeRow));
    await this.assertCriteriaEditable(badgeRow);
    if (![CRITERIA_AGGREGATION.ALL, CRITERIA_AGGREGATION.ANY].includes(input.method as never)) {
      throw new BadRequestException({ message: 'Criteria method must be 1 (ALL) or 2 (ANY)', code: 'badges.bad_method' });
    }
    for (const leaf of input.criteria) {
      if (!LEAF_TYPES.includes(leaf.criteriaType as never)) {
        throw new BadRequestException({ message: `Unknown criteria type ${leaf.criteriaType}`, code: 'badges.bad_criteria_type' });
      }
      const paramError = this.leafParamError(leaf.criteriaType, (leaf.params ?? {}) as Record<string, unknown>);
      if (paramError) {
        throw new BadRequestException({ message: paramError, code: 'badges.bad_criteria_params' });
      }
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.deleteCriteria(badgeId, tx as never);
      await this.repo.insertCriteria({ badgeId: badgeId, criteriaType: 'overall', method: input.method, params: {} }, tx as never);
      for (const leaf of input.criteria) {
        await this.repo.insertCriteria({
          badgeId: badgeId, criteriaType: leaf.criteriaType, method: input.method,
          params: leaf.params ?? {}, description: leaf.description ?? '',
        }, tx as never);
      }
    });
    return this.getCriteria(badgeId);
  }

  /** Nhân bản = cách được phép để sửa một badge đã đóng băng (badge INACTIVE mới với tiêu chí sao chép). */
  /**
   * Nhân bản badge (kèm tiêu chí) để chỉnh sửa mà không đụng bản đang chạy.
   */
  async duplicateBadge(actorId: string, badgeId: string): Promise<BadgeRow> {
    const source = await this.getBadge(badgeId);
    await this.evaluator.requireCapability(actorId, 'badges:createbadge', await this.badgeContextId(source));
    const copy = await this.repo.insertBadge({
      name: `${source.name} (copy)`, description: source.description, type: source.type,
      courseId: source.courseId, issuerName: source.issuerName, issuerUrl: source.issuerUrl,
      issuerContact: source.issuerContact, expireDate: source.expireDate, expirePeriod: source.expirePeriod,
      status: BADGE_STATUS.INACTIVE, version: source.version, language: source.language,
      userCreated: actorId, userModified: actorId,
    });
    const { criteria } = await this.getCriteria(badgeId);
    const rows = await this.repo.listCriteria(badgeId);
    const overall = rows.find((r) => r.criteriaType === 'overall');
    await this.repo.insertCriteria({ badgeId: copy.id, criteriaType: 'overall', method: overall?.method ?? 1, params: {} });
    for (const leaf of criteria) {
      await this.repo.insertCriteria({ badgeId: copy.id, criteriaType: leaf.criteriaType, method: leaf.method, params: leaf.params, description: leaf.description });
    }
    return copy;
  }

  /**
   * Kiểm tra tham số bắt buộc của từng loại lá khi đặt tiêu chí: mỗi lá phải
   * mang đủ tham chiếu mà evaluator cần (khoá học/cm/năng lực/huy hiệu/cohort/
   * trường hồ sơ); `byDate` của lá hoàn thành khoá học phải là ngày hợp lệ.
   * Trả về thông điệp lỗi hoặc null khi hợp lệ.
   */
  private leafParamError(criteriaType: string, params: Record<string, unknown>): string | null {
    const hasId = (key: string) => typeof params[key] === 'string' && (params[key] as string).length > 0;
    switch (criteriaType) {
      case 'coursecompletion': {
        if (!hasId('courseId')) return 'Course completion criteria require a courseId param';
        if (params.byDate !== undefined && (typeof params.byDate !== 'string' || Number.isNaN(Date.parse(params.byDate)))) {
          return 'Course completion byDate param must be a valid date';
        }
        return null;
      }
      case 'activitycompletion':
        return hasId('cmId') ? null : 'Activity completion criteria require a cmId param';
      case 'competency':
        return hasId('competencyId') ? null : 'Competency criteria require a competencyId param';
      case 'badge':
        return hasId('badgeId') ? null : 'Badge criteria require a badgeId param';
      case 'cohort': {
        const ids = Array.isArray(params.cohortIds) ? params.cohortIds : [];
        return hasId('cohortId') || (ids.length > 0 && ids.every((i) => typeof i === 'string'))
          ? null : 'Cohort criteria require a cohortId (or cohortIds) param';
      }
      case 'profile':
        return hasId('field') ? null : 'Profile criteria require a field param';
      default:
        return null;
    }
  }

  // --- đánh giá & cấp phát --------------------------------------------------------------

  private async leafSatisfied(leaf: CriteriaRow, userId: string): Promise<boolean> {
    const params = (leaf.params ?? {}) as Record<string, unknown>;
    switch (leaf.criteriaType) {
      case 'coursecompletion': {
        const courseId = typeof params.courseId === 'string' ? params.courseId : '';
        if (!courseId) return false;
        const completion = await this.completion.getCourseCompletion(userId, courseId).catch(() => undefined);
        if (completion?.status !== 'complete') return false;
        // By-date (Moodle award_badge "course completion by-date"): khi lá
        // khai `byDate`, chỉ tính khi thời điểm hoàn thành ≤ ngày cắt đó —
        // hoàn thành sau ngày cắt thì KHÔNG đạt dù trạng thái là complete.
        const byDate = typeof params.byDate === 'string' ? params.byDate : undefined;
        if (byDate !== undefined) {
          const cutoff = Date.parse(byDate);
          if (Number.isNaN(cutoff) || !completion.timeCompleted) return false;
          return completion.timeCompleted.getTime() <= cutoff;
        }
        return true;
      }
      case 'cohort': {
        // Lá cohort (Moodle criteria_cohort): user phải thuộc cohort chỉ
        // định; dạng `cohortIds` yêu cầu thuộc TẤT CẢ cohort liệt kê.
        const ids = typeof params.cohortId === 'string'
          ? [params.cohortId]
          : Array.isArray(params.cohortIds) ? params.cohortIds.filter((i): i is string => typeof i === 'string') : [];
        if (!ids.length) return false;
        for (const cohortId of ids) {
          if (!(await this.groups.isCohortMember(cohortId, userId))) return false;
        }
        return true;
      }
      case 'profile': {
        // Lá profile (Moodle criteria_profile): trường hồ sơ chuẩn hoặc
        // custom field (theo shortName, scope core_user/user) đạt điều kiện —
        // có `value` thì phải bằng đúng, không có thì trường phải được điền.
        const field = typeof params.field === 'string' ? params.field : '';
        if (!field) return false;
        let actual: string | null | undefined;
        if ((PROFILE_STANDARD_FIELDS as readonly string[]).includes(field)) {
          const user = await this.users.getByIdOrUndefined(userId);
          actual = user ? String(user[field as keyof typeof user] ?? '') : undefined;
        } else {
          const values = await this.customFields.getValuesForInstance(USER_COMPONENT, USER_AREA, userId).catch(() => []);
          actual = values.find((v) => v.field.shortName === field)?.value;
        }
        if (actual === null || actual === undefined) return false;
        return typeof params.value === 'string' ? actual === params.value : actual.trim() !== '';
      }
      case 'activitycompletion': {
        const cmId = typeof params.cmId === 'string' ? params.cmId : '';
        if (!cmId) return false;
        const state = await this.completion.getCmCompletion(cmId, userId).catch(() => undefined);
        return !!state && state.state >= 1;
      }
      case 'competency': {
        const competencyId = typeof params.competencyId === 'string' ? params.competencyId : '';
        if (!competencyId) return false;
        return this.competencies.isProficient(userId, competencyId);
      }
      case 'badge': {
        const otherBadgeId = typeof params.badgeId === 'string' ? params.badgeId : '';
        if (!otherBadgeId) return false;
        const issued = await this.repo.findIssued(otherBadgeId, userId);
        return !!issued && !issued.revoked;
      }
      case 'manual': {
        const award = await this.repo.findManualAward(leaf.badgeId, userId);
        return !!award;
      }
      default:
        return false;
    }
  }

  /** Đánh giá cây tiêu chí của một badge cho một user. */
  /**
   * Đánh giá một badge cho một user: đủ tiêu chí thì cấp.
   */
  async evaluateBadge(badgeId: string, userId: string): Promise<{ satisfied: boolean; method: number; leaves: { criteriaId: string; criteriaType: string; satisfied: boolean }[] }> {
    const { method, criteria } = await this.getCriteria(badgeId);
    const leaves = [];
    for (const leaf of criteria) {
      leaves.push({ criteriaId: leaf.id, criteriaType: leaf.criteriaType, satisfied: await this.leafSatisfied(leaf, userId) });
    }
    const satisfied = leaves.length === 0 ? false
      : method === CRITERIA_AGGREGATION.ANY ? leaves.some((l) => l.satisfied) : leaves.every((l) => l.satisfied);
    return { satisfied, method, leaves };
  }

  /**
   * Cấp một badge: tạo assertion bất biến. Idempotent — một user
   * giữ một badge cho trước tối đa một lần (lời gọi thứ hai
   * trả assertion hiện có).
   */
  /**
   * Cấp huy hiệu: tạo assertion với uniqueHash và gửi notification đã dịch cho người nhận.
   *
   * Flow: kiểm tra chưa từng cấp (idempotent — một user giữ một huy hiệu
   * tối đa một assertion) → trong MỘT transaction: ghi assertion (snapshot
   * huy hiệu + tiêu chí) và enqueue outbox `badge_issued` → SAU khi commit
   * mới phát thông báo `badge_awarded` qua `MessagingService.notify()` —
   * lỗi phát không bao giờ chặn việc cấp (`.catch` nuốt lỗi) → đánh dấu
   * `issuerNotified`.
   *
   * Ghi nhận #174-A (issue #174): call-site này truyền `courseId` của
   * huy hiệu vào `notify()` để luật ghi đè tắt tiếng theo khoá (NB-4) áp
   * được cho thông báo huy hiệu thuộc khoá — người nhận đã tắt tiếng khoá
   * nguồn thì không sinh thông báo ở kênh nào, chỉ còn dispatch log
   * `skipped-course-mute`. Huy hiệu cấp site (`courseId = null`) thì
   * không gắn khoá: truyền `undefined`, ghi đè theo khoá không áp dụng.
   * Assertion vẫn được cấp bất kể kết quả phát — mute chỉ tắt thông báo,
   * không tước huy hiệu đã đạt.
   */
  async issueBadge(badgeId: string, userId: string, evidence?: Record<string, unknown>): Promise<IssuedRow> {
    const badgeRow = await this.getBadge(badgeId);
    const existing = await this.repo.findIssued(badgeId, userId);
    if (existing) return existing;
    const { criteria } = await this.getCriteria(badgeId);
    const dateExpire = badgeRow.expireDate ?? (badgeRow.expirePeriod
      ? new Date(Date.now() + badgeRow.expirePeriod * 86400_000) : null);
    const uniqueHash = createHash('sha256').update(`${badgeId}:${userId}:${randomUUID()}`).digest('hex');
    const issued = await this.repo.dbHandle.transaction(async (tx) => {
      const row = await this.repo.insertIssued({
        badgeId: badgeId, userId: userId, uniqueHash,
        snapshot: {
          badge: { id: badgeRow.id, name: badgeRow.name, description: badgeRow.description, type: badgeRow.type, courseId: badgeRow.courseId, issuerName: badgeRow.issuerName, issuerUrl: badgeRow.issuerUrl, version: badgeRow.version },
          criteria: criteria.map((c) => ({ criteriaType: c.criteriaType, method: c.method, params: c.params })),
        },
        evidence: evidence ?? {},
        dateExpire, visible: true,
      }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'badges', type: 'badge_issued',
        payload: { badgeId, userId, issuedId: row.id, uniqueHash },
      });
      return row;
    });
    await this.messaging.notify(userId, 'badge_awarded', {
      subject: this.i18n.t('platform.badgeAwardedSubject', { args: { name: badgeRow.name } }),
      body: this.i18n.t('platform.badgeAwardedBody', { args: { name: badgeRow.name, issuer: badgeRow.issuerName } }),
      contextUrl: `/badges/${badgeId}`,
      // #174-A: gắn khoá nguồn để notify() áp ghi đè tắt tiếng theo khoá
      // (NB-4) — xem TSDoc của issueBadge. Huy hiệu cấp site không gắn
      // khoá thì giữ undefined như hành vi trước NB-4.
      courseId: badgeRow.courseId ?? undefined,
    }).catch(() => undefined);
    await this.repo.updateIssued(issued.id, { issuerNotified: true });
    return issued;
  }

  /**
   * Đánh giá một badge cho một user qua HTTP (H13, rà soát #134): chỉ
   * chính chủ, hoặc người có `badges:awardbadge` tại context của badge —
   * cùng cổng với manualAward; trước đây mọi user ép đánh giá cho user
   * bất kỳ và đọc được chi tiết tiêu chí đạt/chưa của người khác. Đường
   * nội bộ (hook hoàn thành/sự kiện) gọi evaluateBadge trực tiếp.
   */
  async evaluateBadgeFor(actorId: string, badgeId: string, userId: string) {
    if (userId !== actorId) {
      const badgeRow = await this.getBadge(badgeId);
      await this.evaluator.requireCapability(actorId, 'badges:awardbadge', await this.badgeContextId(badgeRow));
    }
    return this.evaluateBadge(badgeId, userId);
  }

  /**
   * Đánh giá mọi badge cho một user qua HTTP (H13): cấp thật huy hiệu khi
   * tiêu chí đạt nên người gọi khác chủ thể phải có `badges:awardbadge`
   * tại system; chính chủ tự kích hoạt đánh giá cho mình thì được phép.
   */
  async evaluateUserBadgesFor(actorId: string, userId: string) {
    if (userId !== actorId) {
      await this.evaluator.requireCapability(actorId, 'badges:awardbadge', await this.systemCtx());
    }
    return this.evaluateUserBadges(userId);
  }

  /** Đánh giá mọi badge ACTIVE cho một user và cấp những badge mới thoả. */
  /**
   * Đánh giá mọi badge liên quan cho user (sau sự kiện hoàn thành).
   */
  async evaluateUserBadges(userId: string): Promise<{ evaluated: number; issued: string[] }> {
    const user = await this.users.getByIdOrUndefined(userId);
    if (!user || user.suspended || user.deleted) return { evaluated: 0, issued: [] };
    const badges = (await this.repo.listBadges()).filter((b) => b.status === BADGE_STATUS.ACTIVE);
    const issued: string[] = [];
    for (const badgeRow of badges) {
      if (await this.repo.findIssued(badgeRow.id, userId)) continue;
      const result = await this.evaluateBadge(badgeRow.id, userId);
      if (result.satisfied) {
        const row = await this.issueBadge(badgeRow.id, userId, { evaluatedLeaves: result.leaves });
        issued.push(row.id);
      }
    }
    return { evaluated: badges.length, issued };
  }

  // --- cấp thủ công --------------------------------------------------------------------------

  /**
   * Cấp thủ công (oracle: badgeslib award_criteria_manual). Badge phải
   * khai một tiêu chí thủ công; nếu nó nêu một role, người cấp phải giữ
   * role đó tại context của badge. Việc cấp thoả lá thủ công;
   * badge chỉ được cấp nếu tổng hợp toàn thể sau đó đạt.
   */
  /**
   * Cấp thủ công cho user bởi người có capability award.
   */
  async manualAward(actorId: string, badgeId: string, recipientId: string): Promise<{ award: unknown; issued: IssuedRow | null; evaluation: unknown }> {
    const badgeRow = await this.getBadge(badgeId);
    if (badgeRow.status !== BADGE_STATUS.ACTIVE) {
      throw new BadRequestException({ message: 'Only an active badge can be awarded', code: 'badges.not_active' });
    }
    const ctx = await this.badgeContextId(badgeRow);
    await this.evaluator.requireCapability(actorId, 'badges:awardbadge', ctx);
    await this.users.getUser(recipientId);
    const { criteria } = await this.getCriteria(badgeId);
    const manualLeaf = criteria.find((c) => c.criteriaType === 'manual');
    if (!manualLeaf) {
      throw new BadRequestException({ message: 'This badge has no manual award criterion', code: 'badges.no_manual_criteria' });
    }
    const roleIdParam = (manualLeaf.params as Record<string, unknown>)?.roleId;
    let issuerRole: string | null = null;
    if (roleIdParam) {
      const assignments = await this.evaluator.hasCapabilityFromRealAssignment(actorId, 'badges:awardbadge', ctx);
      if (!assignments) throw new ForbiddenException({ message: 'Issuer does not hold the required awarding role', code: 'badges.issuer_role' });
      issuerRole = typeof roleIdParam === 'string' ? roleIdParam : null;
    }
    const award = await this.repo.insertManualAward({ badgeId: badgeId, recipientId: recipientId, issuerId: actorId, issuerRole: issuerRole });
    const evaluation = await this.evaluateBadge(badgeId, recipientId);
    const issued = evaluation.satisfied ? await this.issueBadge(badgeId, recipientId, { manualAwardId: award.id }) : null;
    return { award, issued, evaluation };
  }

  // --- assertion --------------------------------------------------------------------------------

  /**
   * Huy hiệu đã cấp cho user hiện tại.
   */
  async listMyBadges(userId: string): Promise<(IssuedRow & { badge: BadgeRow })[]> {
    const rows = await this.repo.listIssuedForUser(userId);
    const out: (IssuedRow & { badge: BadgeRow })[] = [];
    for (const row of rows) {
      const badgeRow = await this.repo.getBadge(row.badgeId);
      if (badgeRow) out.push({ ...row, badge: badgeRow });
    }
    return out;
  }
  /**
   * Danh sách cấp phát của badge.
   */
  async listIssuedForBadge(actorId: string, badgeId: string): Promise<IssuedRow[]> {
    const badgeRow = await this.getBadge(badgeId);
    await this.evaluator.requireCapability(actorId, 'badges:awardbadge', await this.badgeContextId(badgeRow));
    return this.repo.listIssuedForBadge(badgeId);
  }
  /**
   * Một bản ghi cấp phát.
   */
  async getIssued(id: string): Promise<IssuedRow> {
    const row = await this.repo.getIssued(id);
    if (!row) throw new NotFoundException({ message: `Badge assertion ${id} not found`, code: 'badges.assertion_not_found' });
    return row;
  }

  /** Thu hồi: dòng assertion VẪN CÒN (đánh dấu đã thu hồi); chỉ hiển thị/hiệu lực của nó kết thúc. */
  /**
   * Thu hồi một huy hiệu đã cấp.
   */
  async revokeIssued(actorId: string, issuedId: string): Promise<IssuedRow> {
    const issued = await this.getIssued(issuedId);
    const badgeRow = await this.getBadge(issued.badgeId);
    await this.evaluator.requireCapability(actorId, 'badges:revokebadge', await this.badgeContextId(badgeRow));
    await this.repo.updateIssued(issuedId, { revoked: true, revokedAt: new Date(), visible: false });
    await this.outbox.enqueueStandalone({ aggregate: 'badges', type: 'badge_revoked', payload: { badgeId: issued.badgeId, userId: issued.userId, issuedId } });
    return this.getIssued(issuedId);
  }
}
