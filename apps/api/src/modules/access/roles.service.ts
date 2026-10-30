import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { UserListStatus, UserWithAssignmentsListResponse } from '@lms/contracts';
import { OutboxService } from '../../infra/events/outbox.service';
import { AccessRepository, type AssignmentListRow, type RoleRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAPABILITY_DEFINITIONS, DEFAULT_ROLES } from './domain/capabilities';
import { CAP_ALLOW, CAP_INHERIT, CAP_PREVENT, CAP_PROHIBIT } from './domain/permission';
import { PlanLimitsService, TEACHING_ROLE_ARCHETYPES } from './plan-limits.service';
import { RoleSeparationService } from './role-separation.service';
import type { DbTx } from '../../db/database';

const VALID_PERMISSIONS = [CAP_PROHIBIT, CAP_PREVENT, CAP_INHERIT, CAP_ALLOW];

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

/**
 * Một dòng của danh sách role kèm dữ kiện tổng hợp phía server: số
 * người dùng phân biệt đang giữ role và tổng hợp năng lực tính từ tập
 * ghi đè đã lưu của role (tổng số ghi đè, số ghi đè theo capType
 * read/write, số resource phân biệt các ghi đè chạm tới). Đây là hình
 * dạng trả về của `GET /access/roles` — giao diện thẻ role đọc thẳng
 * các trường tổng hợp này, không gọi thêm theo từng role.
 */
export interface RoleListItem extends RoleRow {
  userCount: number;
  overrideCount: number;
  readOverrideCount: number;
  writeOverrideCount: number;
  resourceCount: number;
}

/**
 * Một dòng vai trong ma trận quyền tại đúng một context: định danh
 * và tên vai, số người dùng phân biệt đang giữ vai (cùng phép đếm
 * với danh sách vai) và tập ghi đè ĐÃ LƯU của vai tại context đó —
 * mỗi phần tử chỉ gồm tên năng lực và giá trị quyền, sắp theo tên
 * năng lực. Vai không có ghi đè nào tại context mang `overrides`
 * rỗng. Đây là hình dạng một phần tử của đáp ứng
 * `GET /access/capability-matrix`.
 */
export interface RoleCapabilityMatrixItem {
  id: string;
  name: string;
  userCount: number;
  overrides: { capability: string; permission: number }[];
}

/** Dòng gán vai này có do ghi danh cấp hay không (quyết định chốt gỡ ở unassignRole). */
export function isEnrolManagedAssignment(assignment: { component?: string | null }): boolean {
  return assignment.component === ENROL_ASSIGNMENT_COMPONENT;
}

@Injectable()
/**
 * Quản trị role và gán role: role là tập override capability tại các context.
 * Đối chiếu Moodle: lib/accesslib.php (create_role, assign_capability, role_assign).
 */
