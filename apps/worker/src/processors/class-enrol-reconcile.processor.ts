/**
 * Processor đối soát ghi danh cấp lớp (`class-enrol-reconcile`).
 *
 * Flow tổng thể: scheduler đăng ký job lặp vào queue →
 * {@link ClassEnrolReconcileProcessor.process} bọc ngữ cảnh platform
 * → quét danh sách lớp `active` → với từng lớp, hạ ngữ cảnh xuống
 * tenant của lớp, lên kế hoạch sửa từ hai phía (roster của backing
 * cohort ↔ `user_enrolments` vật chất hoá trên các instance cohort),
 * áp ngưỡng an toàn theo lớp rồi áp từng việc sửa (ghi danh / kích
 * hoạt lại / đình chỉ / rút ghi danh / cấp bổ sung vai) kèm sự kiện
 * outbox như đường API → kết quả lượt chạy ghi vào `task_log`.
 *
 * Bất biến sống còn: MỌI truy vấn của processor phải chạy trong một
 * ngữ cảnh tenant tường minh (platform cho lượt quét, tenant của lớp
 * cho phần việc của lớp). Ngoài ngữ cảnh, RLS fail-closed làm job đọc
 * 0 lớp mà vẫn báo thành công — hồi quy #292, có test riêng chạy bằng
 * role không BYPASSRLS (`test/class-enrol-reconcile-rls.spec.ts`).
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import {
  classes, cohortMembers, context, course, enrol, groupsMembers, outboxEvents,
  roleAssignments, userEnrolments,
} from '@lms/db-schema';
import { TaskLogService } from '../task-log.service';
import { tenantAls } from '../db/tenant-als';

type Database = NodePgDatabase<typeof relations>;

export interface ClassEnrolReconcileResult {
  checkedAt: string;
  classesChecked: number;
  enrolled: number;
  reactivated: number;
  suspended: number;
  withdrawn: number;
  rolesRestored: number;
  /** Lớp bị bỏ qua lượt này vì lệch vượt ngưỡng an toàn (chỉ báo cáo, không tự sửa hàng loạt). */
  skippedClassIds: string[];
}

/** Ngưỡng lệch bất thường của một lớp: phần việc cần sửa vượt tỉ lệ này của quy mô đối chiếu thì chỉ báo cáo (hồ sơ lớp học mục 4.2). */
export const RECONCILE_MAX_FIX_RATIO = 0.2;
/** Miễn ngưỡng tỉ lệ cho lớp nhỏ: tối thiểu ngần này việc sửa vẫn được áp dụng dù tỉ lệ cao (lớp mới tạo, roster ít). */
export const RECONCILE_MIN_FIX_ALLOWANCE = 5;

const ENROL_ACTIVE = 0;
const ENROL_SUSPENDED = 1;
const ENROL_WITHDRAWN = 2;
/** Truy vết nguồn của dòng gán vai do enrol instance cấp (khớp ENROL_ASSIGNMENT_COMPONENT phía API). */
const ENROL_ASSIGNMENT_COMPONENT = 'enrol';
const CONTEXT_LEVEL_COURSE = 50;

/** Một việc sửa đã lên kế hoạch cho một instance — tính trước toàn bộ để áp ngưỡng an toàn theo lớp trước khi ghi. */
interface PlannedFix {
  kind: 'enrol' | 'reactivate' | 'suspend' | 'withdraw' | 'role';
  instance: typeof enrol.$inferSelect;
  userId: string;
  ueId?: string;
}

/**
 * Đối soát ghi danh cấp lớp (issue #184, CLASS-0 — vá bền vững #2 của hồ
 * sơ lớp học): nguồn sự thật là `cohort_members` của backing cohort;
 * ghi danh cấp khoá trên các instance cohort của lớp là bản vật chất
 * hoá. Job quét mọi lớp `active`, so hai phía và sửa theo hướng nguồn
 * sự thật: thiếu → ghi danh (kèm gán vai theo instance + group "cả
 * lớp" + sự kiện outbox như đường API), thừa → áp chế độ rời lớp của
 * instance (`suspend` mặc định / `unenrol` → withdrawn + gỡ vai do
 * instance cấp), ghi danh ACTIVE thiếu gán vai của instance → cấp bổ
 * sung (lấp đúng lỗ hổng gán vai nằm ngoài transaction ở enrolUserInternal).
 *
 * LUẬT CỨNG — tôn trọng đình chỉ thủ công theo khoá (ca "miễn môn"):
 * một UE đang SUSPENDED mang `modifier_id` của một NGƯỜI (vết do
 * `EnrolService.setSuspended` ghi) là quyết định thủ công của giáo
 * viên tại khoá đó — job KHÔNG bao giờ tự kích hoạt lại. Chỉ UE bị
 * đình chỉ bởi đồng bộ hệ thống (modifier_id = null, vết do đường
 * cohort-removed ghi) mới được kích hoạt lại khi user quay về roster.
 *
 * Chống sửa sai diện rộng: kế hoạch sửa của một lớp vượt quá
 * RECONCILE_MAX_FIX_RATIO của quy mô đối chiếu (và quá
 * RECONCILE_MIN_FIX_ALLOWANCE việc) thì lớp đó bị bỏ qua lượt này và
 * ghi vào kết quả để người vận hành kiểm tra — nguồn sự thật bị thao
 * tác lỗi không được phép kéo theo sửa hàng loạt. Job idempotent:
 * chạy lại trên trạng thái đã khớp là không sửa gì.
 */
