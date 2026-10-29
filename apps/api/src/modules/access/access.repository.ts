import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray, isNull, like, notInArray, or, sql } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import { capabilities, config, context, role, roleAssignments, roleCapabilities, tenantMemberships, tenants } from '../../db/schema';
import { tenantAls } from '../tenants/tenant-als';

export type ContextRow = typeof context.$inferSelect;
export type RoleRow = typeof role.$inferSelect;

/** Truy cập dữ liệu chỉ dành cho module Access — các module khác phải dùng các service facade của Access. */
@Injectable()
/**
 * Kho dữ liệu phân quyền: context, capability, role, gán role và override.
 * Mọi truy vấn thuần SQL qua Drizzle; quy tắc nghiệp vụ nằm ở tầng service/evaluator.
 */
export class AccessRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  // --- contexts -----------------------------------------------------------
  /**
   * Chèn context mới; path/depth được service tính và cập nhật sau khi có id.
   */
  async insertContext(values: typeof context.$inferInsert, tx?: DbTx): Promise<ContextRow> {
    const db = tx ?? this.db;
    const [row] = await db.insert(context).values(values).returning();
    return row!;
  }
  /**
   * Cập nhật path vật chất hoá (danh sách id tổ tiên) và depth của context sau khi chèn/di chuyển.
   */
  async updateContextPath(id: string, path: string, depth: number, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db;
    await db.update(context).set({ path, depth }).where(eq(context.id, id));
  }
  /**
   * Lấy context theo id; undefined nếu không tồn tại.
   */
  async getContextById(id: string, tx?: DbTx): Promise<ContextRow | undefined> {
    const db = tx ?? this.db;
    const [row] = await db.select().from(context).where(eq(context.id, id));
    return row;
  }
  /**
   * Lấy context theo cặp (contextLevel, instanceId) — khoá tự nhiên của cây context.
   */
  async getContextByLevelInstance(contextLevel: number, instanceId: string | null, tx?: DbTx): Promise<ContextRow | undefined> {
    const db = tx ?? this.db;
    const [row] = await db.select().from(context)
      .where(and(eq(context.contextLevel, contextLevel), instanceId === null ? isNull(context.instanceId) : eq(context.instanceId, instanceId)));
    return row;
  }
  /**
   * Lấy nhiều context theo danh sách id (dùng khi duyệt path).
   */
  async getContextsByIds(ids: string[]): Promise<ContextRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(context).where(inArray(context.id, ids));
  }
  /**
   * Liệt kê toàn bộ context (phục vụ quản trị).
   */
  async listContexts(): Promise<ContextRow[]> {
    return this.db.select().from(context).orderBy(context.path);
  }
  /**
   * Xoá context theo id.
   */
  async deleteContext(id: string): Promise<void> {
    await this.db.delete(context).where(eq(context.id, id));
  }
  /** Tăng `version` cho một context và mọi context con cháu (theo tiền tố path) — cơ chế đánh dấu dirty đứng sau việc vô hiệu hoá cache của evaluator. */
  /**
   * Tăng version của các context để vô hiệu hoá cache quyền đã tính theo cây cũ.
   */
  async bumpContextVersions(pathPrefix: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db;
    await db.update(context).set({ version: sql`${context.version} + 1` })
      .where(or(eq(context.path, pathPrefix), like(context.path, `${pathPrefix}/%`)));
  }

  // --- tenants (cổng membership của evaluator, TENANT-0 #168) --------------

  /**
   * Thông tin cổng của tenant (kind + status) theo id; undefined khi tenant không tồn tại.
   *
   * Bốn phép đọc dữ kiện cổng trong mục này (thông tin tenant + trạng thái
   * membership, bản đơn và bản theo lô) LUÔN chạy trong ngữ cảnh platform
   * tường minh (`tenantAls.run({ platform: true }, ...)`), cùng khuôn đọc
   * xuyên tenant của `plan-limits.service.ts`. Lý do: `tenants` và
   * `tenant_memberships` là hai bảng FORCE RLS neo theo tenant của PHIÊN
   * cơ sở dữ liệu — đọc bằng phiên của người gọi thì bản ghi của tenant
   * khác vô hình, và kết quả `undefined`/thiếu dòng không phân biệt được
   * "bị RLS che" với "không tồn tại". Cổng tenant là một kiểm soát an
   * toàn, nên dữ kiện của nó không được phụ thuộc phiên của người gọi:
   * sau phép đọc ở ngữ cảnh platform, `undefined` chỉ còn nghĩa thật là
   * tenant không tồn tại, và evaluator dựa vào đó để từ chối khi không
   * xác minh được (fail-closed).
   */
  async getTenantGateInfo(tenantId: string): Promise<{ kind: string; status: string } | undefined> {
    return tenantAls.run({ platform: true }, async () => {
      const [row] = await this.db.select({ kind: tenants.kind, status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId));
      return row;
    });
  }

  /** Trạng thái membership của user trong tenant; undefined khi chưa từng là thành viên. Đọc ở ngữ cảnh platform — xem `getTenantGateInfo`. */
  async getMembershipStatus(tenantId: string, userId: string): Promise<string | undefined> {
    return tenantAls.run({ platform: true }, async () => {
      const [row] = await this.db
        .select({ status: tenantMemberships.status })
        .from(tenantMemberships)
        .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, userId)));
      return row?.status;
    });
  }

  /** Thông tin cổng (kind + status) của NHIỀU tenant trong một truy vấn — bản theo lô của getTenantGateInfo, phục vụ phép phân giải theo lô của ảnh chụp quyền. Đọc ở ngữ cảnh platform — xem `getTenantGateInfo`. */
  async getTenantGateInfos(tenantIds: string[]): Promise<{ id: string; kind: string; status: string }[]> {
    if (tenantIds.length === 0) return [];
    return tenantAls.run({ platform: true }, async () =>
      this.db.select({ id: tenants.id, kind: tenants.kind, status: tenants.status })
        .from(tenants).where(inArray(tenants.id, tenantIds)));
  }

  /** Trạng thái membership của một user trong NHIỀU tenant trong một truy vấn — bản theo lô của getMembershipStatus. Đọc ở ngữ cảnh platform — xem `getTenantGateInfo`. */
  async getMembershipStatuses(tenantIds: string[], userId: string): Promise<{ tenantId: string; status: string }[]> {
    if (tenantIds.length === 0) return [];
    return tenantAls.run({ platform: true }, async () =>
      this.db
        .select({ tenantId: tenantMemberships.tenantId, status: tenantMemberships.status })
        .from(tenantMemberships)
        .where(and(inArray(tenantMemberships.tenantId, tenantIds), eq(tenantMemberships.userId, userId))));
  }

  // --- capabilities ---------------------------------------------------------
  /**
   * Khai báo/cập nhật định nghĩa capability (tên, loại rủi ro, contextLevel, archetypes).
   */
  async upsertCapability(def: { name: string; capType: string; contextLevel: number; component: string }): Promise<void> {
    await this.db.insert(capabilities).values(def)
      .onConflictDoUpdate({ target: capabilities.name, set: { capType: def.capType, contextLevel: def.contextLevel, component: def.component } });
  }
  /**
   * Liệt kê mọi capability đã khai báo.
   */
  async listCapabilities(): Promise<(typeof capabilities.$inferSelect)[]> {
    return this.db.select().from(capabilities).orderBy(capabilities.name);
  }
  /**
   * Xoá các định nghĩa capability không còn trong sổ đăng ký ở code (đồng bộ seed:
   * tên đã đổi/bỏ thì hàng cũ không được sót lại trong DB).
   */
  async deleteCapabilitiesNotIn(names: string[]): Promise<void> {
    await this.db.delete(capabilities).where(notInArray(capabilities.name, names));
  }
  /**
   * Xoá các override role_capabilities trỏ tới capability không còn trong sổ đăng ký ở code.
   */
  async deleteRoleCapabilitiesNotIn(capabilityNames: string[]): Promise<void> {
    await this.db.delete(roleCapabilities).where(notInArray(roleCapabilities.capability, capabilityNames));
  }

  // --- roles ----------------------------------------------------------------
  /**
   * Chèn role mới.
   */
  async insertRole(values: typeof role.$inferInsert): Promise<RoleRow> {
    const [row] = await this.db.insert(role).values(values).returning();
    return row!;
  }
  /**
   * Lấy role theo id.
   */
  async getRoleById(id: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.select().from(role).where(eq(role.id, id));
    return row;
  }
  /**
   * Lấy role theo shortName duy nhất.
   */
  async getRoleByShortname(shortName: string): Promise<RoleRow | undefined> {
    const [row] = await this.db.select().from(role).where(eq(role.shortName, shortName));
    return row;
  }
  /**
   * Liệt kê mọi role.
   */
  async listRoles(): Promise<RoleRow[]> {
    return this.db.select().from(role).orderBy(role.sortOrder);
  }
  /**
   * Cập nhật thông tin role.
   */
  async updateRole(id: string, values: Partial<typeof role.$inferInsert>): Promise<void> {
    await this.db.update(role).set(values).where(eq(role.id, id));
  }
  /**
   * Xoá role.
   */
  async deleteRole(id: string): Promise<void> {
    await this.db.delete(roleAssignments).where(eq(roleAssignments.roleId, id));
    await this.db.delete(roleCapabilities).where(eq(roleCapabilities.roleId, id));
    await this.db.delete(role).where(eq(role.id, id));
  }

  // --- assignments ------------------------------------------------------------
  /**
   * Gán role cho user tại một context.
   */
  async insertAssignment(values: typeof roleAssignments.$inferInsert, tx?: DbTx): Promise<typeof roleAssignments.$inferSelect> {
    const db = tx ?? this.db;
    const [row] = await db.insert(roleAssignments).values(values)
      .onConflictDoNothing().returning();
    if (row) return row;
    // Fallback khi trùng unique (role, user, context, component, itemId):
    // phải khớp đúng NGUỒN của dòng sắp chèn — nếu không, gán của enrol có
    // thể trả về nhầm dòng gán tay (hoặc ngược lại) cùng role/user/context.
    const [existing] = await db.select().from(roleAssignments).where(and(
      eq(roleAssignments.roleId, values.roleId!), eq(roleAssignments.userId, values.userId!),
      eq(roleAssignments.contextId, values.contextId!),
      eq(roleAssignments.component, values.component ?? ''),
      values.itemId != null ? eq(roleAssignments.itemId, values.itemId) : isNull(roleAssignments.itemId)));
    return existing!;
  }
  /**
   * Gỡ một gán role cụ thể.
   */
  async deleteAssignment(id: string): Promise<void> {
    await this.db.delete(roleAssignments).where(eq(roleAssignments.id, id));
  }
  /**
   * Lấy một gán role theo id (phục vụ gỡ gán cần biết user/role/context của dòng sắp xoá).
   */
  async getAssignment(id: string): Promise<typeof roleAssignments.$inferSelect | undefined> {
    const [row] = await this.db.select().from(roleAssignments).where(eq(roleAssignments.id, id));
    return row;
  }
  /**
   * Liệt kê mọi gán role của một role (mọi user, mọi context). Phục vụ
   * đường xoá role: phải biết trước các context từng mang gán của role
   * để vô hiệu hoá cache quyền ở đúng các context đó sau khi xoá.
   */
  async listAssignmentsByRole(roleId: string): Promise<(typeof roleAssignments.$inferSelect)[]> {
    return this.db.select().from(roleAssignments).where(eq(roleAssignments.roleId, roleId));
  }
  /**
   * Liệt kê gán role, lọc tuỳ chọn theo user.
   */
  async listAssignments(filter: { userId?: string; contextId?: string }, tx?: DbTx): Promise<(typeof roleAssignments.$inferSelect)[]> {
    const db = tx ?? this.db;
    const conds = [];
    if (filter.userId !== undefined) conds.push(eq(roleAssignments.userId, filter.userId));
    if (filter.contextId !== undefined) conds.push(eq(roleAssignments.contextId, filter.contextId));
    return db.select().from(roleAssignments).where(conds.length ? and(...conds) : undefined);
  }
  /** Các assignment có context nằm trên đường tổ tiên cho trước (các id theo đúng thứ tự được truyền vào). */
  /**
   * Lấy mọi gán role của user tại các context cho trước (đầu vào của PermissionEvaluator).
   */
  async getAssignmentsForUserInContexts(userId: string, contextIds: string[]): Promise<(typeof roleAssignments.$inferSelect)[]> {
    if (contextIds.length === 0) return [];
    return this.db.select().from(roleAssignments)
      .where(and(eq(roleAssignments.userId, userId), inArray(roleAssignments.contextId, contextIds)));
  }

  // --- ghi đè capability ------------------------------------------------------
  /**
   * Ghi override quyền của role tại một context (CAP_*); ghi đè nếu đã có.
   */
  async upsertRoleCapability(values: typeof roleCapabilities.$inferInsert, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db;
    await db.insert(roleCapabilities).values(values).onConflictDoUpdate({
      target: [roleCapabilities.contextId, roleCapabilities.roleId, roleCapabilities.capability],
      set: { permission: values.permission, updatedAt: new Date() },
    });
  }
  /**
   * Xoá một override cụ thể.
   */
  async deleteRoleCapability(contextId: string, roleId: string, capability: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db;
    await db.delete(roleCapabilities).where(and(
      eq(roleCapabilities.contextId, contextId), eq(roleCapabilities.roleId, roleId),
      eq(roleCapabilities.capability, capability)));
  }
  /**
   * Lấy mọi override của các role tại các context cho trước (đầu vào của PermissionEvaluator).
   */
  async getOverridesForRoles(roleIds: string[], capability: string, contextIds: string[]): Promise<(typeof roleCapabilities.$inferSelect)[]> {
    if (roleIds.length === 0 || contextIds.length === 0) return [];
    return this.db.select().from(roleCapabilities).where(and(
      inArray(roleCapabilities.roleId, roleIds),
      eq(roleCapabilities.capability, capability),
      inArray(roleCapabilities.contextId, contextIds)));
  }
  /**
   * Lấy mọi override của các role tại các context cho trước mà KHÔNG lọc theo
   * capability — bản theo lô phục vụ phép phân giải của ảnh chụp quyền: một
   * truy vấn nạp trọn ma trận override cần cho mọi capability, thay cho một
   * truy vấn riêng cho từng capability như getOverridesForRoles.
   */
  async getOverridesForRolesInContexts(roleIds: string[], contextIds: string[]): Promise<(typeof roleCapabilities.$inferSelect)[]> {
    if (roleIds.length === 0 || contextIds.length === 0) return [];
    return this.db.select().from(roleCapabilities).where(and(
      inArray(roleCapabilities.roleId, roleIds),
      inArray(roleCapabilities.contextId, contextIds)));
  }
  /** Xoá các override mặc định đã seed của một role tại một context (seed dùng để giữ các giá trị mặc định theo archetype đồng bộ với code). */
  /**
   * Xoá toàn bộ override tại một context (khi context bị xoá).
   */
  async deleteRoleCapabilitiesAtContext(roleId: string, contextId: string, capabilityNames: string[]): Promise<void> {
    await this.db.delete(roleCapabilities).where(and(
      eq(roleCapabilities.roleId, roleId), eq(roleCapabilities.contextId, contextId),
      inArray(roleCapabilities.capability, capabilityNames)));
  }
  /**
   * Liệt kê override đã lưu của role (hiển thị ma trận capability).
   */
  async listRoleCapabilities(roleId: string): Promise<(typeof roleCapabilities.$inferSelect)[]> {
    return this.db.select().from(roleCapabilities).where(eq(roleCapabilities.roleId, roleId));
  }

  // --- cấu hình site (siteadmins nằm trong bảng `config`, giống $CFG->siteadmins của Moodle) ---
  /**
   * Đọc một giá trị cấu hình hệ thống (bảng config).
   */
  async getConfigValue(key: string): Promise<unknown> {
    const [row] = await this.db.select().from(config).where(eq(config.key, key));
    return row?.value;
  }
  /**
   * Ghi một giá trị cấu hình hệ thống.
   */
  async setConfigValue(key: string, value: unknown): Promise<void> {
    await this.db.insert(config).values({ key, value })
      .onConflictDoUpdate({ target: config.key, set: { value, updatedAt: new Date() } });
  }
}
