import { BadRequestException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { RolesService } from '../access/roles.service';
import { CoursesService } from '../courses/courses.service';
import { GroupsService } from '../groups/groups.service';
import { EnrolRepository, type EnrolRow, type UserEnrolmentRow } from './enrol.repository';

export const ENROL_ACTIVE = 0;
export const ENROL_SUSPENDED = 1;
export const ENROL_WITHDRAWN = 2;
export const ENROL_METHODS = ['manual', 'cohort', 'self', 'guest', 'fee'] as const;
export type EnrolMethod = (typeof ENROL_METHODS)[number];

/**
 * EnrolModule facade (Moodle core_enrol).
 *
 * Invariants (report §2#5):
 *  - Enrolment ≠ role assignment ≠ authentication. Enrolling grants a role
 *    at the course context through the Access facade; `isEnrolled` checks
 *    ONLY the enrolment records (status + time window).
 *  - SUSPENDED users cannot access the course (CoursesService gate uses
 *    isEnrolled(onlyActive)) even though their role assignment remains.
 *  - Unenrol keeps contribution data: when the user has completion records
 *    in the course (checked via a registered probe from CompletionModule) or
 *    always under the current enrol rules, the user_enrolments row is kept as WITHDRAWN
 *    (soft state) instead of being hard-deleted, and `user_unenrolled` is
 *    emitted. The role assignment granted BY this enrolment is removed.
 *  - Expired enrolments (timeend in the past) are not active; the worker
 *    job `enrol-expiry` also flips them to SUSPENDED in bulk.
 */
@Injectable()
/**
 * Nghiệp vụ ghi danh (enrolment).
 * Đối chiếu Moodle: lib/enrollib.php (enrol_get_plugin, user_enrolment) và các plugin enrol_manual/enrol_self/enrol_cohort.
 * Trạng thái ghi danh: 0 = đang hiệu lực, 1 = tạm đình chỉ, 2 = đã rút; ghi danh có thể có cửa sổ thời gian (timestart/timeend).
 * Cohort sync: thành viên cohort được tự động ghi danh qua instance cohort; rời cohort thì ghi danh cohort bị rút
 * (chỉ rút khi user không còn dữ liệu liên quan — bài nộp/điểm — theo probe dữ liệu liên quan, khớp hành vi Moodle).
 */
export class EnrolService implements OnModuleInit {
  /** Probe registered by CompletionModule: does this user have completion data in this course? */
  /** Related-data probes (Completion, Grades, …): ANY probe reporting data keeps the UE row withdrawn-not-deleted. */
  private relatedDataProbes: ((courseId: number, userId: number) => Promise<boolean>)[] = [];

  constructor(
    private readonly repo: EnrolRepository,
    private readonly courses: CoursesService,
    private readonly roles: RolesService,
    private readonly evaluator: PermissionEvaluator,
    private readonly groups: GroupsService,
    private readonly outbox: OutboxService,
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
  registerRelatedDataProbe(probe: (courseId: number, userId: number) => Promise<boolean>): void {
    this.relatedDataProbes.push(probe);
  }
  /**
   * User còn dữ liệu liên quan (điểm/bài nộp) trong khoá học hay không — quyết định rút hẳn hay chỉ đình chỉ khi rời cohort.
   */
  async hasRelatedData(courseId: number, userId: number): Promise<boolean> {
    for (const probe of this.relatedDataProbes) {
      if (await probe(courseId, userId)) return true;
    }
    return false;
  }

  private async requireManage(actorId: number, courseId: number): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'lms/enrol:manage', await this.courses.courseContextId(courseId));
  }
  private async defaultStudentRoleId(): Promise<number> {
    const roleRow = await this.roles.getRoleByShortname('student');
    if (!roleRow) throw new Error('student role not seeded');
    return roleRow.id;
  }

  // --- instances ----------------------------------------------------------------
  /**
   * Tạo enrol instance cho khoá học (manual/self/cohort/paypal).
   */
  async createInstance(actorId: number, courseId: number, input: {
    method: string; name?: string; roleShortname?: string; status?: number; enrolperiod?: number;
    cohortId?: number; groupId?: number; onCohortLeave?: 'suspend' | 'unenrol';
    cost?: number; currency?: string; paymentAccountId?: number;
  }): Promise<EnrolRow> {
    await this.courses.getCourse(courseId);
    await this.requireManage(actorId, courseId);
    if (!ENROL_METHODS.includes(input.method as EnrolMethod)) {
      throw new BadRequestException({ message: `Unknown enrol method ${input.method}`, code: 'enrol.unknown_method' });
    }
    if (input.method === 'cohort' && !input.cohortId) {
      throw new BadRequestException({ message: 'A cohort enrol instance requires cohortId', code: 'enrol.cohort_required' });
    }
    let roleid: number | undefined;
    if (input.roleShortname) {
      const roleRow = await this.roles.getRoleByShortname(input.roleShortname);
      if (!roleRow) throw new BadRequestException({ message: `Role ${input.roleShortname} not found`, code: 'enrol.role_not_found' });
      roleid = roleRow.id;
    } else {
      roleid = await this.defaultStudentRoleId();
    }
    if (input.method === 'fee' && (!input.cost || input.cost <= 0 || !input.currency)) {
      throw new BadRequestException({ message: 'A fee enrol instance requires a positive integer cost and a currency', code: 'enrol.fee_config_required' });
    }
    const instance = await this.repo.insertInstance({
      courseid: courseId, enrol: input.method, name: input.name ?? null, roleid,
      status: input.status ?? 0, enrolperiod: input.enrolperiod ?? 0,
      customint1: input.method === 'cohort' ? (input.cohortId ?? 0) : 0,
      customint2: input.groupId ?? 0,
      customtext1: input.onCohortLeave ?? 'suspend',
      cost: input.cost ?? 0, currency: input.currency ?? '', paymentaccountid: input.paymentAccountId ?? null,
    });
    await this.outbox.enqueueStandalone({ aggregate: 'enrol', type: 'enrol_instance_created', payload: { instanceId: instance.id, courseId, method: input.method } });
    // Cohort sync: enrol everyone already in the cohort.
    if (input.method === 'cohort' && input.cohortId) {
      const members = await this.groups.listCohortMembers(input.cohortId);
      for (const m of members) await this.enrolUserInternal(instance, m.userid, actorId);
    }
    return instance;
  }
  /**
   * Lấy instance; ném enrol.instance_not_found khi vắng.
   */
  async getInstance(id: number): Promise<EnrolRow> {
    const row = await this.repo.getInstance(id);
    if (!row) throw new NotFoundException({ message: `Enrol instance ${id} not found`, code: 'enrol.instance_not_found' });
    return row;
  }
  /**
   * Liệt kê instance của khoá học.
   */
  async listInstances(courseId: number): Promise<EnrolRow[]> { return this.repo.listInstances(courseId); }
  /**
   * Cập nhật instance.
   */
  async updateInstance(actorId: number, id: number, input: { name?: string; status?: number; enrolperiod?: number; onCohortLeave?: 'suspend' | 'unenrol'; groupId?: number }): Promise<EnrolRow> {
    const instance = await this.getInstance(id);
    await this.requireManage(actorId, instance.courseid);
    const patch: Partial<EnrolRow> = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.status !== undefined) patch.status = input.status;
    if (input.enrolperiod !== undefined) patch.enrolperiod = input.enrolperiod;
    if (input.onCohortLeave !== undefined) patch.customtext1 = input.onCohortLeave;
    if (input.groupId !== undefined) patch.customint2 = input.groupId;
    if (Object.keys(patch).length) await this.repo.updateInstance(id, patch);
    return this.getInstance(id);
  }
  /**
   * Xoá instance.
   */
  async deleteInstance(actorId: number, id: number): Promise<void> {
    const instance = await this.getInstance(id);
    await this.requireManage(actorId, instance.courseid);
    await this.repo.deleteInstance(id);
  }

  // --- enrol / unenrol ----------------------------------------------------------
  /** Core enrol path (also used by cohort sync). Assigns the instance role at the course context via the Access facade. */
  /**
   * Ghi danh nội bộ không kiểm capability (dùng cho cohort sync và thanh toán đã xác nhận).
   */
  async enrolUserInternal(instance: EnrolRow, userId: number, modifierId?: number, opts?: { timestart?: Date; timeend?: Date }): Promise<UserEnrolmentRow> {
    if (instance.status !== 0) throw new BadRequestException({ message: 'Enrol instance is disabled', code: 'enrol.instance_disabled' });
    const timestart = opts?.timestart ?? new Date();
    const timeend = opts?.timeend ?? (instance.enrolperiod > 0 ? new Date(timestart.getTime() + instance.enrolperiod * 1000) : null);
    const existing = await this.repo.getUserEnrolment(instance.id, userId);
    let ue: UserEnrolmentRow;
    if (existing) {
      await this.repo.updateUserEnrolment(existing.id, { status: ENROL_ACTIVE, timestart, timeend, modifierid: modifierId });
      ue = (await this.repo.getUserEnrolment(instance.id, userId))!;
    } else {
      ue = await this.repo.dbHandle.transaction(async (tx) => {
        const row = await this.repo.insertUserEnrolment({ enrolid: instance.id, userid: userId, status: ENROL_ACTIVE, timestart, timeend, modifierid: modifierId }, tx as never);
        await this.outbox.enqueue(tx as never, { aggregate: 'enrol', type: 'user_enrolled', payload: { courseId: instance.courseid, userId, instanceId: instance.id, method: instance.enrol } });
        return row;
      });
    }
    if (instance.roleid) {
      const courseCtxId = await this.courses.courseContextId(instance.courseid);
      await this.roles.assignRole(userId, instance.roleid, courseCtxId, modifierId);
    }
    if (instance.customint2) {
      await this.groups.addMemberInternal(instance.customint2, userId, 'enrol_cohort', instance.id).catch(() => undefined);
    }
    return ue;
  }

  /**
   * Ghi danh thủ công một user (kiểm capability enrol).
   */
  async enrolUser(actorId: number, instanceId: number, userId: number, opts?: { timestart?: string; timeend?: string }): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    await this.requireManage(actorId, instance.courseid);
    return this.enrolUserInternal(instance, userId, actorId, {
      timestart: opts?.timestart ? new Date(opts.timestart) : undefined,
      timeend: opts?.timeend ? new Date(opts.timeend) : undefined,
    });
  }

  /** Self-enrolment through a 'self' instance (minimal frame): the user enrols themselves when the instance is enabled. */
  /**
   * Tự ghi danh: kiểm instance self còn mở, khoá ghi danh (enrol password) và cửa sổ thời gian.
   */
  async selfEnrol(userId: number, instanceId: number): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    if (instance.enrol === 'fee') {
      // Enrol có phí chỉ kích hoạt qua PaymentSucceeded đã xác thực (§2#27) — không tự ghi danh trực tiếp.
      throw new BadRequestException({ message: 'Fee enrol instance requires a succeeded payment before enrolment is activated', code: 'enrol.payment_required' });
    }
    if (instance.enrol !== 'self') throw new BadRequestException({ message: 'Instance is not a self-enrol instance', code: 'enrol.not_self' });
    return this.enrolUserInternal(instance, userId, userId);
  }

  /** Kích hoạt ghi danh sau thanh toán thành công — chỉ PaymentsModule gọi sau webhook đã xác thực/idempotent. */
  /**
   * Kích hoạt ghi danh sau khi thanh toán PayPal được xác nhận.
   */
  async activatePaidEnrol(instanceId: number, userId: number): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    if (instance.enrol !== 'fee') throw new BadRequestException({ message: 'Instance is not a fee enrol instance', code: 'enrol.not_fee' });
    const existing = await this.repo.getUserEnrolment(instanceId, userId);
    if (existing && existing.status === ENROL_ACTIVE) return existing;
    return this.enrolUserInternal(instance, userId, userId);
  }

  /**
   * Đình chỉ hoặc kích hoạt lại một ghi danh.
   */
  async setSuspended(actorId: number, instanceId: number, userId: number, suspended: boolean): Promise<UserEnrolmentRow> {
    const instance = await this.getInstance(instanceId);
    await this.requireManage(actorId, instance.courseid);
    const ue = await this.repo.getUserEnrolment(instanceId, userId);
    if (!ue || ue.status === ENROL_WITHDRAWN) throw new NotFoundException({ message: 'User enrolment not found', code: 'enrol.user_not_enrolled' });
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.updateUserEnrolment(ue.id, { status: suspended ? ENROL_SUSPENDED : ENROL_ACTIVE }, tx as never);
      await this.outbox.enqueue(tx as never, {
        aggregate: 'enrol', type: suspended ? 'user_enrolment_suspended' : 'user_enrolment_reactivated',
        payload: { courseId: instance.courseid, userId, instanceId },
      });
    });
    return (await this.repo.getUserEnrolment(instanceId, userId))!;
  }

  /**
   * Unenrol: removes the enrolment-granted role assignment and emits
   * user_unenrolled. The UE row is SOFT-withdrawn (status=2) when the user
   * has related data (completion etc.) in the course — the probe is
   * registered by CompletionModule; when no probe/data exists the row is
   * hard-deleted, exactly Moodle's split between visible participation data
   * (kept) and invisible participation (purged).
   */
  /**
   * Rút ghi danh (kiểm capability).
   */
  async unenrolUser(actorId: number, instanceId: number, userId: number): Promise<{ withdrawn: boolean }> {
    const instance = await this.getInstance(instanceId);
    await this.requireManage(actorId, instance.courseid);
    return this.unenrolInternal(instance, userId, actorId);
  }

  /**
   * Rút ghi danh nội bộ không kiểm capability.
   */
  async unenrolInternal(instance: EnrolRow, userId: number, modifierId?: number): Promise<{ withdrawn: boolean }> {
    const ue = await this.repo.getUserEnrolment(instance.id, userId);
    if (!ue) return { withdrawn: false };
    const hasRelated = await this.hasRelatedData(instance.courseid, userId);
    await this.repo.dbHandle.transaction(async (tx) => {
      if (hasRelated) {
        await this.repo.updateUserEnrolment(ue.id, { status: ENROL_WITHDRAWN, modifierid: modifierId }, tx as never);
      }
      await this.outbox.enqueue(tx as never, {
        aggregate: 'enrol', type: 'user_unenrolled',
        payload: { courseId: instance.courseid, userId, instanceId: instance.id, keptData: hasRelated },
      });
    });
    if (!hasRelated) await this.repo.deleteUserEnrolment(ue.id);
    // Remove the role assignment this enrolment granted (component-scoped in
    // Moodle; here: the instance role at the course context).
    if (instance.roleid) {
      const assignments = await this.roles.listAssignments({ userid: userId, contextid: await this.courses.courseContextId(instance.courseid) });
      for (const a of assignments as { id: number; roleid: number }[]) {
        if (a.roleid === instance.roleid) await this.roles.unassignRole(a.id);
      }
    }
    return { withdrawn: hasRelated };
  }

  // --- queries ---------------------------------------------------------------------
  /**
   * THE enrol check (Moodle is_enrolled): enrolment only, never capability.
   * onlyActive additionally requires status=ACTIVE and now within
   * [timestart, timeend]. A record in ANY enabled instance of the course counts.
   */
  /**
   * User có ghi danh đang hiệu lực và trong cửa sổ thời gian hay không.
   */
  async isEnrolled(courseId: number, userId: number, opts?: { onlyActive?: boolean; capability?: string }): Promise<boolean> {
    const instances = await this.repo.listInstances(courseId);
    const now = new Date();
    for (const instance of instances) {
      if (instance.status !== 0) continue;
      const ue = await this.repo.getUserEnrolment(instance.id, userId);
      if (!ue || ue.status === ENROL_WITHDRAWN) continue;
      if (opts?.onlyActive) {
        if (ue.status !== ENROL_ACTIVE) continue;
        if (ue.timestart > now) continue;
        if (ue.timeend && ue.timeend < now) continue;
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
   * Ghi danh của khoá học.
   */
  async listEnrolmentsForCourse(courseId: number): Promise<(UserEnrolmentRow & { enrolMethod: string })[]> {
    return this.repo.listUserEnrolmentsForCourse(courseId);
  }
  /**
   * Ghi danh của user.
   */
  async listEnrolmentsForUser(userId: number): Promise<UserEnrolmentRow[]> {
    return this.repo.listUserEnrolmentsForUser(userId);
  }
  /**
   * Một ghi danh cụ thể của user trong khoá học.
   */
  async getUserEnrolment(instanceId: number, userId: number): Promise<UserEnrolmentRow | undefined> {
    return this.repo.getUserEnrolment(instanceId, userId);
  }

  /** Expiry sweep (same logic the worker's enrol-expiry processor runs on its own schema copy). Returns flipped ids. */
  /**
   * Xử lý các ghi danh quá hạn (worker enrol-expiry gọi): đình chỉ/rút theo cấu hình instance.
   */
  async expireEnrolments(now = new Date()): Promise<number[]> {
    const expired = await this.repo.listExpiredActive(now);
    const flipped: number[] = [];
    for (const ue of expired) {
      const instance = await this.repo.getInstance(ue.enrolid);
      await this.repo.dbHandle.transaction(async (tx) => {
        await this.repo.updateUserEnrolment(ue.id, { status: ENROL_SUSPENDED }, tx as never);
        await this.outbox.enqueue(tx as never, {
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { courseId: instance?.courseid, userId: ue.userid, instanceId: ue.enrolid, reason: 'expired' },
        });
      });
      flipped.push(ue.id);
    }
    return flipped;
  }

  // --- cohort sync listeners ----------------------------------------------------------
  @OnEvent('cohort_member_added')
  /**
   * Sự kiện thành viên cohort mới → ghi danh vào mọi khoá học có instance cohort tương ứng.
   */
  async onCohortMemberAdded(payload: { cohortId: number; userId: number }): Promise<void> {
    const instances = await this.repo.listCohortInstances(payload.cohortId);
    for (const instance of instances) {
      if (instance.status !== 0) continue;
      await this.enrolUserInternal(instance, payload.userId);
    }
  }

  @OnEvent('cohort_member_removed')
  /**
   * Sự kiện rời cohort → rút/đình chỉ ghi danh cohort tương ứng.
   */
  async onCohortMemberRemoved(payload: { cohortId: number; userId: number }): Promise<void> {
    const instances = await this.repo.listCohortInstances(payload.cohortId);
    for (const instance of instances) {
      const ue = await this.repo.getUserEnrolment(instance.id, payload.userId);
      if (!ue || ue.status === ENROL_WITHDRAWN) continue;
      if (instance.customtext1 === 'unenrol') {
        await this.unenrolInternal(instance, payload.userId);
      } else {
        await this.repo.updateUserEnrolment(ue.id, { status: ENROL_SUSPENDED });
        await this.outbox.enqueueStandalone({
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { courseId: instance.courseid, userId: payload.userId, instanceId: instance.id, reason: 'cohort_removed' },
        });
      }
    }
  }
}