@Processor('class-enrol-reconcile')
export class ClassEnrolReconcileProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly taskLog: TaskLogService) { super(); }

  /**
   * Xử lý một job đối soát. Worker không có request HTTP nên processor
   * phải TỰ bọc ngữ cảnh tenant (TENANT-1, #196) — lượt quét danh sách
   * lớp chạy dưới ngữ cảnh platform tường minh, đúng chuẩn mọi
   * processor quét xuyên tenant khác (guardian-digest,
   * notification-retention...).
   *
   * @remarks
   * Bọc ngữ cảnh là điều kiện SỐNG CÒN của job này (hồi quy #292):
   * ngoài ngữ cảnh, `TenantAwarePool` gắn `app.tenant_id = ''` +
   * `app.platform = 'off'`, RLS fail-closed trên bảng `classes` làm
   * lượt quét đọc **0 lớp** — job vẫn kết thúc "thành công" với
   * `classesChecked = 0` và lệch ghi danh không bao giờ được sửa.
   * Phần xử lý từng lớp được hạ xuống ngữ cảnh của chính tenant lớp
   * đó trong {@link sweep}.
   *
   * @param _job - Job BullMQ của queue `class-enrol-reconcile` (không
   *   mang payload nghiệp vụ; lịch lặp do scheduler đăng ký).
   * @returns Kết quả lượt đối soát (số lớp đã kiểm, số việc sửa theo
   *   loại, danh sách lớp bị bỏ qua vì vượt ngưỡng an toàn).
   */
  async process(_job: Job): Promise<ClassEnrolReconcileResult> {
    void _job;
    // Ngữ cảnh platform cho lượt quét xuyên tenant — thiếu lớp bọc này
    // là toàn bộ job mù dữ liệu vì RLS (xem @remarks ở trên).
    return tenantAls.run({ platform: true }, () => this.processInContext());
  }

  /** Thân xử lý của một lượt đối soát, chạy trong ngữ cảnh platform do {@link process} bọc. */
  private async processInContext(): Promise<ClassEnrolReconcileResult> {
    return this.taskLog.run('class-enrol-reconcile', () => this.sweep(), (r) =>
      `classes ${r.classesChecked}, enrolled ${r.enrolled}, reactivated ${r.reactivated}, suspended ${r.suspended}, withdrawn ${r.withdrawn}, roles ${r.rolesRestored}, skipped ${r.skippedClassIds.length}`);
  }

  /**
   * Một lượt quét đối soát toàn hệ.
   *
   * Flow: (1) đọc danh sách lớp `active` — bước này chạy trong ngữ
   * cảnh platform do {@link process} bọc nên thấy mọi tenant; (2) với
   * TỪNG lớp, hạ ngữ cảnh xuống đúng tenant của lớp đó rồi mới lên kế
   * hoạch + áp sửa — mọi truy vấn/ghi của một lớp (cohort_members,
   * course, enrol, user_enrolments, role_assignments, groups_members,
   * outbox_events...) đều nằm trong ngữ cảnh của lớp, để RLS tự giới
   * hạn đúng phạm vi tenant và các dòng ghi mang đúng tenant, theo
   * đúng mẫu quét-theo-từng-tenant của guardian-digest.
   *
   * @returns Kết quả tổng hợp của lượt quét.
   */
  private async sweep(): Promise<ClassEnrolReconcileResult> {
    const now = new Date();
    const result: ClassEnrolReconcileResult = {
      checkedAt: now.toISOString(),
      classesChecked: 0, enrolled: 0, reactivated: 0, suspended: 0, withdrawn: 0,
      rolesRestored: 0, skippedClassIds: [],
    };
    const activeClasses = await this.db.select().from(classes).where(eq(classes.status, 'active'));
    for (const clazz of activeClasses) {
      result.classesChecked += 1;
      // Xử lý một lớp trong ngữ cảnh tenant của CHÍNH lớp đó: đọc hai
      // phía (roster ↔ vật chất hoá) và mọi đường ghi trong
      // planForClass/applyFix đều chạy dưới ngữ cảnh này — không để
      // sót đường nào chạy ngoài ngữ cảnh (RLS sẽ lặng lẽ cho 0 dòng
      // ở các bảng có tenant_id, hoặc ghi lệch phạm vi tenant).
      await tenantAls.run({ tenantId: clazz.tenantId }, async () => {
        const fixes = await this.planForClass(clazz);
        if (fixes === null) return;
        const scale = fixes.scale;
        if (fixes.planned.length > Math.max(RECONCILE_MIN_FIX_ALLOWANCE, Math.floor(scale * RECONCILE_MAX_FIX_RATIO))) {
          result.skippedClassIds.push(clazz.id);
          return;
        }
        for (const fix of fixes.planned) {
          await this.applyFix(fix, now);
          if (fix.kind === 'enrol') result.enrolled += 1;
          else if (fix.kind === 'reactivate') result.reactivated += 1;
          else if (fix.kind === 'suspend') result.suspended += 1;
          else if (fix.kind === 'withdraw') result.withdrawn += 1;
          else if (fix.kind === 'role') result.rolesRestored += 1;
        }
      });
    }
    return result;
  }

  /** Lên kế hoạch sửa cho một lớp: đọc toàn bộ hai phía (roster ↔ UE trên các instance cohort của lớp) và suy ra việc cần làm. */
  private async planForClass(clazz: typeof classes.$inferSelect): Promise<{ planned: PlannedFix[]; scale: number } | null> {
    const members = await this.db.select().from(cohortMembers).where(eq(cohortMembers.cohortId, clazz.cohortId));
    const memberIds = new Set(members.map((m) => m.userId));
    const classCourses = await this.db.select().from(course).where(eq(course.classId, clazz.id));
    if (classCourses.length === 0) return { planned: [], scale: memberIds.size };
    const instances = await this.db.select().from(enrol).where(and(
      inArray(enrol.courseId, classCourses.map((c) => c.id)),
      eq(enrol.enrol, 'cohort'),
      eq(enrol.customInt1, clazz.cohortId),
      eq(enrol.status, 0),
    ));
    const planned: PlannedFix[] = [];
    let scale = memberIds.size;
    for (const instance of instances) {
      const ues = await this.db.select().from(userEnrolments).where(eq(userEnrolments.enrolId, instance.id));
      scale += ues.length;
      const ueByUser = new Map(ues.map((ue) => [ue.userId, ue]));
      const courseCtx = await this.courseContextId(instance.courseId);
      // Gán vai của instance nạp MỘT lần cho cả instance (một truy
      // vấn inArray trên tập thành viên) rồi đối chiếu trong bộ nhớ —
      // thay cho truy vấn theo từng cặp (instance × thành viên) trước
      // đây. Điều kiện lọc giữ nguyên: đúng context của khoá, đúng
      // vai của instance, đúng component và itemId của instance.
      const assignedUserIds = new Set<string>();
      if (instance.roleId && courseCtx && memberIds.size > 0) {
        const assignments = await this.db.select({ userId: roleAssignments.userId }).from(roleAssignments).where(and(
          inArray(roleAssignments.userId, [...memberIds]),
          eq(roleAssignments.contextId, courseCtx),
          eq(roleAssignments.roleId, instance.roleId),
          eq(roleAssignments.component, ENROL_ASSIGNMENT_COMPONENT),
          eq(roleAssignments.itemId, instance.id),
        ));
        for (const assignment of assignments) assignedUserIds.add(assignment.userId);
      }
      for (const userId of memberIds) {
        const ue = ueByUser.get(userId);
        if (!ue) {
          planned.push({ kind: 'enrol', instance, userId });
          continue;
        }
        if (ue.status === ENROL_WITHDRAWN) {
          planned.push({ kind: 'reactivate', instance, userId, ueId: ue.id });
          continue;
        }
        if (ue.status === ENROL_SUSPENDED) {
          // Đình chỉ thủ công theo khoá (modifierId là một người) = quyết
          // định "miễn môn" của giáo viên — đối soát KHÔNG đụng vào.
          if (ue.modifierId !== null) continue;
          planned.push({ kind: 'reactivate', instance, userId, ueId: ue.id });
          continue;
        }
        // ACTIVE: chỉ còn kiểm tra gán vai của instance có còn đủ
        // không — đối chiếu với tập đã nạp theo instance ở trên.
        if (instance.roleId && courseCtx) {
          if (!assignedUserIds.has(userId)) planned.push({ kind: 'role', instance, userId, ueId: ue.id });
        }
      }
      for (const ue of ues) {
        if (memberIds.has(ue.userId)) continue;
        if (ue.status === ENROL_ACTIVE) {
          planned.push({ kind: instance.customText1 === 'unenrol' ? 'withdraw' : 'suspend', instance, userId: ue.userId, ueId: ue.id });
        } else if (ue.status === ENROL_SUSPENDED && ue.modifierId === null && instance.customText1 === 'unenrol') {
          // Đã rời roster + chế độ unenrol mà mới ở trạng thái đình chỉ
          // của đồng bộ: hội tụ về withdrawn như đường API áp.
          planned.push({ kind: 'withdraw', instance, userId: ue.userId, ueId: ue.id });
        }
      }
    }
    return { planned, scale };
  }

  private async courseContextId(courseId: string): Promise<string | undefined> {
    const [row] = await this.db.select().from(context)
      .where(and(eq(context.contextLevel, CONTEXT_LEVEL_COURSE), eq(context.instanceId, courseId)));
    return row?.id;
  }

  /** Áp một việc sửa; ghi danh mới đi kèm gán vai + group + sự kiện outbox trong cùng transaction như đường API. */
  private async applyFix(fix: PlannedFix, now: Date): Promise<void> {
    const { instance, userId } = fix;
    if (fix.kind === 'enrol') {
      const courseCtx = await this.courseContextId(instance.courseId);
      await this.db.transaction(async (tx) => {
        await tx.insert(userEnrolments).values({
          enrolId: instance.id, userId, status: ENROL_ACTIVE, timeStart: now, timeEnd: null, modifierId: null,
        });
        await tx.insert(outboxEvents).values({
          aggregate: 'enrol', type: 'user_enrolled',
          payload: { courseId: instance.courseId, userId, instanceId: instance.id, method: 'cohort', actorId: null, reconciled: true },
        });
        if (instance.roleId && courseCtx) {
          await tx.insert(roleAssignments).values({
            roleId: instance.roleId, userId, contextId: courseCtx,
            component: ENROL_ASSIGNMENT_COMPONENT, itemId: instance.id,
          }).onConflictDoNothing();
        }
        if (instance.customInt2) {
          await tx.insert(groupsMembers).values({
            groupId: instance.customInt2, userId, component: 'enrol_cohort', itemId: instance.id,
          }).onConflictDoNothing();
        }
      });
      return;
    }
    if (fix.kind === 'reactivate' && fix.ueId) {
      await this.db.update(userEnrolments)
        .set({ status: ENROL_ACTIVE, modifierId: null, updatedAt: now })
        .where(eq(userEnrolments.id, fix.ueId));
      return;
    }
    if (fix.kind === 'suspend' && fix.ueId) {
      await this.db.transaction(async (tx) => {
        await tx.update(userEnrolments)
          .set({ status: ENROL_SUSPENDED, modifierId: null, updatedAt: now })
          .where(eq(userEnrolments.id, fix.ueId!));
        await tx.insert(outboxEvents).values({
          aggregate: 'enrol', type: 'user_enrolment_suspended',
          payload: { courseId: instance.courseId, userId, instanceId: instance.id, reason: 'reconciled_cohort_removed' },
        });
      });
      return;
    }
    if (fix.kind === 'withdraw' && fix.ueId) {
      const courseCtx = await this.courseContextId(instance.courseId);
      await this.db.transaction(async (tx) => {
        await tx.update(userEnrolments)
          .set({ status: ENROL_WITHDRAWN, modifierId: null, updatedAt: now })
          .where(eq(userEnrolments.id, fix.ueId!));
        if (instance.roleId && courseCtx) {
          await tx.delete(roleAssignments).where(and(
            eq(roleAssignments.userId, userId),
            eq(roleAssignments.contextId, courseCtx),
            eq(roleAssignments.roleId, instance.roleId),
            eq(roleAssignments.component, ENROL_ASSIGNMENT_COMPONENT),
            eq(roleAssignments.itemId, instance.id),
          ));
        }
        await tx.insert(outboxEvents).values({
          aggregate: 'enrol', type: 'user_unenrolled',
          payload: { courseId: instance.courseId, userId, instanceId: instance.id, reason: 'reconciled_cohort_removed' },
        });
      });
      return;
    }
    if (fix.kind === 'role') {
      const courseCtx = await this.courseContextId(instance.courseId);
      if (instance.roleId && courseCtx) {
        await this.db.insert(roleAssignments).values({
          roleId: instance.roleId, userId, contextId: courseCtx,
          component: ENROL_ASSIGNMENT_COMPONENT, itemId: instance.id,
        }).onConflictDoNothing();
      }
    }
  }
}