export class RolesService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly contexts: ContextsService,
    private readonly outbox: OutboxService,
    private readonly planLimits: PlanLimitsService,
    private readonly roleSeparation: RoleSeparationService,
  ) {}

  /** Seed có tính idempotent: đồng bộ các định nghĩa capability từ code (định nghĩa không còn trong registry sẽ bị cắt bỏ, cùng với các override role của chúng), tạo các role core chuẩn của Moodle và giá trị mặc định theo archetype của chúng tại context hệ thống. */
  /**
   * Gieo các role archetype chuẩn của Moodle (manager, coursecreator, editingteacher, teacher, student, guest, user) cùng ma trận quyền mặc định tại context hệ thống; idempotent.
   * Đồng bộ hai chiều: định nghĩa capability không còn trong sổ đăng ký ở code (vd tên cũ còn tiền tố, đã bỏ từ issue #35) bị xoá khỏi DB cùng mọi override trỏ tới chúng, để hai hệ tên không cùng tồn tại sau seed.
   */
  async seedDefaults(): Promise<void> {
    const system = await this.contexts.ensureSystemContext();
    for (const def of CAPABILITY_DEFINITIONS) await this.repo.upsertCapability(def);
    const registryNames = CAPABILITY_DEFINITIONS.map((c) => c.name);
    await this.repo.deleteRoleCapabilitiesNotIn(registryNames);
    await this.repo.deleteCapabilitiesNotIn(registryNames);
    for (const def of DEFAULT_ROLES) {
      let roleRow = await this.repo.getRoleByShortname(def.shortName);
      if (!roleRow) roleRow = await this.repo.insertRole({ ...def, description: '' });
      await this.repo.deleteRoleCapabilitiesAtContext(roleRow.id, system.id, CAPABILITY_DEFINITIONS.map((c) => c.name));
      for (const capDef of CAPABILITY_DEFINITIONS) {
        const perm = capDef.archetypes[def.archetype];
        if (perm !== undefined) {
          await this.repo.upsertRoleCapability({ contextId: system.id, roleId: roleRow.id, capability: capDef.name, permission: perm });
        }
      }
    }
  }

  /**
   * Tạo role mới (shortName duy nhất).
   */
  async createRole(input: { name: string; shortName: string; description?: string; archetype?: string }): Promise<RoleRow> {
    const shortName = input.shortName.trim().toLowerCase();
    if (await this.repo.getRoleByShortname(shortName)) {
      throw new BadRequestException({ message: `Role shortName ${shortName} already exists`, code: 'access.role_shortname_taken' });
    }
    const roles = await this.repo.listRoles();
    return this.repo.insertRole({ name: input.name, shortName, description: input.description ?? '', archetype: input.archetype, sortOrder: roles.length + 1 });
  }
  /**
   * Liệt kê mọi role kèm dữ kiện tổng hợp cho thẻ role.
   *
   * Flow: đọc danh sách role → đọc hai tập tổng hợp phía server (số
   * người dùng phân biệt theo role từ bảng gán; tổng hợp ghi đè theo
   * role từ bảng ghi đè) → ghép theo id role. Role vắng mặt trong một
   * tập tổng hợp nghĩa là chưa có dòng gán/ghi đè nào — các số tương
   * ứng là 0. Mọi tổng hợp tính ở server trong đúng lượt gọi này để
   * giao diện không phải tải toàn bộ bảng gán về đếm, cũng không phải
   * gọi ma trận riêng cho từng role.
   */
  async listRoles(): Promise<RoleListItem[]> {
    const [roles, userCounts, aggregates] = await Promise.all([
      this.repo.listRoles(),
      this.repo.countDistinctUsersByRole(),
      this.repo.getRoleOverrideAggregates(),
    ]);
    const userCountByRole = new Map(userCounts.map((row) => [row.roleId, row.userCount]));
    const aggregateByRole = new Map(aggregates.map((row) => [row.roleId, row]));
    return roles.map((roleRow) => {
      const aggregate = aggregateByRole.get(roleRow.id);
      return {
        ...roleRow,
        userCount: userCountByRole.get(roleRow.id) ?? 0,
        overrideCount: aggregate?.overrideCount ?? 0,
        readOverrideCount: aggregate?.readOverrideCount ?? 0,
        writeOverrideCount: aggregate?.writeOverrideCount ?? 0,
        resourceCount: aggregate?.resourceCount ?? 0,
      };
    });
  }
  /**
   * Lấy role theo id; ném NotFound khi vắng.
   */
  async getRole(id: string): Promise<RoleRow> {
    const row = await this.repo.getRoleById(id);
    if (!row) throw new NotFoundException({ message: `Role ${id} not found`, code: 'access.role_not_found' });
    return row;
  }
  /**
   * Lấy role theo shortName; undefined nếu không có.
   */
  async getRoleByShortname(shortName: string): Promise<RoleRow | undefined> { return this.repo.getRoleByShortname(shortName); }
  /**
   * Cập nhật tên/mô tả/archetype của role.
   */
  async updateRole(id: string, input: { name?: string; description?: string }): Promise<RoleRow> {
    await this.getRole(id);
    await this.repo.updateRole(id, input);
    return this.getRole(id);
  }
  /**
   * Xoá role (kèm gán và override của nó) — có hai chốt chặn.
   *
   * Flow: đọc role → CHỐT 1: role dựng sẵn (có `archetype`) bị từ chối
   * bằng `access.role_archetype_delete_forbidden`, vì cơ chế
   * `seedDefaults` sẽ tạo lại role dựng sẵn kèm ma trận mặc định ở lần
   * chạy seed kế tiếp: xoá rồi mọc lại vừa làm mất dữ kiện gán hiện
   * hành vừa tạo hành vi khó đoán → đọc các dòng gán của role → CHỐT 2:
   * role đang còn ít nhất một dòng gán (còn người giữ ở bất kỳ context
   * nào) bị từ chối bằng `access.role_has_assignments`, vì xoá hiện
   * hành cascade làm người giữ mất role ngay. Hai lỗi tách mã riêng để
   * giao diện phân biệt được trường hợp → thu thập các context phân
   * biệt từng có gán vai hoặc override của role (phải đọc TRƯỚC khi
   * xoá, vì xoá xong không còn dữ kiện để biết cache của context nào
   * đang stale) → xoá role cùng toàn bộ gán/override của nó → bump
   * version từng context đó. Role thường không còn người giữ vẫn xoá
   * được như trước, cascade cả ghi đè còn lại nếu có.
   *
   * Nguyên tắc vô hiệu hoá cache quyền (áp dụng thống nhất cho gán,
   * gỡ và xoá): MỌI thay đổi về gán vai đều phải làm mới dấu version
   * của context liên quan qua `markContextDirty`. PermissionEvaluator
   * cache kết quả theo khoá nhúng dấu version của path với TTL một
   * giờ; thiếu lần bump này, quyền của role vừa xoá vẫn qua cổng từ
   * cache cho tới khi mục cache hết hạn.
   */
  async deleteRole(id: string): Promise<void> {
    const roleRow = await this.getRole(id);
    if (roleRow.archetype) {
      throw new BadRequestException({
        message: `Role ${roleRow.shortName} is a built-in archetype role and cannot be deleted`,
        code: 'access.role_archetype_delete_forbidden',
      });
    }
    const assignments = await this.repo.listAssignmentsByRole(id);
    if (assignments.length > 0) {
      throw new BadRequestException({
        message: `Role ${roleRow.shortName} is still held by ${assignments.length} assignment(s) and cannot be deleted`,
        code: 'access.role_has_assignments',
      });
    }
    const overrides = await this.repo.listRoleCapabilities(id);
    const contextIds = [...new Set([...assignments.map((a) => a.contextId), ...overrides.map((o) => o.contextId)])];
    await this.repo.deleteRole(id);
    for (const contextId of contextIds) await this.contexts.markContextDirty(contextId);
  }

  /**
   * Gán role cho user tại context; trùng gán hiện hữu (cùng role + cùng
   * NGUỒN) thì bỏ qua. `source` khai truy vết nguồn của dòng gán: ghi danh
   * truyền `{ component: 'enrol', itemId: <enrol instance id> }`; không
   * truyền = gán tay/hệ thống (component rỗng, itemId null). Cùng một
   * role/user/context có thể có nhiều dòng gán khác nguồn (vd vừa được
   * enrol cấp vừa được quản trị gán tay) — mỗi nguồn một dòng riêng, gỡ
   * nguồn nào chỉ mất dòng của nguồn đó.
   *
   * Sau khi chèn, `markContextDirty(contextId)` làm mới dấu version
   * của context: kết quả đánh giá quyền đã cache (TTL một giờ, khoá
   * nhúng dấu version của path) không còn khớp khoá mới nên lần kiểm
   * tra sau tính lại từ dữ kiện thật. Đây là một nửa của nguyên tắc
   * vô hiệu hoá cache quyền — nửa còn lại nằm ở đường gỡ/xoá: xem
   * `unassignRole` và `deleteRole`.
   */
  async assignRole(userId: string, roleId: string, contextId: string, modifierId?: string, source?: AssignmentSource, tx?: DbTx): Promise<unknown> {
    const roleRow = await this.getRole(roleId);
    await this.contexts.getContext(contextId, tx);
    // Điểm chặn SLOT GÓI TRUNG TÂM (phần còn lại của lát 2, issue
    // #189 — đặc tả slot đã duyệt): gán một vai trò GIẢNG DẠY tại bất
    // kỳ context nào trong cây của một tenant khách hàng cho một
    // thành viên đang hoạt động mà tài khoản đang hoạt động và CHƯA
    // được đếm là hành động làm tăng số slot của tenant đó — mọi
    // nguồn gán đều qua điểm này (gán tay qua API quản trị, ghi danh
    // cấp vai trò giảng dạy, gán chủ lớp/chủ khoá của các module
    // nghiệp vụ). Đã chạm hạn mức hiệu lực thì chặn TRƯỚC khi chèn
    // dòng gán, không dòng gán nào được tạo. Người đã được đếm, vai
    // trò không phải giảng dạy, và context ngoài cây tenant khách
    // hàng (tenant platform, context hệ thống) đều không bị chặn.
    if ((TEACHING_ROLE_ARCHETYPES as readonly string[]).includes(roleRow.archetype ?? '')) {
      const tenantId = await this.planLimits.tenantIdForContext(contextId, tx);
      if (tenantId) {
        const facts = await this.planLimits.describeUserInTenant(tenantId, userId);
        if (facts.membershipActive && facts.accountActive && !facts.counted) {
          await this.planLimits.assertTenantSlotForNewTeacher(tenantId, userId);
        }
      }
    }
    const component = source?.component ?? '';
    const itemId = source?.itemId ?? null;
    // Chốt TÁCH VAI chiều ngược (RoleSeparationService giữ định nghĩa
    // dùng chung): gán một vai GIẢNG DẠY không do ghi danh cấp tại
    // context khoá/lớp cho người đang là HỌC VIÊN ĐANG HOẠT ĐỘNG
    // trong khoá bị context đó bao phủ sẽ tạo lẫn vai cùng khoá —
    // từ chối TRƯỚC khi chèn dòng gán, cùng mã lỗi với các chốt ở
    // ba funnel ghi danh. Gán do ghi danh cấp (component = 'enrol')
    // không qua chốt này: đó là hệ quả máy móc của một ghi danh đã
    // được chốt ở funnel ghi danh, và instance cấp vai giảng dạy là
    // đường cấp vai của quản trị nằm ngoài quyết định tách vai.
    if (
      (TEACHING_ROLE_ARCHETYPES as readonly string[]).includes(roleRow.archetype ?? '')
      && !isEnrolManagedAssignment({ component })
    ) {
      await this.roleSeparation.assertTeachingAssignmentAllowed(userId, contextId);
    }
    const existing = await this.repo.listAssignments({ userId, contextId }, tx);
    const alreadyAssigned = existing.some((a) => a.roleId === roleId && a.component === component && (a.itemId ?? null) === itemId);
    const row = await this.repo.insertAssignment({ roleId: roleId, userId: userId, contextId: contextId, modifierId: modifierId, component, itemId }, tx);
    await this.contexts.markContextDirty(contextId, tx);
    if (!alreadyAssigned) {
      // Sự kiện role_assigned (Moodle \core\event\role_assigned) cho
      // logstore — chỉ phát khi gán thật sự mới (gán trùng là no-op).
      // Khi bên gọi đang ở trong một transaction (vd tạo lớp/bank —
      // issue #490), sự kiện được ghi bằng CHÍNH transaction đó để
      // rollback thì sự kiện cũng bị huỷ theo; không có tx thì giữ
      // đường standalone như trước.
      const event = {
        aggregate: 'access', type: 'role_assigned',
        payload: { assignmentId: (row as { id: string }).id, userId, roleId, contextId, actorId: modifierId ?? null, component, itemId },
      } as const;
      if (tx) await this.outbox.enqueue(tx, event);
      else await this.outbox.enqueueStandalone(event);
    }
    return row;
  }
  /**
   * Gỡ gán role của user tại context.
   *
   * Chốt toàn vẹn ghi danh (issue #157): dòng gán do GHI DANH cấp
   * (component='enrol') thuộc quyền quản lý của enrol — đường gỡ mặc định
   * (API quản trị `DELETE /access/assignments/:id`) KHÔNG được xoá, vì
   * xoá sẽ để lại một ghi danh còn hiệu lực mà không còn vai ở khoá. Chỉ
   * đường nội bộ của chính enrol (unenrol/đổi vai instance) mới gỡ được,
   * qua cờ tường minh `allowEnrolManaged`.
   *
   * Sau khi xoá dòng gán phải bump version của context của dòng gán
   * (nguyên tắc vô hiệu hoá cache quyền — xem `deleteRole`): mọi đường
   * gỡ gán trong sản phẩm đều chảy qua hàm này (API quản trị, rút ghi
   * danh, đồng bộ danh sách lớp, thu hồi chia sẻ ngân hàng câu hỏi),
   * nên bump tại đây thì thao tác thu hồi quyền có hiệu lực tức thì ở
   * mọi đường, thay vì chờ kết quả đã cache hết hạn (TTL một giờ).
   */
  async unassignRole(assignmentId: string, modifierId?: string, opts?: { allowEnrolManaged?: boolean }): Promise<void> {
    const existing = await this.repo.getAssignment(assignmentId);
    if (existing && isEnrolManagedAssignment(existing) && !opts?.allowEnrolManaged) {
      throw new BadRequestException({
        message: 'This role assignment is managed by an enrolment and cannot be removed directly; unenrol the user from the enrolment instance instead',
        code: 'access.assignment_enrol_managed',
      });
    }
    await this.repo.deleteAssignment(assignmentId);
    if (existing) {
      await this.contexts.markContextDirty(existing.contextId);
      // Sự kiện role_unassigned (Moodle \core\event\role_unassigned) cho logstore.
      await this.outbox.enqueueStandalone({
        aggregate: 'access', type: 'role_unassigned',
        payload: { assignmentId, userId: existing.userId, roleId: existing.roleId, contextId: existing.contextId, actorId: modifierId ?? null },
      });
    }
  }
  /**
   * Liệt kê gán role, lọc tuỳ chọn theo user.
   */
  async listAssignments(filter: { userId?: string; contextId?: string }, tx?: DbTx): Promise<unknown[]> {
    return this.repo.listAssignments(filter, tx);
  }
  /**
   * Liệt kê gán role cho bảng quản trị: lọc theo user/context/role,
   * tìm kiếm theo người dùng, phân trang phía server, mỗi dòng kèm
   * tên/email người dùng (ghép ở tầng repository). Đây là bề mặt đọc
   * của endpoint `GET /access/assignments`; hàm `listAssignments` ở
   * trên giữ nguyên cho các đường nội bộ cần toàn bộ dòng khớp bộ lọc
   * không qua phân trang.
   *
   * @returns các dòng của trang hiện tại kèm tổng số dòng khớp bộ lọc
   * và chính các tham số trang đã dùng, theo khuôn phản hồi liệt kê
   * người dùng hiện hành.
   */
  async listAssignmentsPage(
    filter: { userId?: string; contextId?: string; roleId?: string; search?: string },
    page: number,
    pageSize: number,
  ): Promise<{ assignments: AssignmentListRow[]; total: number; page: number; pageSize: number }> {
    const { rows, total } = await this.repo.listAssignmentsPage(filter, page, pageSize);
    return { assignments: rows, total, page, pageSize };
  }
  /**
   * Liệt kê người dùng kèm toàn bộ gán vai của họ cho bảng người dùng
   * của trang vai trò (`GET /access/users-with-assignments`).
   *
   * Đây là phép đọc gộp theo NGƯỜI DÙNG, bổ sung cho
   * `listAssignmentsPage` vốn phân trang theo từng dòng gán: tầng
   * repository đếm và cắt trang trên tập người dùng khớp cả ba bộ lọc
   * (tìm kiếm, vai, trạng thái) rồi chỉ nạp dòng gán của trang đó;
   * tầng này chỉ chuyển `createdAt` từ mốc thời gian của bản ghi sang
   * chuỗi ISO của hợp đồng. Bất biến giữ nguyên từ hợp đồng: `total`
   * đếm người dùng khớp lọc, mỗi người xuất hiện đúng một lần và mảng
   * `assignments` của họ không bị cắt theo vai đang lọc.
   *
   * Hàm chỉ đọc — không ghi dữ kiện, không phát sự kiện. Cổng năng
   * lực `role:assign` tại context hệ thống do controller áp trước khi
   * vào đây, cùng cổng với đường đọc bảng gán vai; người gọi thiếu
   * năng lực bị guard chặn bằng lỗi `access.capability_denied` (403),
   * không tới được hàm này.
   *
   * @param filter - Ba bộ lọc tuỳ chọn phía server: `search` (họ tên,
   * email, tên đăng nhập), `roleId` (người có ít nhất một gán với
   * vai này), `status` (nhóm trạng thái tài khoản).
   * @param page - Trang cần lấy (bắt đầu từ 1).
   * @param pageSize - Số người dùng tối đa trên một trang (trần 100
   * do validation ở DTO chặn trước).
   * @returns Trang người dùng kèm mảng gán của từng người, tổng số
   * người dùng khớp lọc và thông số trang đã áp.
   */
  async listUsersWithAssignmentsPage(
    filter: { search?: string; roleId?: string; status?: UserListStatus },
    page: number,
    pageSize: number,
  ): Promise<UserWithAssignmentsListResponse> {
    const { rows, total } = await this.repo.listUsersWithAssignmentsPage(filter, page, pageSize);
    return {
      users: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
      total,
      page,
      pageSize,
    };
  }
  /** Các assignment của một người dùng trên một tập context — ví dụ mọi context trên đường tổ tiên của đối tượng đích. Đây là phép tra cứu mà PermissionEvaluator dựa vào: assignment role được kế thừa xuống dưới theo cây context, nên assignment ở tổ tiên có hiệu lực tại lá. */
  /**
   * Lấy mọi gán role của user tại một tập context (vd toàn bộ đường tổ tiên của context khoá học) — cùng phép tra cứu mà PermissionEvaluator dùng để thừa hưởng gán từ context tổ tiên.
   */
  async listAssignmentsInContexts(userId: string, contextIds: string[]): Promise<{ roleId: string; contextId: string }[]> {
    return this.repo.getAssignmentsForUserInContexts(userId, contextIds);
  }

  /** Đặt (hoặc xoá, bằng CAP_INHERIT) một override capability cho một role tại một context; đánh dấu dirty cho toàn bộ cây con. */
  /**
   * Đặt override CAP_* cho role tại context (ALLOW/INHERIT/PREVENT/PROHIBIT).
   */
  async setCapabilityOverride(roleId: string, capability: string, contextId: string, permission: number, modifierId?: string, tx?: DbTx): Promise<void> {
    if (!VALID_PERMISSIONS.includes(permission)) {
      throw new BadRequestException({ message: `Invalid permission ${permission}`, code: 'access.invalid_permission' });
    }
    await this.getRole(roleId);
    await this.contexts.getContext(contextId, tx);
    if (permission === CAP_INHERIT) {
      await this.repo.deleteRoleCapability(contextId, roleId, capability, tx);
    } else {
      await this.repo.upsertRoleCapability({ contextId: contextId, roleId: roleId, capability, permission, modifierId: modifierId }, tx);
    }
    await this.contexts.markContextDirty(contextId, tx);
  }
  /**
   * Lưu ma trận quyền THAY TOÀN BỘ của một role tại đúng một context
   * trong một lần gọi — đường ghi theo lô thay cho việc đặt từng ghi
   * đè qua `setCapabilityOverride`.
   *
   * Flow: đọc role và context (vắng mặt thì 404 như các thao tác ghi
   * đè hiện hành) → kiểm chứng TOÀN BỘ tập gửi lên trước khi ghi bất
   * cứ thứ gì: một năng lực xuất hiện hai lần trong cùng tập bị từ
   * chối (`access.duplicate_capability_override`), giá trị quyền
   * ngoài bốn trạng thái bị từ chối (`access.invalid_permission`,
   * cùng mã với đường đặt một ghi đè), tên năng lực ngoài danh mục
   * bị từ chối (`access.unknown_capability`) → áp dụng nguyên tử
   * trong một transaction: xoá trọn tập ghi đè cũ của cặp
   * (role, context) rồi ghi lại đúng các phần tử có giá trị khác
   * INHERIT (phần tử vắng mặt trong tập gửi lên và phần tử mang
   * INHERIT tường minh đều kết thúc ở trạng thái không có ghi đè —
   * tức kế thừa — đúng ngữ nghĩa của đường đặt một ghi đè) → đánh
   * dấu dirty cho context như mọi thay đổi ghi đè khác.
   *
   * @returns tập ghi đè đã lưu của role tại context sau khi áp dụng,
   * sắp xếp theo tên năng lực.
   */
  async replaceRoleCapabilities(
    roleId: string,
    contextId: string,
    overrides: { capability: string; permission: number }[],
    modifierId?: string,
  ): Promise<{ capability: string; permission: number }[]> {
    await this.getRole(roleId);
    await this.contexts.getContext(contextId);
    const seen = new Set<string>();
    for (const entry of overrides) {
      if (seen.has(entry.capability)) {
        throw new BadRequestException({
          message: `Capability ${entry.capability} appears more than once in the submitted matrix`,
          code: 'access.duplicate_capability_override',
        });
      }
      seen.add(entry.capability);
      if (!VALID_PERMISSIONS.includes(entry.permission)) {
        throw new BadRequestException({ message: `Invalid permission ${entry.permission}`, code: 'access.invalid_permission' });
      }
    }
    const catalog = new Set((await this.repo.listCapabilities()).map((row) => row.name));
    for (const entry of overrides) {
      if (!catalog.has(entry.capability)) {
        throw new BadRequestException({ message: `Unknown capability ${entry.capability}`, code: 'access.unknown_capability' });
      }
    }
    const effective = overrides.filter((entry) => entry.permission !== CAP_INHERIT);
    await this.repo.dbHandle.transaction(async (tx) => {
      await this.repo.deleteRoleCapabilitiesInContext(roleId, contextId, tx);
      for (const entry of effective) {
        await this.repo.upsertRoleCapability({ contextId, roleId, capability: entry.capability, permission: entry.permission, modifierId }, tx);
      }
      await this.contexts.markContextDirty(contextId, tx);
    });
    const saved = await this.repo.listRoleCapabilitiesAtContext(roleId, contextId);
    return saved
      .map((row) => ({ capability: row.capability, permission: row.permission }))
      .sort((a, b) => a.capability.localeCompare(b.capability));
  }
  /**
   * Liệt kê override đã lưu của role.
   */
  async listRoleCapabilities(roleId: string): Promise<unknown[]> {
    await this.getRole(roleId);
    return this.repo.listRoleCapabilities(roleId);
  }
  /**
   * Đọc ma trận quyền của MỌI vai tại đúng một context trong một
   * lần gọi — bề mặt đọc cho trang Permissions toàn trang, thay cho
   * vòng gọi ma trận riêng của từng vai qua `listRoleCapabilities`
   * (vừa thừa số lần gọi, vừa kéo theo ghi đè của mọi context khác).
   *
   * Luồng: xác thực context tồn tại trước (vắng mặt thì ném
   * `access.context_not_found`, khớp hành vi của các đường đọc hiện
   * hành của module khi đối tượng được hỏi không tồn tại) → đọc
   * song song ba tập trong đúng lượt gọi này: danh sách vai, số
   * người giữ phân biệt theo vai (cùng phép tổng hợp của danh sách
   * vai) và toàn bộ dòng ghi đè thuộc đúng context được hỏi (một
   * truy vấn cho cả context, không lặp theo vai) → ghép ghi đè theo
   * vai. Vai không có ghi đè nào tại context vẫn xuất hiện với tập
   * rỗng; ghi đè của context khác không bao giờ rò vào kết quả vì
   * truy vấn đã neo đúng một context.
   *
   * @param contextId - Định danh của context cần đọc ma trận.
   * @returns `contextId` đã đọc kèm một dòng cho mỗi vai trong hệ.
   * @throws Lỗi 404 ProblemDetails `access.context_not_found` khi
   * context không tồn tại.
   */
  async getCapabilityMatrix(contextId: string): Promise<{ contextId: string; roles: RoleCapabilityMatrixItem[] }> {
    await this.contexts.getContext(contextId);
    const [roles, userCounts, overrideRows] = await Promise.all([
      this.repo.listRoles(),
      this.repo.countDistinctUsersByRole(),
      this.repo.listAllRoleCapabilitiesAtContext(contextId),
    ]);
    const userCountByRole = new Map(userCounts.map((row) => [row.roleId, row.userCount]));
    const overridesByRole = new Map<string, { capability: string; permission: number }[]>();
    for (const row of overrideRows) {
      const list = overridesByRole.get(row.roleId) ?? [];
      list.push({ capability: row.capability, permission: row.permission });
      overridesByRole.set(row.roleId, list);
    }
    return {
      contextId,
      roles: roles.map((roleRow) => ({
        id: roleRow.id,
        name: roleRow.name,
        userCount: userCountByRole.get(roleRow.id) ?? 0,
        overrides: overridesByRole.get(roleRow.id) ?? [],
      })),
    };
  }
  /**
   * Liệt kê mọi capability đã khai báo.
   */
  async listCapabilities(): Promise<unknown[]> { return this.repo.listCapabilities(); }
}
