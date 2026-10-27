import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OutboxService } from '../../infra/events/outbox.service';
import { AccessRepository, type RoleRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAPABILITY_DEFINITIONS, DEFAULT_ROLES } from './domain/capabilities';
import { CAP_ALLOW, CAP_INHERIT, CAP_PREVENT, CAP_PROHIBIT } from './domain/permission';

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
   * Liệt kê mọi role.
   */
  async listRoles(): Promise<RoleRow[]> { return this.repo.listRoles(); }
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
   * Xoá role (kèm gán và override của nó).
   */
  async deleteRole(id: string): Promise<void> {
    await this.getRole(id);
    await this.repo.deleteRole(id);
  }

  /**
   * Gán role cho user tại context; trùng gán hiện hữu (cùng role + cùng
   * NGUỒN) thì bỏ qua. `source` khai truy vết nguồn của dòng gán: ghi danh
   * truyền `{ component: 'enrol', itemId: <enrol instance id> }`; không
   * truyền = gán tay/hệ thống (component rỗng, itemId null). Cùng một
   * role/user/context có thể có nhiều dòng gán khác nguồn (vd vừa được
   * enrol cấp vừa được quản trị gán tay) — mỗi nguồn một dòng riêng, gỡ
   * nguồn nào chỉ mất dòng của nguồn đó.
   */
  async assignRole(userId: string, roleId: string, contextId: string, modifierId?: string, source?: AssignmentSource): Promise<unknown> {
    await this.getRole(roleId);
    await this.contexts.getContext(contextId);
    const component = source?.component ?? '';
    const itemId = source?.itemId ?? null;
    const existing = await this.repo.listAssignments({ userId, contextId });
    const alreadyAssigned = existing.some((a) => a.roleId === roleId && a.component === component && (a.itemId ?? null) === itemId);
    const row = await this.repo.insertAssignment({ roleId: roleId, userId: userId, contextId: contextId, modifierId: modifierId, component, itemId });
    await this.contexts.markContextDirty(contextId);
    if (!alreadyAssigned) {
      // Sự kiện role_assigned (Moodle \core\event\role_assigned) cho
      // logstore — chỉ phát khi gán thật sự mới (gán trùng là no-op).
      await this.outbox.enqueueStandalone({
        aggregate: 'access', type: 'role_assigned',
        payload: { assignmentId: (row as { id: string }).id, userId, roleId, contextId, actorId: modifierId ?? null, component, itemId },
      });
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
  async listAssignments(filter: { userId?: string; contextId?: string }): Promise<unknown[]> {
    return this.repo.listAssignments(filter);
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
  async setCapabilityOverride(roleId: string, capability: string, contextId: string, permission: number, modifierId?: string): Promise<void> {
    if (!VALID_PERMISSIONS.includes(permission)) {
      throw new BadRequestException({ message: `Invalid permission ${permission}`, code: 'access.invalid_permission' });
    }
    await this.getRole(roleId);
    await this.contexts.getContext(contextId);
    if (permission === CAP_INHERIT) {
      await this.repo.deleteRoleCapability(contextId, roleId, capability);
    } else {
      await this.repo.upsertRoleCapability({ contextId: contextId, roleId: roleId, capability, permission, modifierId: modifierId });
    }
    await this.contexts.markContextDirty(contextId);
  }
  /**
   * Liệt kê override đã lưu của role.
   */
  async listRoleCapabilities(roleId: string): Promise<unknown[]> {
    await this.getRole(roleId);
    return this.repo.listRoleCapabilities(roleId);
  }
  /**
   * Liệt kê mọi capability đã khai báo.
   */
  async listCapabilities(): Promise<unknown[]> { return this.repo.listCapabilities(); }
}
