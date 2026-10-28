import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { I18nService } from '@nestjs/i18n';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { isRoleContextConflictError, RoleSeparationService } from '../access/role-separation.service';
import { ENROL_ASSIGNMENT_COMPONENT, RolesService } from '../access/roles.service';
import { CoursesService } from '../courses/courses.service';
import { GroupsService } from '../groups/groups.service';
import { MessagingService } from '../messaging/messaging.service';
import { TenantsService } from '../tenants/tenants.service';
import { EnrolRepository, type EnrolRow, type UserEnrolmentRow } from './enrol.repository';

/** Dòng gán vai thuộc về một enrol instance: đúng dòng này (và chỉ dòng này) bị gỡ khi instance rút/đổi vai (issue #157). */
interface EnrolAssignmentRow { id: string; roleId: string; component: string; itemId: string | null }

/** Truy vết nguồn cho dòng gán vai do một enrol instance cấp (Moodle: component/itemid trên role_assignments). */
function enrolAssignmentSource(instance: EnrolRow): { component: string; itemId: string } {
  return { component: ENROL_ASSIGNMENT_COMPONENT, itemId: instance.id };
}

/** Lỗi có phải unique violation của PostgreSQL (mã 23505, có thể bọc trong cause của DrizzleQueryError) hay không. */
function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    if ((current as { code?: unknown }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Dòng `a` có phải là dòng gán vai do chính instance này cấp hay không. */
function isInstanceAssignment(a: EnrolAssignmentRow, instance: EnrolRow): boolean {
  return a.roleId === instance.roleId && a.component === ENROL_ASSIGNMENT_COMPONENT && a.itemId === instance.id;
}

export const ENROL_ACTIVE = 0;
export const ENROL_SUSPENDED = 1;
export const ENROL_WITHDRAWN = 2;
export const ENROL_METHODS = ['manual', 'cohort', 'self', 'guest', 'fee'] as const;
export type EnrolMethod = (typeof ENROL_METHODS)[number];

/**
 * Facade của EnrolModule (core_enrol của Moodle).
 *
 * Các bất biến (report §2#5):
 *  - Ghi danh ≠ gán role ≠ xác thực. Ghi danh cấp một role
 *    tại context khoá học qua facade Access; `isEnrolled` chỉ kiểm tra
 *    bản ghi ghi danh (trạng thái + cửa sổ thời gian).
 *  - User bị SUSPENDED không truy cập được khoá học (cổng của CoursesService dùng
 *    isEnrolled(onlyActive)) dù gán role của họ vẫn còn.
 *  - Unenrol giữ dữ liệu đóng góp: khi user có bản ghi completion
 *    trong khoá học (kiểm qua probe đã đăng ký từ CompletionModule) hoặc
 *    luôn theo luật enrol hiện hành, dòng user_enrolments được giữ dạng WITHDRAWN
 *    (trạng thái mềm) thay vì xoá cứng, và `user_unenrolled` được
 *    phát. Gán role do ghi danh này cấp sẽ bị gỡ.
 *  - Ghi danh hết hạn (timeEnd trong quá khứ) không còn hiệu lực; job
 *    `enrol-expiry` của worker cũng chuyển chúng sang SUSPENDED hàng loạt.
 */
@Injectable()
/**
 * Nghiệp vụ ghi danh (enrolment).
 * Đối chiếu Moodle: lib/enrollib.php (enrol_get_plugin, user_enrolment) và các plugin enrol_manual/enrol_self/enrol_cohort.
 * Trạng thái ghi danh: 0 = đang hiệu lực, 1 = tạm đình chỉ, 2 = đã rút; ghi danh có thể có cửa sổ thời gian (timeStart/timeEnd).
 * Cohort sync: thành viên cohort được tự động ghi danh qua instance cohort; rời cohort thì ghi danh cohort bị rút
 * (chỉ rút khi user không còn dữ liệu liên quan — bài nộp/điểm — theo probe dữ liệu liên quan, khớp hành vi Moodle).
 */
export class EnrolService implements OnModuleInit {
  /** Probe do CompletionModule đăng ký: user này có dữ liệu completion trong khoá học này không? */
  /** Các probe dữ liệu liên quan (Completion, Grades, …): BẤT KỲ probe nào báo có dữ liệu thì giữ dòng UE dạng đã rút-chưa-xoá. */
  private relatedDataProbes: ((courseId: string, userId: string) => Promise<boolean>)[] = [];
  /** Các hook unenrol (CompletionModule: tiêu chí 'unenrol' của khoá học theo Moodle phải được đánh giá lại ngay lúc một user rời khoá học). */
  private unenrolHooks: ((e: { courseId: string; userId: string; instanceId: string }) => Promise<void>)[] = [];

  constructor(
    private readonly repo: EnrolRepository,
    private readonly courses: CoursesService,
    private readonly roles: RolesService,
    private readonly evaluator: PermissionEvaluator,
    private readonly groups: GroupsService,
    private readonly outbox: OutboxService,
    private readonly messaging: MessagingService,
    private readonly i18n: I18nService,
    private readonly tenants: TenantsService,
    private readonly roleSeparation: RoleSeparationService,
  ) {}

  /**
   * Khởi tạo: đăng ký enrol checker cho module courses và lắng nghe sự kiện thành viên cohort.
   */
  onModuleInit(): void {
    this.courses.registerEnrolChecker({
      isEnrolled: (courseId, userId, opts) => this.isEnrolled(courseId, userId, opts),
    });
  }
  /**
   * Đăng ký probe kiểm tra user còn dữ liệu liên quan trong khoá học hay không (module khác cắm vào).
   */
  registerRelatedDataProbe(probe: (courseId: string, userId: string) => Promise<boolean>): void {
    this.relatedDataProbes.push(probe);
  }
  /**
   * Đăng ký hook chạy sau khi một user bị huỷ ghi danh khỏi khoá học
   * (module khác cắm vào, cùng mẫu registerRelatedDataProbe).
   */
  registerUnenrolHook(fn: (e: { courseId: string; userId: string; instanceId: string }) => Promise<void>): void {
    this.unenrolHooks.push(fn);
  }
  /**
   * User còn dữ liệu liên quan (điểm/bài nộp) trong khoá học hay không — quyết định rút hẳn hay chỉ đình chỉ khi rời cohort.
   */
  async hasRelatedData(courseId: string, userId: string): Promise<boolean> {
    for (const probe of this.relatedDataProbes) {
      if (await probe(courseId, userId)) return true;
    }
    return false;
  }

  private async requireManage(actorId: string, courseId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'enrol:manage', await this.courses.courseContextId(courseId));
  }
  private async defaultStudentRoleId(): Promise<string> {
    const roleRow = await this.roles.getRoleByShortname('student');
    if (!roleRow) throw new Error('student role not seeded');
    return roleRow.id;
  }

  // --- các instance ----------------------------------------------------------------
  /**
   * Người xem có capability quản lý enrol tại khoá học hay không (site admin
   * được tính là có — xem PermissionEvaluator.hasCapability).
   */
  private async canManageEnrol(viewerId: string, courseId: string): Promise<boolean> {
    return this.evaluator.hasCapability(viewerId, 'enrol:manage', await this.courses.courseContextId(courseId));
  }

  /**
   * Che khoá ghi danh của instance đối với người không có quyền quản lý enrol:
   * khoá không bao giờ rời server cho học viên/người ngoài (response mang
   * `enrolmentKey: null`, đúng hình dạng bản ghi). Dùng cho mọi đường đọc
   * instance phơi qua API; đường nội bộ vẫn dùng bản ghi gốc.
   */
  private hideInstanceKey(instance: EnrolRow): EnrolRow {
    return instance.enrolmentKey ? { ...instance, enrolmentKey: null } : instance;
  }

  /**
   * Tạo enrol instance cho khoá học (manual/self/cohort/fee).
   * `enrolmentKey` là khoá ghi danh của instance self; tin nhắn chào mừng mặc
   * định bật cho self và tắt cho manual (đúng mặc định Moodle) trừ khi
   * `sendWelcomeMessage` được chỉ định rõ.
   */
  async createInstance(actorId: string, courseId: string, input: {
    method: string; name?: string; roleShortname?: string; status?: number; enrolPeriod?: number;
    cohortId?: string; groupId?: string; onCohortLeave?: 'suspend' | 'unenrol';
    cost?: number; currency?: string; paymentAccountId?: string;
    enrolmentKey?: string; sendWelcomeMessage?: boolean; welcomeMessage?: string;
  }): Promise<EnrolRow> {
    await this.courses.getCourse(courseId);
    await this.requireManage(actorId, courseId);
    if (!ENROL_METHODS.includes(input.method as EnrolMethod)) {
      throw new BadRequestException({ message: `Unknown enrol method ${input.method}`, code: 'enrol.unknown_method' });
    }
    if (input.method === 'cohort' && !input.cohortId) {
      throw new BadRequestException({ message: 'A cohort enrol instance requires cohortId', code: 'enrol.cohort_required' });
    }
    let roleId: string | undefined;
    if (input.roleShortname) {
      const roleRow = await this.roles.getRoleByShortname(input.roleShortname);
      if (!roleRow) throw new BadRequestException({ message: `Role ${input.roleShortname} not found`, code: 'enrol.role_not_found' });
      roleId = roleRow.id;
    } else {
      roleId = await this.defaultStudentRoleId();
    }
    if (input.method === 'fee' && (!input.cost || input.cost <= 0 || !input.currency)) {
      throw new BadRequestException({ message: 'A fee enrol instance requires a positive integer cost and a currency', code: 'enrol.fee_config_required' });
    }
    const instance = await this.repo.insertInstance({
      courseId: courseId, enrol: input.method, name: input.name ?? null, roleId,
      status: input.status ?? 0, enrolPeriod: input.enrolPeriod ?? 0,
      customInt1: input.method === 'cohort' ? (input.cohortId ?? null) : null,
      customInt2: input.groupId ?? null,
      customText1: input.onCohortLeave ?? 'suspend',
      cost: input.cost ?? 0, currency: input.currency ?? '', paymentAccountId: input.paymentAccountId ?? null,
      enrolmentKey: input.enrolmentKey ?? null,
      sendWelcomeMessage: input.sendWelcomeMessage ?? (input.method === 'self'),
      welcomeMessage: input.welcomeMessage ?? null,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'enrol', type: 'enrol_instance_created', payload: { instanceId: instance.id, courseId, method: input.method } });
    // Đồng bộ cohort: ghi danh mọi người đã ở trong cohort.
    if (input.method === 'cohort' && input.cohortId) {
      const members = await this.groups.listCohortMembers(input.cohortId);
      for (const m of members) await this.enrolFromCohortSync(instance, m.userId, actorId);
    }
    return instance;
  }
  /**
   * Đảm bảo khoá thuộc lớp có đúng một instance cohort trỏ vào backing
   * cohort của lớp (issue #184, CLASS-0) — đường nội bộ KHÔNG kiểm
   * capability (việc tạo instance là hệ quả máy móc của việc tạo khoá
   * trong lớp, quyền đã chốt ở cổng tạo khoá). Idempotent: đã có instance
   * cohort cho đúng (khoá, cohort) thì dùng lại (chỉ bổ sung group đích /
   * chế độ rời lớp khi lớp đã đổi), chưa có thì tạo mới và backfill ngay
   * toàn bộ roster hiện có — đúng ngữ nghĩa tạo instance cohort sẵn có.
   * `groupId` là group "cả lớp" tự sinh của khoá (custom_int2).
   */
  async ensureClassCohortInstance(courseId: string, cohortId: string, onLeave: 'suspend' | 'unenrol', groupId: string | null): Promise<EnrolRow> {
    const existing = (await this.repo.listInstances(courseId)).find((i) => i.enrol === 'cohort' && i.customInt1 === cohortId);
    if (existing) {
      const patch: Partial<EnrolRow> = {};
      if (existing.customText1 !== onLeave) patch.customText1 = onLeave;
      if (groupId && existing.customInt2 !== groupId) patch.customInt2 = groupId;
      if (Object.keys(patch).length) {
        await this.repo.updateInstance(existing.id, patch);
        return { ...existing, ...patch };
      }
      return existing;
    }
    const instance = await this.repo.insertInstance({
      courseId, enrol: 'cohort', name: null, roleId: await this.defaultStudentRoleId(),
      status: 0, enrolPeriod: 0,
      customInt1: cohortId, customInt2: groupId, customText1: onLeave,
      cost: 0, currency: '', paymentAccountId: null,
      enrolmentKey: null, sendWelcomeMessage: false, welcomeMessage: null,
    });
    const members = await this.groups.listCohortMembers(cohortId);
    for (const m of members) await this.enrolFromCohortSync(instance, m.userId);
    return instance;
  }

  /**
   * Lấy instance; ném enrol.instance_not_found khi vắng.
   */
  async getInstance(id: string): Promise<EnrolRow> {
    const row = await this.repo.getInstance(id);
    if (!row) throw new NotFoundException({ message: `Enrol instance ${id} not found`, code: 'enrol.instance_not_found' });
    return row;
  }
  /**
   * Liệt kê instance của khoá học cho một người xem: khoá ghi danh chỉ hiện
   * với người có capability quản lý enrol tại khoá (staff); khi không truyền
   * `viewerId` (đường nội bộ tin cậy) bản ghi được trả nguyên vẹn.
   */
  async listInstances(courseId: string, viewerId?: string): Promise<EnrolRow[]> {
    const rows = await this.repo.listInstances(courseId);
    if (!viewerId) return rows;
    if (await this.canManageEnrol(viewerId, courseId)) return rows;
    return rows.map((row) => this.hideInstanceKey(row));
  }
  /**
   * Cập nhật instance. Đổi role (`roleShortname`) trên instance — oracle
   * Behat enrol/cohort "Editing a cohort enrolment method's role should
   * change participants' role": role của mọi thành viên ĐÃ ghi danh qua
   * instance này (trừ ghi danh đã rút) được gán lại — gỡ assignment role cũ
   * do instance cấp tại context khoá học, cấp role mới; enrolment và trạng
   * thái ghi danh giữ nguyên. `enrolmentKey: null` xoá khoá ghi danh.
   */
  async updateInstance(actorId: string, id: string, input: {
    name?: string; status?: number; enrolPeriod?: number; onCohortLeave?: 'suspend' | 'unenrol'; groupId?: string;
    roleShortname?: string; enrolmentKey?: string | null; sendWelcomeMessage?: boolean; welcomeMessage?: string | null;
  }): Promise<EnrolRow> {
    const instance = await this.getInstance(id);
    await this.requireManage(actorId, instance.courseId);
    const patch: Partial<EnrolRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.status !== undefined) patch.status = input.status;
    if (input.enrolPeriod !== undefined) patch.enrolPeriod = input.enrolPeriod;
    if (input.onCohortLeave !== undefined) patch.customText1 = input.onCohortLeave;
    if (input.groupId !== undefined) patch.customInt2 = input.groupId;
    if (input.enrolmentKey !== undefined) patch.enrolmentKey = input.enrolmentKey;
    if (input.sendWelcomeMessage !== undefined) patch.sendWelcomeMessage = input.sendWelcomeMessage;
    if (input.welcomeMessage !== undefined) patch.welcomeMessage = input.welcomeMessage;
    let newRoleId: string | undefined;
    if (input.roleShortname !== undefined) {
      const roleRow = await this.roles.getRoleByShortname(input.roleShortname);
      if (!roleRow) throw new BadRequestException({ message: `Role ${input.roleShortname} not found`, code: 'enrol.role_not_found' });
      newRoleId = roleRow.id;
      patch.roleId = newRoleId;
    }
    if (Object.keys(patch).length) await this.repo.updateInstance(id, patch);
    if (newRoleId && newRoleId !== instance.roleId) {
      await this.reassignEnrolledRoles(instance, newRoleId, actorId);
    }
    return this.getInstance(id);
  }

  /**
   * Gán lại role cho các thành viên đã ghi danh qua instance sau khi instance
   * đổi role: gỡ assignment role cũ (đúng role instance từng cấp, tại context
   * khoá học) rồi cấp role mới cho từng người; không đụng tới bản ghi ghi danh.
   */
  private async reassignEnrolledRoles(instance: EnrolRow, newRoleId: string, modifierId: string): Promise<void> {
    const courseCtxId = await this.courses.courseContextId(instance.courseId);
    const enrolments = await this.repo.listUserEnrolmentsForInstance(instance.id);
    for (const ue of enrolments) {
      if (ue.status === ENROL_WITHDRAWN) continue;
      if (instance.roleId) {
        // Chỉ gỡ dòng do CHÍNH instance này cấp (khớp component/itemId) —
        // dòng cùng role của instance khác hoặc gán tay giữ nguyên (#157).
        const assignments = await this.roles.listAssignments({ userId: ue.userId, contextId: courseCtxId });
        for (const a of assignments as EnrolAssignmentRow[]) {
          if (isInstanceAssignment(a, instance)) await this.roles.unassignRole(a.id, modifierId, { allowEnrolManaged: true });
        }
      }
      await this.roles.assignRole(ue.userId, newRoleId, courseCtxId, modifierId, enrolAssignmentSource(instance));
    }
  }
  /**
   * Xoá instance.
   */
  async deleteInstance(actorId: string, id: string): Promise<void> {
    const instance = await this.getInstance(id);
    await this.requireManage(actorId, instance.courseId);
    await this.repo.deleteInstance(id);
  }

  // --- ghi danh / huỷ ghi danh ----------------------------------------------------------
  /** Đường ghi danh lõi (cũng dùng cho đồng bộ cohort). Cấp role của instance tại context khoá học qua facade Access. */
  /**
   * Ghi danh nội bộ không kiểm capability (dùng cho cohort sync và thanh toán đã xác nhận).
   */
  async enrolUserInternal(instance: EnrolRow, userId: string, modifierId?: string, opts?: { timeStart?: Date; timeEnd?: Date }): Promise<UserEnrolmentRow> {
    if (instance.status !== 0) throw new BadRequestException({ message: 'Enrol instance is disabled', code: 'enrol.instance_disabled' });
    // Chốt TÁCH VAI — funnel 1 (RoleSeparationService giữ định nghĩa
    // dùng chung): mọi đường ghi danh đều hội tụ về hàm này (ghi danh
    // tay, tự ghi danh, kích hoạt sau thanh toán, đồng bộ cohort), nên
    // chốt tại đây phủ toàn bộ các đường đó. Chỉ áp khi instance cấp
    // vai HỌC VIÊN: người đã có cấp quyền giảng dạy bao phủ chính
    // khoá đích bị từ chối với mã `access.role_context_conflict`,
    // TRƯỚC khi bất kỳ bản ghi ghi danh hay dòng gán vai nào được
    // tạo. Instance cấp vai giảng dạy là đường cấp vai của quản trị
    // (nằm ngoài quyết định tách vai) nên không qua chốt.
    if (await this.roleSeparation.isLearnerGrantRole(instance.roleId)) {
      await this.roleSeparation.assertLearnerEnrolmentAllowed(userId, instance.courseId);
    }
    const timeStart = opts?.timeStart ?? new Date();
    const timeEnd = opts?.timeEnd ?? (instance.enrolPeriod > 0 ? new Date(timeStart.getTime() + instance.enrolPeriod * 1000) : null);
    const existing = await this.repo.getUserEnrolment(instance.id, userId);
    let ue: UserEnrolmentRow;
    let isNewEnrolment = false;
    if (existing) {
      await this.repo.updateUserEnrolment(existing.id, { status: ENROL_ACTIVE, timeStart, timeEnd, modifierId: modifierId });
      ue = (await this.repo.getUserEnrolment(instance.id, userId))!;
    } else {
      try {
        ue = await this.repo.dbHandle.transaction(async (tx) => {
          const row = await this.repo.insertUserEnrolment({ enrolId: instance.id, userId: userId, status: ENROL_ACTIVE, timeStart, timeEnd, modifierId: modifierId }, tx);
          await this.outbox.enqueue(tx, { aggregate: 'enrol', type: 'user_enrolled', payload: { courseId: instance.courseId, userId, instanceId: instance.id, method: instance.enrol, actorId: modifierId ?? null } });
          return row;
        });
        isNewEnrolment = true;
      } catch (err) {
        // Đua ghi đồng thời (CLASS-0, #184): consumer outbox phát lại sự
        // kiện cohort trong lúc request tạo instance đang backfill cùng
        // một học sinh — cả hai cùng qua cửa "chưa có UE" rồi cùng
        // insert, một phía ăn unique violation trên
        // (enrol_id, user_id). Nối vào đường cập nhật idempotent thay
        // vì để 500 lọt ra ngoài; phía thắng đã phát user_enrolled.
        if (!isUniqueViolation(err)) throw err;
        const winner = await this.repo.getUserEnrolment(instance.id, userId);
        if (!winner) throw err;
        await this.repo.updateUserEnrolment(winner.id, { status: ENROL_ACTIVE, timeStart, timeEnd, modifierId: modifierId });
        ue = (await this.repo.getUserEnrolment(instance.id, userId))!;
      }
    }
    // Ghi danh vào khoá của tenant nào thì thuộc tenant đó (TENANT-0,
    // #168): membership active được đảm bảo ngay tại đây để cổng
    // membership của evaluator cho qua các vai ghi danh vừa cấp.
    const courseTenantId = await this.courses.getCourseTenantId(instance.courseId);
    if (courseTenantId) await this.tenants.ensureActiveMembership(courseTenantId, userId);
    if (instance.roleId) {
      const courseCtxId = await this.courses.courseContextId(instance.courseId);
      // Dòng gán mang truy vết của chính instance này — unenrol/đổi vai
      // sau đó chỉ gỡ đúng dòng đó, không đụng gán của instance khác hay
      // gán tay cùng role (issue #157).
      await this.roles.assignRole(userId, instance.roleId, courseCtxId, modifierId, enrolAssignmentSource(instance));
    }
    if (instance.customInt2) {
      await this.groups.addMemberInternal(instance.customInt2, userId, 'enrol_cohort', instance.id).catch(() => undefined);
    }
    if (isNewEnrolment) await this.maybeSendWelcomeMessage(instance, userId);
    return ue;
  }

  /**
   * Ghi danh một thành viên cohort qua đường đồng bộ hàng loạt (backfill
   * khi tạo/khôi phục instance cohort, listener sự kiện cohort): một
   * thành viên vi phạm chốt tách vai bị BỎ QUA riêng lẻ — vòng lặp đồng
   * bộ không được hỏng vì một thành viên, và các caller trực tiếp một
   * người (ghi danh tay, tự ghi danh, thanh toán) vẫn nhận lỗi tường
   * minh từ `enrolUserInternal`. Mọi lỗi khác ngoài xung đột vai đều
   * nổi lên như cũ.
   */
  private async enrolFromCohortSync(instance: EnrolRow, userId: string, modifierId?: string): Promise<void> {
    try {
      await this.enrolUserInternal(instance, userId, modifierId);
    } catch (err) {
      if (!isRoleContextConflictError(err)) throw err;
    }
  }

  /**
   * Gửi tin nhắn chào mừng qua MessagingModule (provider `enrol_welcome`)
   * khi một ghi danh MỚI thành công — chỉ cho self + manual và chỉ khi
   * instance bật `sendWelcomeMessage` (mặc định lúc tạo: self bật, manual
   * tắt, đúng mặc định Moodle). Nội dung tuỳ biến của instance được dùng
   * nguyên văn (token `{coursename}`/`{course}` được thay bằng tên khoá);
   * không có nội dung tuỳ biến thì dùng mẫu i18n `platform.enrolWelcome*`.
   * Gửi chào mừng là hiệu ứng phụ: lỗi gửi không bao giờ làm hỏng ghi danh,
   * và việc kích hoạt lại một ghi danh đã có không gửi lại tin nhắn.
   * Quyết định kiến trúc: EnrolModule import trực tiếp MessagingModule —
   * không có vòng phụ thuộc (Messaging chỉ phụ thuộc Access/Users/Events,
   * giống hệt cách BadgesModule và ReportsModule đã dùng), nên không cần
   * vòng qua outbox event cho riêng tính năng này.
   */
  private async maybeSendWelcomeMessage(instance: EnrolRow, userId: string): Promise<void> {
    if (instance.enrol !== 'self' && instance.enrol !== 'manual') return;
    if (!instance.sendWelcomeMessage) return;
    try {
      const course = await this.courses.getCourse(instance.courseId);
      const custom = instance.welcomeMessage?.trim();
      const body = custom
        ? custom.replaceAll('{coursename}', course.fullName).replaceAll('{course}', course.fullName)
        : String(this.i18n.t('platform.enrolWelcomeBody', { args: { course: course.fullName } }));
      const subject = String(this.i18n.t('platform.enrolWelcomeSubject', { args: { course: course.fullName } }));
      await this.messaging.notify(userId, 'enrol_welcome', {
        subject, body, contextUrl: `/courses/${instance.courseId}`,
        // Sự kiện gắn khoá rõ ràng: áp ghi đè tắt tiếng theo khoá (NB-4).
        courseId: instance.courseId,
      });
    } catch {
      /* Tin nhắn chào mừng không được phép làm hỏng ghi danh đã thành công. */
    }
  }

  /**
   * Ghi danh thủ công một user (kiểm capability enrol).
   */
  async enrolUser(actorId: string, instanceId: string, userId: string, opts?: { timeStart?: string; timeEnd?: string }): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    await this.requireManage(actorId, instance.courseId);
    return this.enrolUserInternal(instance, userId, actorId, {
      timeStart: opts?.timeStart ? new Date(opts.timeStart) : undefined,
      timeEnd: opts?.timeEnd ? new Date(opts.timeEnd) : undefined,
    });
  }

  /**
   * Tự ghi danh qua instance self đang bật; instance fee bị từ chối
   * (enrol.payment_required) vì phải qua thanh toán đã xác nhận.
   *
   * Khoá ghi danh (oracle Behat enrol/self/self_enrolment.feature —
   * "Self-enrolment enabled requiring an enrolment key" và "...requiring a
   * group enrolment key"): khi instance có đặt khoá, người học phải nộp
   * đúng khoá của instance HOẶC khoá của một nhóm trong khoá (group
   * enrolment key) — thiếu khoá ⇒ 400 `enrol.enrolment_key_required`, sai
   * khoá ⇒ 400 `enrol.invalid_enrolment_key`, và không ghi danh nào được
   * tạo trong cả hai trường hợp. Khoá khớp một nhóm thì người học đồng thời
   * được xếp vào nhóm đó. Instance không đặt khoá thì hành vi như trước
   * (khoá nhóm nộp kèm vẫn xếp nhóm, khoá lạ bị bỏ qua).
   */
  async selfEnrol(userId: string, instanceId: string, enrolmentKey?: string): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    if (instance.enrol === 'fee') {
      // Enrol có phí chỉ kích hoạt qua PaymentSucceeded đã xác thực (§2#27) — không tự ghi danh trực tiếp.
      throw new BadRequestException({ message: 'Fee enrol instance requires a succeeded payment before enrolment is activated', code: 'enrol.payment_required' });
    }
    if (instance.enrol !== 'self') throw new BadRequestException({ message: 'Instance is not a self-enrol instance', code: 'enrol.not_self' });
    const providedKey = enrolmentKey ? enrolmentKey : undefined;
    const courseGroups = await this.groups.groupsForCourseInternal(instance.courseId);
    const matchedGroup = providedKey
      ? courseGroups.find((g) => g.enrolmentKey !== null && g.enrolmentKey !== '' && g.enrolmentKey === providedKey)
      : undefined;
    const instanceKey = instance.enrolmentKey ? instance.enrolmentKey : null;
    if (instanceKey) {
      if (!providedKey) {
        throw new BadRequestException({ message: 'This course requires an enrolment key', code: 'enrol.enrolment_key_required' });
      }
      if (providedKey !== instanceKey && !matchedGroup) {
        throw new BadRequestException({ message: 'Invalid enrolment key', code: 'enrol.invalid_enrolment_key' });
      }
    }
    const ue = await this.enrolUserInternal(instance, userId, userId);
    if (matchedGroup) {
      await this.groups.addMemberInternal(matchedGroup.id, userId, 'enrol_self', instance.id).catch(() => undefined);
    }
    return ue;
  }

  /**
   * Tự huỷ ghi danh của CHÍNH người gọi khỏi một instance self (oracle Behat
   * enrol/self/self_enrolment.feature — "Self unenrol as a self-enrolled
   * student"). Endpoint không nhận userId nên về cấu trúc không thể huỷ ghi
   * danh của người khác; ghi danh do phương thức khác tạo (manual/cohort/fee)
   * bị từ chối 400 `enrol.self_unenrol_not_allowed`. Việc huỷ đi qua cùng
   * đường `unenrolInternal` như huỷ quản trị: gỡ role do instance cấp, phát
   * `user_unenrolled`, và tôn trọng withdrawn/data retention.
   */
  async selfUnenrol(userId: string, instanceId: string): Promise<{ withdrawn: boolean }> {
    const instance = await this.getInstance(instanceId);
    if (instance.enrol !== 'self') {
      throw new BadRequestException({ message: 'You can only unenrol yourself from a self-enrolment instance', code: 'enrol.self_unenrol_not_allowed' });
    }
    const ue = await this.repo.getUserEnrolment(instanceId, userId);
    if (!ue || ue.status === ENROL_WITHDRAWN) {
      throw new NotFoundException({ message: 'User enrolment not found', code: 'enrol.user_not_enrolled' });
    }
    return this.unenrolInternal(instance, userId, userId);
  }

  /** Kích hoạt ghi danh sau thanh toán thành công — chỉ PaymentsModule gọi sau webhook đã xác thực/idempotent. */
  /**
   * Kích hoạt ghi danh sau khi thanh toán PayPal được xác nhận.
   */
  async activatePaidEnrol(instanceId: string, userId: string): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    if (instance.enrol !== 'fee') throw new BadRequestException({ message: 'Instance is not a fee enrol instance', code: 'enrol.not_fee' });
    const existing = await this.repo.getUserEnrolment(instanceId, userId);
    if (existing && existing.status === ENROL_ACTIVE) return existing;
    return this.enrolUserInternal(instance, userId, userId);
  }

  /**
   * Đình chỉ hoặc kích hoạt lại một ghi danh.
   *
   * Chốt TÁCH VAI áp cả cho chiều KÍCH HOẠT LẠI: đưa một ghi danh từ
   * trạng thái đình chỉ về ĐANG HOẠT ĐỘNG là một lần chuyển ghi danh
   * thành ghi danh học viên đang hoạt động, nên phải qua cùng định
   * nghĩa dùng chung với funnel 1 — nếu trong lúc ghi danh bị đình
   * chỉ người dùng đã nhận cấp quyền giảng dạy bao phủ chính khoá
   * này (đường gán vai cho phép vì lúc đó ghi danh chưa hoạt động),
   * việc kích hoạt lại bị từ chối với mã
   * `access.role_context_conflict` thay vì lặng lẽ tạo trạng thái
   * lẫn vai. Chiều đình chỉ không qua chốt (đình chỉ chỉ làm giảm
   * trạng thái học viên).
   */
  async setSuspended(actorId: string, instanceId: string, userId: string, suspended: boolean): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    await this.requireManage(actorId, instance.courseId);
    const ue = await this.repo.getUserEnrolment(instanceId, userId);
    if (!ue || ue.status === ENROL_WITHDRAWN) throw new NotFoundException({ message: 'User enrolment not found', code: 'enrol.user_not_enrolled' });
    if (!suspended && ue.status !== ENROL_ACTIVE && await this.roleSeparation.isLearnerGrantRole(instance.roleId)) {
      await this.roleSeparation.assertLearnerEnrolmentAllowed(userId, instance.courseId);
    }
    await this.repo.dbHandle.transaction(async (tx) => {
      // modifierId = người thao tác: VẾT phân biệt đình chỉ THỦ CÔNG theo
      // khoá với đình chỉ do hệ thống đồng bộ áp (job đối soát
      // class-enrol-reconcile chỉ tôn trọng/không kích hoạt lại đúng các
      // dòng mang vết người này — issue #184, ca "miễn môn").
      await this.repo.updateUserEnrolment(ue.id, { status: suspended ? ENROL_SUSPENDED : ENROL_ACTIVE, modifierId: actorId }, tx);
      await this.outbox.enqueue(tx, {
        aggregate: 'enrol', type: suspended ? 'user_enrolment_suspended' : 'user_enrolment_reactivated',
        payload: { courseId: instance.courseId, userId, instanceId, actorId },
      });
    });
    return (await this.repo.getUserEnrolment(instanceId, userId))!;
  }

  /**
   * Unenrol: gỡ gán role do ghi danh cấp và phát
   * user_unenrolled. Dòng UE bị rút MỀM (status=2) khi user
   * có dữ liệu liên quan (completion v.v.) trong khoá học — probe được
   * CompletionModule đăng ký; khi không có probe/dữ liệu thì dòng bị
   * xoá cứng, đúng sự phân chia của Moodle giữa dữ liệu tham gia hiển thị
   * (được giữ) và tham gia vô hình (bị dọn).
   */
  /**
   * Rút ghi danh (kiểm capability).
   */
  async unenrolUser(actorId: string, instanceId: string, userId: string): Promise<{ withdrawn: boolean }> {
    const instance = await this.getInstance(instanceId);
    await this.requireManage(actorId, instance.courseId);
    return this.unenrolInternal(instance, userId, actorId);
  }

  /**
   * Rút ghi danh nội bộ không kiểm capability.
   */
  async unenrolInternal(instance: EnrolRow, userId: string, modifierId?: string): Promise<{ withdrawn: boolean }> {
    const ue = await this.repo.getUserEnrolment(instance.id, userId);
    if (!ue) return { withdrawn: false };
    const hasRelated = await this.hasRelatedData(instance.courseId, userId);
    await this.repo.dbHandle.transaction(async (tx) => {
      if (hasRelated) {
        await this.repo.updateUserEnrolment(ue.id, { status: ENROL_WITHDRAWN, modifierId: modifierId }, tx);
      }
      await this.outbox.enqueue(tx, {
        aggregate: 'enrol', type: 'user_unenrolled',
        payload: { courseId: instance.courseId, userId, instanceId: instance.id, keptData: hasRelated, actorId: modifierId ?? null },
      });
    });
    if (!hasRelated) await this.repo.deleteUserEnrolment(ue.id);
    // Chỉ gỡ gán role mà instance ghi danh này đã cấp
    // (component='enrol' + itemId=instance, theo phạm vi Moodle): gán của
    // cùng role do instance khác cấp hoặc cấp tay vẫn giữ nguyên,
    // nên user còn ghi danh qua instance khác vẫn giữ role
    // (issue #157). Các dòng cũ không có component/itemId tính là cấp tay
    // và cũng được để yên.
    if (instance.roleId) {
      const assignments = await this.roles.listAssignments({ userId: userId, contextId: await this.courses.courseContextId(instance.courseId) });
      for (const a of assignments as EnrolAssignmentRow[]) {
        if (isInstanceAssignment(a, instance)) await this.roles.unassignRole(a.id, modifierId, { allowEnrolManaged: true });
      }
    }
    // Các hook phía sau (đánh giá lại tiêu chí 'unenrol' của completion). Một
    // hook lỗi không được làm hỏng chính việc unenrol.
    for (const hook of this.unenrolHooks) {
      await hook({ courseId: instance.courseId, userId, instanceId: instance.id }).catch(() => undefined);
    }
    return { withdrawn: hasRelated };
  }

  // --- truy vấn ---------------------------------------------------------------------
  /**
   * Kiểm tra enrol THE (is_enrolled của Moodle): chỉ ghi danh, không bao giờ là capability.
   * onlyActive còn yêu cầu status=ACTIVE và thời điểm hiện tại trong
   * [timeStart, timeEnd]. Một bản ghi ở BẤT KỲ instance đang bật nào của khoá học đều tính.
   */
  /**
   * User có ghi danh đang hiệu lực và trong cửa sổ thời gian hay không.
   */
  async isEnrolled(courseId: string, userId: string, opts?: { onlyActive?: boolean; capability?: string }): Promise<boolean> {
    const instances = await this.repo.listInstances(courseId);
    const now = new Date();
    for (const instance of instances) {
      if (instance.status !== 0) continue;
      const ue = await this.repo.getUserEnrolment(instance.id, userId);
      if (!ue || ue.status === ENROL_WITHDRAWN) continue;
      if (opts?.onlyActive) {
        if (ue.status !== ENROL_ACTIVE) continue;
        if (ue.timeStart > now) continue;
        if (ue.timeEnd && ue.timeEnd < now) continue;
      }
      if (opts?.capability) {
        const ok = await this.evaluator.hasCapability(userId, opts.capability, await this.courses.courseContextId(courseId));
        if (!ok) continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Cổng xem danh sách ghi danh của khoá học qua API (issue #44): chỉ cho
   * (a) người thuộc khoá — ghi danh đang hiệu lực hoặc được gán vai tại
   * context khoá (giáo viên phụ trách không qua ghi danh), hoặc (b) người có
   * capability `enrol:manage` tại context khoá (site admin đạt qua
   * PermissionEvaluator). Người ngoài nhận 404 với đúng mã/thông điệp như
   * khoá không tồn tại (`course.not_found`) để không lộ khoá có tồn tại.
   */
  private async requireListEnrolmentsAccess(viewerId: string, courseId: string): Promise<void> {
    await this.courses.getCourse(courseId); // 404 course.not_found khi khoá không tồn tại
    if (await this.canManageEnrol(viewerId, courseId)) return;
    if (await this.isEnrolled(courseId, viewerId, { onlyActive: true })) return;
    const assignments = await this.roles.listAssignments({
      userId: viewerId,
      contextId: await this.courses.courseContextId(courseId),
    });
    if (assignments.length) return;
    throw new NotFoundException({ message: `Course ${courseId} not found`, code: 'course.not_found' });
  }

  /**
   * Ghi danh của khoá học. Khi truyền `viewerId` (đường API) thì áp cổng
   * `requireListEnrolmentsAccess`; khi không truyền (đường nội bộ tin cậy —
   * analytics/completion/grades) bản ghi được trả nguyên vẹn, cùng mẫu
   * `listInstances(courseId, viewerId?)`.
   */
  async listEnrolmentsForCourse(courseId: string, viewerId?: string): Promise<(UserEnrolmentRow & { enrolMethod: string })[]> {
    if (viewerId) await this.requireListEnrolmentsAccess(viewerId, courseId);
    return this.repo.listUserEnrolmentsForCourse(courseId);
  }
  /**
   * Ghi danh của user.
   */
  async listEnrolmentsForUser(userId: string): Promise<UserEnrolmentRow[]> {
    return this.repo.listUserEnrolmentsForUser(userId);
  }
  /**
   * Một ghi danh cụ thể của user trong khoá học.
   */
  async getUserEnrolment(instanceId: string, userId: string): Promise<UserEnrolmentRow | undefined> {
    return this.repo.getUserEnrolment(instanceId, userId);
  }

  /** Quét hết hạn (cùng logic processor enrol-expiry của worker chạy trên schema dùng chung). Trả các id đã chuyển. */
  /**
   * Xử lý các ghi danh quá hạn (worker enrol-expiry gọi): đình chỉ/rút theo cấu hình instance.
   */
  async expireEnrolments(now = new Date()): Promise<string[]> {
    const expired = await this.repo.listExpiredActive(now);
    const flipped: string[] = [];
    for (const ue of expired) {
      const instance = await this.repo.getInstance(ue.enrolId);
      await this.repo.dbHandle.transaction(async (tx) => {
        await this.repo.updateUserEnrolment(ue.id, { status: ENROL_SUSPENDED }, tx);
        await this.outbox.enqueue(tx, {
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { courseId: instance?.courseId, userId: ue.userId, instanceId: ue.enrolId, reason: 'expired' },
        });
      });
      flipped.push(ue.id);
    }
    return flipped;
  }

  // --- listener đồng bộ cohort ----------------------------------------------------------
  @OnEvent('cohort_member_added')
  /**
   * Sự kiện thành viên cohort mới → ghi danh vào mọi khoá học có instance cohort tương ứng.
   */
  async onCohortMemberAdded(payload: { cohortId: string; userId: string }): Promise<void> {
    // Guard trạng thái hiện tại (CLASS-0, #184): sự kiện có thể được
    // consumer outbox phát lại MUỘN, sau khi user đã rời cohort —
    // không ghi danh cho người hiện không còn trong cohort.
    if (!(await this.groups.isCohortMember(payload.cohortId, payload.userId))) return;
    const instances = await this.repo.listCohortInstances(payload.cohortId);
    for (const instance of instances) {
      if (instance.status !== 0) continue;
      // Đồng bộ hàng loạt: thành viên vi phạm chốt tách vai bị bỏ qua
      // riêng lẻ (xem enrolFromCohortSync) — sự kiện phát lại không
      // được chết vì một thành viên đã trở thành giáo viên của khoá.
      await this.enrolFromCohortSync(instance, payload.userId);
    }
  }

  @OnEvent('cohort_member_removed')
  /**
   * Sự kiện rời cohort → rút/đình chỉ ghi danh cohort tương ứng.
   */
  async onCohortMemberRemoved(payload: { cohortId: string; userId: string }): Promise<void> {
    // Guard trạng thái hiện tại (CLASS-0, #184): sự kiện removed phát
    // lại muộn KHÔNG được đình chỉ người đã vào lại cohort — nguồn sự
    // thật là cohort_members hiện tại, không phải thứ tự tới của sự
    // kiện (đường in-process và consumer outbox có thể đan nhau).
    if (await this.groups.isCohortMember(payload.cohortId, payload.userId)) return;
    const instances = await this.repo.listCohortInstances(payload.cohortId);
    for (const instance of instances) {
      const ue = await this.repo.getUserEnrolment(instance.id, payload.userId);
      if (!ue || ue.status === ENROL_WITHDRAWN) continue;
      if (instance.customText1 === 'unenrol') {
        await this.unenrolInternal(instance, payload.userId);
      } else {
        // Đình chỉ do ĐỒNG BỘ HỆ THỐNG: xoá vết modifierId (về null) để
        // job đối soát phân biệt được với đình chỉ thủ công theo khoá
        // (vết = actorId do setSuspended ghi) — issue #184.
        await this.repo.updateUserEnrolment(ue.id, { status: ENROL_SUSPENDED, modifierId: null });
        await this.outbox.enqueueStandalone({
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { courseId: instance.courseId, userId: payload.userId, instanceId: instance.id, reason: 'cohort_removed' },
        });
      }
    }
  }
}
