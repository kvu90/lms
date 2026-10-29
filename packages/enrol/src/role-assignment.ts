import { and, eq, isNull } from 'drizzle-orm';
import { role, roleAssignments } from '@lms/db';
import { getContextOrThrow, markContextDirty } from './contexts';
import { SharedDomainError } from './errors';
import { TEACHING_ROLE_ARCHETYPES, type PlanLimitsCore } from './plan-limits';
import type { RoleSeparationCore } from './role-separation';
import type { EnrolDatabase, RoleAssignmentRow, RoleRow, SharedOutboxPort } from './types';

/**
 * Truy vết nguồn của một dòng gán vai (Moodle: cột `component`/`itemid`
 * của `role_assignments` — enrol plugin ghi component là tên plugin và
 * itemid là id của enrol instance). Gán tay qua API quản trị và các gán
 * hệ thống khác để component rỗng + itemId null.
 */
export interface AssignmentSource {
  component: string;
  itemId?: string | null;
}

/** Component đánh dấu dòng gán vai do một ghi danh (enrol instance) cấp. */
export const ENROL_ASSIGNMENT_COMPONENT = 'enrol';

/** Dòng gán vai này có do ghi danh cấp hay không (quyết định chốt gỡ ở `unassignRole`). */
export function isEnrolManagedAssignment(assignment: { component?: string | null }): boolean {
  return assignment.component === ENROL_ASSIGNMENT_COMPONENT;
}

/**
 * Lõi gán/gỡ vai dùng chung (trích từ tầng Access của API): gán một
 * vai cho một người dùng tại một context, với đủ hai điểm chặn vốn
 * gác đường gán — điểm chặn SLOT gói trung tâm (gán vai giảng dạy
 * làm tăng slot của tenant thì chặn khi đã chạm hạn mức) và chốt
 * TÁCH VAI chiều ngược (gán vai giảng dạy không do ghi danh cấp cho
 * người đang là học viên đang hoạt động trong khoá bị context bao
 * phủ thì chặn) — cùng nguyên tắc vô hiệu hoá cache quyền: MỌI thay
 * đổi về gán vai đều bump dấu version của context liên quan qua
 * {@link markContextDirty}, vì phép đánh giá quyền của host cache
 * kết quả theo khoá nhúng dấu version của path; thiếu lần bump này,
 * quyền vừa gán/vừa gỡ vẫn qua cổng từ cache cho tới khi mục cache
 * hết hạn.
 *
 * Sự kiện `role_assigned`/`role_unassigned` cho logstore được phát
 * qua cổng outbox của host, trong transaction ngắn riêng như bề mặt
 * API hiện hành.
 */
export class RoleAssignmentCore {
  /**
   * @param db - tay cầm Drizzle của host.
   * @param outbox - cổng ghi outbox của host.
   * @param planLimits - lõi giới hạn slot dùng chung.
   * @param roleSeparation - lõi tách vai dùng chung.
   */
  constructor(
    private readonly db: EnrolDatabase,
    private readonly outbox: SharedOutboxPort,
    private readonly planLimits: PlanLimitsCore,
    private readonly roleSeparation: RoleSeparationCore,
  ) {}

  /**
   * Lấy role theo id; ném lỗi `access.role_not_found` khi vắng.
   *
   * @param roleId - id của role.
   * @throws SharedDomainError mã `access.role_not_found`.
   */
  async getRoleOrThrow(roleId: string): Promise<RoleRow> {
    const [row] = await this.db.select().from(role).where(eq(role.id, roleId));
    if (!row) throw new SharedDomainError('access.role_not_found', `Role ${roleId} not found`);
    return row;
  }

