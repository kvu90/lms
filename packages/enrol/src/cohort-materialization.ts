import { and, eq } from 'drizzle-orm';
import { cohortMembers, course, enrol, groupsMembers, userEnrolments } from '@lms/db';
import { getCourseContextId } from './contexts';
import { isRoleContextConflictError, SharedDomainError } from './errors';
import { PlanLimitsCore } from './plan-limits';
import { hasRelatedCourseData } from './related-data';
import { ENROL_ASSIGNMENT_COMPONENT, RoleAssignmentCore } from './role-assignment';
import { RoleSeparationCore } from './role-separation';
import { ensureActiveTenantMembership } from './tenant-membership';
import type {
  EnrolDatabase, EnrolInstanceRow, RoleAssignmentRow, SharedOutboxPort, SharedSurfaceDeps, UserEnrolmentRow,
} from './types';

/** Trạng thái ghi danh đang hiệu lực. */
export const ENROL_ACTIVE = 0;
/** Trạng thái ghi danh bị đình chỉ (không truy cập được khoá, gán vai vẫn còn). */
export const ENROL_SUSPENDED = 1;
/** Trạng thái ghi danh đã rút nhưng dòng được giữ vì user còn dữ liệu liên quan trong khoá. */
export const ENROL_WITHDRAWN = 2;

/**
 * Loại sự kiện outbox yêu cầu tái tổng hợp hoàn thành khoá học cho
 * một người dùng sau khi gỡ ghi danh. Sự kiện được phát trong CÙNG
 * transaction với thao tác gỡ ghi danh (xem `unenrolInternal`), phía
 * API tiêu thụ qua consumer có watermark `seq` riêng — nó KHÔNG nằm
 * trong bảng định tuyến relay của worker.
 */
export const COURSE_COMPLETION_REAGGREGATION_REQUESTED = 'course_completion_reaggregation_requested';

/** Tay cầm ghi/đọc tối thiểu dùng được cả ở DB gốc lẫn trong transaction. */
type DbOrTx = Pick<EnrolDatabase, 'insert' | 'update' | 'select' | 'delete'>;