  /**
   * Gán role cho user tại context; trùng gán hiện hữu (cùng role +
   * cùng NGUỒN) thì bỏ qua. `source` khai truy vết nguồn của dòng
   * gán: ghi danh truyền `{ component: 'enrol', itemId: <enrol
   * instance id> }`; không truyền = gán tay/hệ thống (component
   * rỗng, itemId null). Cùng một role/user/context có thể có nhiều
   * dòng gán khác nguồn (vd vừa được enrol cấp vừa được quản trị
   * gán tay) — mỗi nguồn một dòng riêng, gỡ nguồn nào chỉ mất dòng
   * của nguồn đó.
   *
   * Flow: đọc role và context (không thấy thì lỗi tương ứng) → nếu
   * role là vai giảng dạy: điểm chặn slot gói trung tâm (tenant của
   * context + dữ kiện đếm slot của user), rồi chốt tách vai chiều
   * ngược khi gán không do ghi danh cấp → kiểm dòng gán cùng nguồn
   * đã có chưa → chèn dòng gán (trùng khoá duy nhất theo nguồn thì
   * lấy lại dòng hiện hữu của ĐÚNG nguồn đó) → đánh dấu dirty
   * context → phát `role_assigned` chỉ khi gán thật sự mới (gán
   * trùng là no-op, không phát sự kiện).
   *
   * @param userId - người dùng nhận gán vai.
   * @param roleId - vai được gán.
   * @param contextId - context đích của gán vai.
   * @param modifierId - người thực hiện gán (để truy vết và làm actor của sự kiện).
   * @param source - truy vết nguồn của dòng gán.
   * @returns dòng gán vai (mới chèn hoặc dòng hiện hữu cùng nguồn).
   * @throws SharedDomainError mã `access.role_not_found` / `access.context_not_found`,
   * hoặc lỗi của hai điểm chặn (mã `plan.tenant_slot_limit_reached` /
   * `access.role_context_conflict`).
   */
  async assignRole(
    userId: string,
    roleId: string,
    contextId: string,
    modifierId?: string,
    source?: AssignmentSource,
  ): Promise<RoleAssignmentRow> {
    const roleRow = await this.getRoleOrThrow(roleId);
    await getContextOrThrow(this.db, contextId);
    // Điểm chặn SLOT GÓI TRUNG TÂM (đặc tả slot đã duyệt): gán một
    // vai trò GIẢNG DẠY tại bất kỳ context nào trong cây của một
    // tenant khách hàng cho một thành viên đang hoạt động mà tài
    // khoản đang hoạt động và CHƯA được đếm là hành động làm tăng số
    // slot của tenant đó — mọi nguồn gán đều qua điểm này (gán tay
    // qua API quản trị, ghi danh cấp vai trò giảng dạy, gán chủ
    // lớp/chủ khoá của các module nghiệp vụ). Đã chạm hạn mức hiệu
    // lực thì chặn TRƯỚC khi chèn dòng gán, không dòng gán nào được
    // tạo. Người đã được đếm, vai trò không phải giảng dạy, và
    // context ngoài cây tenant khách hàng (tenant platform, context
    // hệ thống) đều không bị chặn.
    if ((TEACHING_ROLE_ARCHETYPES as readonly string[]).includes(roleRow.archetype ?? '')) {
      const tenantId = await this.planLimits.tenantIdForContext(contextId);
      if (tenantId) {
        const facts = await this.planLimits.describeUserInTenant(tenantId, userId);
        if (facts.membershipActive && facts.accountActive && !facts.counted) {
          await this.planLimits.assertTenantSlotForNewTeacher(tenantId, userId);
        }
      }
    }
    const component = source?.component ?? '';
    const itemId = source?.itemId ?? null;
    // Chốt TÁCH VAI chiều ngược (RoleSeparationCore giữ định nghĩa
    // dùng chung): gán một vai GIẢNG DẠY không do ghi danh cấp tại
    // context khoá/lớp cho người đang là HỌC VIÊN ĐANG HOẠT ĐỘNG
    // trong khoá bị context đó bao phủ sẽ tạo lẫn vai cùng khoá —
    // từ chối TRƯỚC khi chèn dòng gán, cùng mã lỗi với các chốt ở ba
    // funnel ghi danh. Gán do ghi danh cấp (component = 'enrol')
    // không qua chốt này: đó là hệ quả máy móc của một ghi danh đã
    // được chốt ở funnel ghi danh, và instance cấp vai giảng dạy là
    // đường cấp vai của quản trị nằm ngoài quyết định tách vai.
    if (
      (TEACHING_ROLE_ARCHETYPES as readonly string[]).includes(roleRow.archetype ?? '')
      && !isEnrolManagedAssignment({ component })
    ) {
      await this.roleSeparation.assertTeachingAssignmentAllowed(userId, contextId);
    }
    const existing = await this.listAssignments({ userId, contextId });
    const alreadyAssigned = existing.some((a) => a.roleId === roleId && a.component === component && (a.itemId ?? null) === itemId);
    const row = await this.insertAssignment({ roleId, userId, contextId, modifierId, component, itemId });
    await markContextDirty(this.db, contextId);
    if (!alreadyAssigned) {
      // Sự kiện role_assigned (Moodle \core\event\role_assigned) cho
      // logstore — chỉ phát khi gán thật sự mới (gán trùng là no-op).
      await this.outbox.enqueueStandalone({
        aggregate: 'access', type: 'role_assigned',
        payload: { assignmentId: row.id, userId, roleId, contextId, actorId: modifierId ?? null, component, itemId },
      });
    }
    return row;
  }

  /**
   * Gỡ gán role của user tại context.
   *
   * Chốt toàn vẹn ghi danh: dòng gán do GHI DANH cấp
   * (component='enrol') thuộc quyền quản lý của enrol — đường gỡ mặc
   * định (API quản trị gỡ gán) KHÔNG được xoá, vì xoá sẽ để lại một
   * ghi danh còn hiệu lực mà không còn vai ở khoá. Chỉ đường nội bộ
   * của chính enrol (unenrol/đổi vai instance) mới gỡ được, qua cờ
   * tường minh `allowEnrolManaged`.
   *
   * Sau khi xoá dòng gán phải bump version của context của dòng gán
   * (nguyên tắc vô hiệu hoá cache quyền — xem lời dẫn của class):
   * mọi đường gỡ gán trong sản phẩm đều chảy qua hàm này (API quản
   * trị, rút ghi danh, đồng bộ danh sách lớp, thu hồi chia sẻ ngân
   * hàng câu hỏi), nên bump tại đây thì thao tác thu hồi quyền có
   * hiệu lực tức thì ở mọi đường, thay vì chờ kết quả đã cache hết
   * hạn.
   *
   * @param assignmentId - id của dòng gán cần gỡ.
   * @param modifierId - người thực hiện gỡ (làm actor của sự kiện).
   * @param opts - `allowEnrolManaged`: cho phép gỡ dòng do ghi danh cấp (chỉ đường nội bộ của enrol).
   * @throws SharedDomainError mã `access.assignment_enrol_managed` khi gỡ dòng do
   * ghi danh cấp mà không có cờ cho phép.
   */
  async unassignRole(assignmentId: string, modifierId?: string, opts?: { allowEnrolManaged?: boolean }): Promise<void> {
    const existing = await this.getAssignment(assignmentId);
    if (existing && isEnrolManagedAssignment(existing) && !opts?.allowEnrolManaged) {
      throw new SharedDomainError(
        'access.assignment_enrol_managed',
        'This role assignment is managed by an enrolment and cannot be removed directly; unenrol the user from the enrolment instance instead',
      );
    }
    await this.db.delete(roleAssignments).where(eq(roleAssignments.id, assignmentId));
    if (existing) {
      await markContextDirty(this.db, existing.contextId);
      // Sự kiện role_unassigned (Moodle \core\event\role_unassigned) cho logstore.
      await this.outbox.enqueueStandalone({
        aggregate: 'access', type: 'role_unassigned',
        payload: { assignmentId, userId: existing.userId, roleId: existing.roleId, contextId: existing.contextId, actorId: modifierId ?? null },
      });
    }
  }

  /**
   * Chèn một dòng gán vai; trùng khoá duy nhất (role, user, context,
   * component, itemId) thì trả lại dòng hiện hữu của ĐÚNG nguồn đó —
   * nếu không, gán của enrol có thể trả về nhầm dòng gán tay (hoặc
   * ngược lại) cùng role/user/context.
   *
   * @param values - dữ kiện chèn của dòng gán.
   */
  private async insertAssignment(values: typeof roleAssignments.$inferInsert): Promise<RoleAssignmentRow> {
    const [row] = await this.db.insert(roleAssignments).values(values)
      .onConflictDoNothing().returning();
    if (row) return row;
    const [existing] = await this.db.select().from(roleAssignments).where(and(
      eq(roleAssignments.roleId, values.roleId!), eq(roleAssignments.userId, values.userId!),
      eq(roleAssignments.contextId, values.contextId!),
      eq(roleAssignments.component, values.component ?? ''),
      values.itemId != null ? eq(roleAssignments.itemId, values.itemId) : isNull(roleAssignments.itemId)));
    return existing!;
  }

  /**
   * Lấy một gán role theo id (phục vụ gỡ gán cần biết user/role/context
   * của dòng sắp xoá); undefined khi không tồn tại.
   *
   * @param id - id của dòng gán.
   */
  async getAssignment(id: string): Promise<RoleAssignmentRow | undefined> {
    const [row] = await this.db.select().from(roleAssignments).where(eq(roleAssignments.id, id));
    return row;
  }

  /**
   * Liệt kê gán role, lọc tuỳ chọn theo user và/hoặc context.
   *
   * @param filter - tiêu chí lọc tuỳ chọn.
   */
  async listAssignments(filter: { userId?: string; contextId?: string }): Promise<RoleAssignmentRow[]> {
    const conds = [];
    if (filter.userId !== undefined) conds.push(eq(roleAssignments.userId, filter.userId));
    if (filter.contextId !== undefined) conds.push(eq(roleAssignments.contextId, filter.contextId));
    return this.db.select().from(roleAssignments).where(conds.length ? and(...conds) : undefined);
  }
}