/** Dòng gán vai thuộc về một enrol instance: đúng dòng này (và chỉ dòng này) bị gỡ khi instance rút/đổi vai. */
function isInstanceAssignment(a: RoleAssignmentRow, instance: EnrolInstanceRow): boolean {
  return a.roleId === instance.roleId && a.component === ENROL_ASSIGNMENT_COMPONENT && a.itemId === instance.id;
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

/**
 * Bề mặt VẬT CHẤT HOÁ COHORT dùng chung: biến quan hệ thành viên
 * cohort thành ghi danh cấp khoá — và biến việc rời cohort thành rút
 * hoặc đình chỉ ghi danh — bằng đúng một định nghĩa duy nhất chạy
 * được từ mọi tiến trình có tầng dữ liệu (API hôm nay qua listener
 * in-process và consumer outbox của nó; worker khi consumer đồng bộ
 * cohort của worker được dựng trên bề mặt này).
 *
 * Bề mặt gồm ba tầng hành vi, giữ nguyên từng bất biến của đường
 * đồng bộ cohort hiện hành:
 *
 * 1. Funnel ghi danh lõi (`enrolUserInternal`): mọi đường ghi danh
 *    (tay, tự ghi danh, kích hoạt sau thanh toán, đồng bộ cohort)
 *    hội tụ về đây. Chốt tách vai áp trước khi bất kỳ bản ghi nào
 *    được tạo; dòng ghi danh mới và sự kiện `user_enrolled` ghi
 *    trong cùng một transaction; membership tenant của khoá được
 *    đảm bảo active; vai của instance được cấp tại context khoá với
 *    truy vết nguồn của chính instance; nhóm "cả lớp" của instance
 *    (nếu có) nhận thêm thành viên.
 * 2. Đường gỡ ghi danh lõi (`unenrolInternal`): còn dữ liệu liên
 *    quan (hoàn thành/điểm — truy vấn dữ liệu dùng chung ở
 *    `related-data.ts`) thì giữ dòng dạng WITHDRAWN, không còn thì
 *    xoá cứng; sự kiện `user_unenrolled` ghi cùng transaction; chỉ
 *    gỡ đúng dòng gán vai do chính instance này cấp; và sự kiện
 *    `course_completion_reaggregation_requested` được phát trong
 *    cùng transaction để phía API tái tổng hợp hoàn thành khoá cho
 *    người dùng (tiêu chí 'unenrol' của Moodle: rời khoá tự nó có
 *    thể làm hoàn thành khoá đó) — thay cho hook đồng bộ trong
 *    tiến trình trước đây, vì hook đó chỉ tồn tại trong tiến trình
 *    API và không mang theo được sang tiến trình khác.
 * 3. Hai điểm vào vật chất hoá theo sự kiện thành viên cohort
 *    (`materializeCohortMemberAdded`/`materializeCohortMemberRemoved`):
 *    cả hai đều neo vào TRẠNG THÁI HIỆN TẠI của `cohort_members`
 *    (sự kiện phát lại muộn không được ghi danh cho người đã rời,
 *    cũng không được đình chỉ người đã vào lại), và việc thêm thành
 *    viên bỏ qua riêng lẻ thành viên vi phạm chốt tách vai thay vì
 *    làm hỏng cả vòng lặp đồng bộ.
 *
 * Mọi điểm chặn mà funnel đi qua (tách vai, slot gói, toàn vẹn gán
 * do ghi danh cấp) đều là các lõi dùng chung của package này — bề
 * mặt không định nghĩa lại bất kỳ kiểm nào.
 */
export class CohortMaterializationSurface {
  private readonly db: EnrolDatabase;
  private readonly outbox: SharedOutboxPort;
  private readonly planLimits: PlanLimitsCore;
  private readonly roleSeparation: RoleSeparationCore;
  private readonly roleAssignment: RoleAssignmentCore;

  /**
   * @param deps - bộ phụ thuộc host cấp: tay cầm Drizzle, cổng outbox, cổng ngữ cảnh platform.
   */
  constructor(deps: SharedSurfaceDeps) {
    this.db = deps.db;
    this.outbox = deps.outbox;
    this.planLimits = new PlanLimitsCore(deps.db, deps.runInPlatformScope);
    this.roleSeparation = new RoleSeparationCore(deps.db, deps.runInPlatformScope);
    this.roleAssignment = new RoleAssignmentCore(deps.db, deps.outbox, this.planLimits, this.roleSeparation);
  }

  /** Lõi tách vai dùng chung mà bề mặt này áp (host dùng lại cho các chốt ngoài funnel). */
  get roleSeparationChecks(): RoleSeparationCore {
    return this.roleSeparation;
  }

  /** Lõi gán vai dùng chung mà bề mặt này áp (host dùng lại cho các đường gán ngoài funnel). */
  get roleAssignmentCore(): RoleAssignmentCore {
    return this.roleAssignment;
  }

  /** Lõi giới hạn slot dùng chung mà bề mặt này áp (host dùng lại cho các điểm chặn ngoài funnel). */
  get planLimitsCore(): PlanLimitsCore {
    return this.planLimits;
  }

  /**
   * Lấy ghi danh của một người dùng qua một instance; undefined khi
   * chưa từng ghi danh qua instance đó.
   */
  private async getUserEnrolment(instanceId: string, userId: string): Promise<UserEnrolmentRow | undefined> {
    const [row] = await this.db.select().from(userEnrolments)
      .where(and(eq(userEnrolments.enrolId, instanceId), eq(userEnrolments.userId, userId)));
    return row;
  }

  /** Cập nhật một dòng ghi danh (trạng thái, thời hạn, vết người thao tác). */
  private async updateUserEnrolment(
    handle: DbOrTx,
    id: string,
    v: Partial<typeof userEnrolments.$inferInsert>,
  ): Promise<void> {
    await handle.update(userEnrolments).set({ ...v, updatedAt: new Date() }).where(eq(userEnrolments.id, id));
  }

  /**
   * Đường ghi danh lõi (cũng dùng cho đồng bộ cohort). Cấp role của
   * instance tại context khoá học qua lõi gán vai dùng chung.
   *
   * Flow: instance bị tắt → lỗi `enrol.instance_disabled`. Instance
   * cấp vai học viên → chốt tách vai (người đã có cấp quyền giảng
   * dạy bao phủ chính khoá đích bị từ chối với mã
   * `access.role_context_conflict`, TRƯỚC khi bất kỳ bản ghi ghi
   * danh hay dòng gán vai nào được tạo; instance cấp vai giảng dạy
   * là đường cấp vai của quản trị, nằm ngoài quyết định tách vai,
   * nên không qua chốt). Đã có ghi danh → kích hoạt lại và tính lại
   * cửa sổ thời gian theo `enrolPeriod` của instance. Chưa có →
   * chèn dòng ghi danh + phát `user_enrolled` trong cùng một
   * transaction; đua ghi đồng thời (hai phía cùng qua cửa "chưa có"
   * rồi cùng chèn) ăn unique violation ở phía thua thì nối vào
   * đường cập nhật idempotent thay vì để lỗi lọt ra ngoài (phía
   * thắng đã phát `user_enrolled`). Sau đó: đảm bảo membership
   * active tại tenant của khoá, cấp vai của instance tại context
   * khoá với truy vết của chính instance, và xếp người dùng vào
   * nhóm đích của instance (lỗi xếp nhóm bị nuốt — xếp nhóm là hệ
   * quả phụ, không được làm hỏng ghi danh).
   *
   * @param instance - enrol instance đích.
   * @param userId - người dùng được ghi danh.
   * @param modifierId - người thao tác (truy vết; vắng mặt khi là đồng bộ hệ thống).
   * @param opts - cửa sổ thời gian tường minh; bỏ trống thì suy từ `enrolPeriod` của instance.
   * @returns dòng ghi danh sau ghi danh và cờ cho biết đây có phải ghi danh MỚI hay không
   * (host dùng cờ này cho các hệ quả chỉ áp cho ghi danh mới, vd tin nhắn chào mừng).
   * @throws SharedDomainError mã `enrol.instance_disabled`, hoặc lỗi của các điểm
   * chặn dùng chung (tách vai, slot, gán vai).
   */
  async enrolUserInternal(
    instance: EnrolInstanceRow,
    userId: string,
    modifierId?: string,
    opts?: { timeStart?: Date; timeEnd?: Date },
  ): Promise<{ userEnrolment: UserEnrolmentRow; isNewEnrolment: boolean }> {
    if (instance.status !== 0) {
      throw new SharedDomainError('enrol.instance_disabled', 'Enrol instance is disabled');
    }
    // Chốt TÁCH VAI — funnel 1 (RoleSeparationCore giữ định nghĩa
    // dùng chung): mọi đường ghi danh đều hội tụ về hàm này (ghi
    // danh tay, tự ghi danh, kích hoạt sau thanh toán, đồng bộ
    // cohort), nên chốt tại đây phủ toàn bộ các đường đó. Chỉ áp khi
    // instance cấp vai HỌC VIÊN.
    if (await this.roleSeparation.isLearnerGrantRole(instance.roleId)) {
      await this.roleSeparation.assertLearnerEnrolmentAllowed(userId, instance.courseId);
    }
    const timeStart = opts?.timeStart ?? new Date();
    const timeEnd = opts?.timeEnd ?? (instance.enrolPeriod > 0 ? new Date(timeStart.getTime() + instance.enrolPeriod * 1000) : null);
    const existing = await this.getUserEnrolment(instance.id, userId);
    let ue: UserEnrolmentRow;
    let isNewEnrolment = false;
    if (existing) {
      await this.updateUserEnrolment(this.db, existing.id, { status: ENROL_ACTIVE, timeStart, timeEnd, modifierId });
      ue = (await this.getUserEnrolment(instance.id, userId))!;
    } else {
      try {
        ue = await this.db.transaction(async (tx) => {
          const [row] = await tx.insert(userEnrolments)
            .values({ enrolId: instance.id, userId, status: ENROL_ACTIVE, timeStart, timeEnd, modifierId })
            .returning();
          await this.outbox.enqueue(tx, {
            aggregate: 'enrol', type: 'user_enrolled',
            payload: { courseId: instance.courseId, userId, instanceId: instance.id, method: instance.enrol, actorId: modifierId ?? null },
          });
          return row!;
        });
        isNewEnrolment = true;
      } catch (err) {
        // Đua ghi đồng thời: consumer outbox phát lại sự kiện cohort
        // trong lúc request tạo instance đang backfill cùng một học
        // sinh — cả hai cùng qua cửa "chưa có UE" rồi cùng insert,
        // một phía ăn unique violation trên (enrol_id, user_id). Nối
        // vào đường cập nhật idempotent thay vì để lỗi lọt ra ngoài;
        // phía thắng đã phát user_enrolled.
        if (!isUniqueViolation(err)) throw err;
        const winner = await this.getUserEnrolment(instance.id, userId);
        if (!winner) throw err;
        await this.updateUserEnrolment(this.db, winner.id, { status: ENROL_ACTIVE, timeStart, timeEnd, modifierId });
        ue = (await this.getUserEnrolment(instance.id, userId))!;
      }
    }
    // Ghi danh vào khoá của tenant nào thì thuộc tenant đó:
    // membership active được đảm bảo ngay tại đây để cổng membership
    // của phép đánh giá quyền cho qua các vai ghi danh vừa cấp.
    const [courseRow] = await this.db.select({ tenantId: course.tenantId }).from(course).where(eq(course.id, instance.courseId));
    if (courseRow?.tenantId) await ensureActiveTenantMembership(this.db, courseRow.tenantId, userId);
    if (instance.roleId) {
      const courseCtxId = await getCourseContextId(this.db, instance.courseId);
      // Dòng gán mang truy vết của chính instance này — unenrol/đổi
      // vai sau đó chỉ gỡ đúng dòng đó, không đụng gán của instance
      // khác hay gán tay cùng role.
      await this.roleAssignment.assignRole(userId, instance.roleId, courseCtxId, modifierId, {
        component: ENROL_ASSIGNMENT_COMPONENT, itemId: instance.id,
      });
    }
    if (instance.customInt2) {
      await this.db.insert(groupsMembers)
        .values({ groupId: instance.customInt2, userId, component: 'enrol_cohort', itemId: instance.id })
        .onConflictDoNothing()
        .catch(() => undefined);
    }
    return { userEnrolment: ue, isNewEnrolment };
  }

  /**
   * Ghi danh một thành viên cohort qua đường đồng bộ hàng loạt
   * (backfill khi tạo/khôi phục instance cohort, vật chất hoá sự
   * kiện cohort): một thành viên vi phạm chốt tách vai bị BỎ QUA
   * riêng lẻ — vòng lặp đồng bộ không được hỏng vì một thành viên,
   * và các caller trực tiếp một người (ghi danh tay, tự ghi danh,
   * thanh toán) vẫn nhận lỗi tường minh từ `enrolUserInternal`. Mọi
   * lỗi khác ngoài xung đột vai đều nổi lên như cũ.
   *
   * @param instance - enrol instance cohort đích.
   * @param userId - thành viên cohort được ghi danh.
   * @param modifierId - người thao tác (khi backfill từ một thao tác quản trị).
   */
  async enrolFromCohortSync(instance: EnrolInstanceRow, userId: string, modifierId?: string): Promise<void> {
    try {
      await this.enrolUserInternal(instance, userId, modifierId);
    } catch (err) {
      if (!isRoleContextConflictError(err)) throw err;
    }
  }

  /**
   * Rút ghi danh nội bộ không kiểm capability (kiểm capability là
   * việc của bề mặt gọi ở host).
   *
   * Flow: không có ghi danh → `{ withdrawn: false }`, không làm gì.
   * Có ghi danh → quyết định giữ/xoá theo dữ liệu liên quan (truy
   * vấn dữ liệu dùng chung): trong MỘT transaction, giữ thì chuyển
   * dòng sang WITHDRAWN, và phát cả `user_unenrolled` (mang cờ
   * `keptData`) lẫn `course_completion_reaggregation_requested` —
   * sự kiện tái tổng hợp hoàn thành phải nằm trong cùng transaction
   * này để việc gỡ ghi danh không bao giờ commit mà thiếu yêu cầu
   * tái tổng hợp (đường hook đồng bộ trước đây chạy sau commit và
   * nuốt lỗi: tiến trình chết giữa hai bước là mất tái tổng hợp
   * vĩnh viễn). Transaction commit xong: không giữ thì xoá cứng
   * dòng ghi danh; rồi gỡ đúng các dòng gán vai do chính instance
   * này cấp (component='enrol' + itemId=instance, theo phạm vi
   * Moodle) — gán của cùng role do instance khác cấp hoặc cấp tay
   * vẫn giữ nguyên, nên user còn ghi danh qua instance khác vẫn giữ
   * role. Việc tái tổng hợp không đọc gán vai nên thứ tự tiêu thụ
   * sự kiện so với việc gỡ gán không ảnh hưởng kết quả của nó.
   *
   * @param instance - enrol instance của ghi danh.
   * @param userId - người dùng bị rút ghi danh.
   * @param modifierId - người thao tác (truy vết trong payload sự kiện).
   * @returns `withdrawn: true` khi dòng ghi danh được giữ dạng WITHDRAWN.
   */
  async unenrolInternal(
    instance: EnrolInstanceRow,
    userId: string,
    modifierId?: string,
  ): Promise<{ withdrawn: boolean }> {
    const ue = await this.getUserEnrolment(instance.id, userId);
    if (!ue) return { withdrawn: false };
    const hasRelated = await hasRelatedCourseData(this.db, instance.courseId, userId);
    await this.db.transaction(async (tx) => {
      if (hasRelated) {
        await this.updateUserEnrolment(tx, ue.id, { status: ENROL_WITHDRAWN, modifierId });
      }
      await this.outbox.enqueue(tx, {
        aggregate: 'enrol', type: 'user_unenrolled',
        payload: { courseId: instance.courseId, userId, instanceId: instance.id, keptData: hasRelated, actorId: modifierId ?? null },
      });
      // Tái tổng hợp hoàn thành khoá cho người dùng này (tiêu chí
      // 'unenrol'): phát cùng transaction với user_unenrolled; phía
      // API tiêu thụ qua watermark seq riêng của CompletionModule,
      // KHÔNG qua bảng định tuyến relay của worker.
      await this.outbox.enqueue(tx, {
        aggregate: 'completion', type: COURSE_COMPLETION_REAGGREGATION_REQUESTED,
        payload: { courseId: instance.courseId, userId },
      });
    });
    if (!hasRelated) await this.db.delete(userEnrolments).where(eq(userEnrolments.id, ue.id));
    // Chỉ gỡ gán role mà instance ghi danh này đã cấp: gán của cùng
    // role do instance khác cấp hoặc cấp tay vẫn giữ nguyên, nên
    // user còn ghi danh qua instance khác vẫn giữ role. Các dòng cũ
    // không có component/itemId tính là cấp tay và cũng được để yên.
    if (instance.roleId) {
      const assignments = await this.roleAssignment.listAssignments({
        userId, contextId: await getCourseContextId(this.db, instance.courseId),
      });
      for (const a of assignments) {
        if (isInstanceAssignment(a, instance)) {
          await this.roleAssignment.unassignRole(a.id, modifierId, { allowEnrolManaged: true });
        }
      }
    }
    return { withdrawn: hasRelated };
  }

  /**
   * Người dùng hiện có đang là thành viên của cohort hay không —
   * nguồn sự thật hiện tại mà hai điểm vào vật chất hoá neo vào.
   *
   * @param cohortId - cohort cần kiểm.
   * @param userId - người dùng cần kiểm.
   */
  async isCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select().from(cohortMembers)
      .where(and(eq(cohortMembers.cohortId, cohortId), eq(cohortMembers.userId, userId)));
    return !!row;
  }

  /**
   * Các instance đồng bộ cohort đang trỏ tới một cohort.
   *
   * @param cohortId - cohort đích.
   */
  async listCohortInstances(cohortId: string): Promise<EnrolInstanceRow[]> {
    const rows = await this.db.select().from(enrol).where(eq(enrol.enrol, 'cohort'));
    return rows.filter((r) => r.customInt1 === cohortId);
  }

  /**
   * Vật chất hoá "thành viên mới vào cohort": ghi danh người dùng
   * vào mọi khoá học có instance cohort tương ứng đang bật.
   *
   * Guard trạng thái hiện tại: sự kiện có thể được phát lại MUỘN,
   * sau khi user đã rời cohort — không ghi danh cho người hiện
   * không còn trong cohort. Thành viên vi phạm chốt tách vai bị bỏ
   * qua riêng lẻ qua đường đồng bộ hàng loạt (xem
   * `enrolFromCohortSync`).
   *
   * @param payload - định danh cohort và người dùng của sự kiện thành viên.
   */
  async materializeCohortMemberAdded(payload: { cohortId: string; userId: string }): Promise<void> {
    if (!(await this.isCohortMember(payload.cohortId, payload.userId))) return;
    const instances = await this.listCohortInstances(payload.cohortId);
    for (const instance of instances) {
      if (instance.status !== 0) continue;
      await this.enrolFromCohortSync(instance, payload.userId);
    }
  }

  /**
   * Vật chất hoá "thành viên rời cohort": rút hoặc đình chỉ ghi
   * danh cohort tương ứng theo chế độ rời của từng instance.
   *
   * Guard trạng thái hiện tại: sự kiện rời phát lại muộn KHÔNG được
   * đình chỉ người đã vào lại cohort — nguồn sự thật là
   * `cohort_members` hiện tại, không phải thứ tự tới của sự kiện
   * (đường in-process và consumer outbox có thể đan nhau). Chế độ
   * 'unenrol' đi qua đường gỡ ghi danh lõi; chế độ đình chỉ ghi
   * trạng thái SUSPENDED với vết modifierId bị xoá về null (đình chỉ
   * do ĐỒNG BỘ HỆ THỐNG — job đối soát phân biệt được với đình chỉ
   * thủ công theo khoá, vốn mang vết của người thao tác) và phát
   * `user_enrolment_suspended` với lý do `cohort_removed`.
   *
   * @param payload - định danh cohort và người dùng của sự kiện thành viên.
   */
  async materializeCohortMemberRemoved(payload: { cohortId: string; userId: string }): Promise<void> {
    if (await this.isCohortMember(payload.cohortId, payload.userId)) return;
    const instances = await this.listCohortInstances(payload.cohortId);
    for (const instance of instances) {
      const ue = await this.getUserEnrolment(instance.id, payload.userId);
      if (!ue || ue.status === ENROL_WITHDRAWN) continue;
      if (instance.customText1 === 'unenrol') {
        await this.unenrolInternal(instance, payload.userId);
      } else {
        await this.updateUserEnrolment(this.db, ue.id, { status: ENROL_SUSPENDED, modifierId: null });
        await this.outbox.enqueueStandalone({
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { courseId: instance.courseId, userId: payload.userId, instanceId: instance.id, reason: 'cohort_removed' },
        });
      }
    }
  }
}
