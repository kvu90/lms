import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { capabilities, config, context, role, roleAssignments, roleCapabilities } from '../../db/schema';

export type ContextRow = typeof context.$inferSelect;
export type RoleRow = typeof role.$inferSelect;

/** Data access for the Access module only — other modules must use the Access facade services. */
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
  async insertContext(values: typeof context.$inferInsert): Promise<ContextRow> {
    const [row] = await this.db.insert(context).values(values).returning();
    return row!;
  }
  /**
   * Cập nhật path vật chất hoá (danh sách id tổ tiên) và depth của context sau khi chèn/di chuyển.
   */
  async updateContextPath(id: string, path: string, depth: number): Promise<void> {
    await this.db.update(context).set({ path, depth }).where(eq(context.id, id));
  }
  /**
   * Lấy context theo id; undefined nếu không tồn tại.
   */
  async getContextById(id: string): Promise<ContextRow | undefined> {
    const [row] = await this.db.select().from(context).where(eq(context.id, id));
    return row;
  }
  /**
   * Lấy context theo cặp (contextLevel, instanceId) — khoá tự nhiên của cây context.
   */
  async getContextByLevelInstance(contextLevel: number, instanceId: string | null): Promise<ContextRow | undefined> {
    const [row] = await this.db.select().from(context)
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
  /** Bump `version` for a context and every descendant (path prefix) — the dirty-marking behind evaluator cache invalidation. */
  /**
   * Tăng version của các context để vô hiệu hoá cache quyền đã tính theo cây cũ.
   */
  async bumpContextVersions(pathPrefix: string): Promise<void> {
    await this.db.update(context).set({ version: sql`${context.version} + 1` })
      .where(or(eq(context.path, pathPrefix), like(context.path, `${pathPrefix}/%`)));
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
  async insertAssignment(values: typeof roleAssignments.$inferInsert): Promise<typeof roleAssignments.$inferSelect> {
    const [row] = await this.db.insert(roleAssignments).values(values)
      .onConflictDoNothing().returning();
    if (row) return row;
    const [existing] = await this.db.select().from(roleAssignments).where(and(
      eq(roleAssignments.roleId, values.roleId!), eq(roleAssignments.userId, values.userId!),
      eq(roleAssignments.contextId, values.contextId!)));
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
   * Liệt kê gán role, lọc tuỳ chọn theo user.
   */
  async listAssignments(filter: { userId?: string; contextId?: string }): Promise<(typeof roleAssignments.$inferSelect)[]> {
    const conds = [];
    if (filter.userId !== undefined) conds.push(eq(roleAssignments.userId, filter.userId));
    if (filter.contextId !== undefined) conds.push(eq(roleAssignments.contextId, filter.contextId));
    return this.db.select().from(roleAssignments).where(conds.length ? and(...conds) : undefined);
  }
  /** Assignments whose context is on the given ancestor path (ids ordered as supplied). */
  /**
   * Lấy mọi gán role của user tại các context cho trước (đầu vào của PermissionEvaluator).
   */
  async getAssignmentsForUserInContexts(userId: string, contextIds: string[]): Promise<(typeof roleAssignments.$inferSelect)[]> {
    if (contextIds.length === 0) return [];
    return this.db.select().from(roleAssignments)
      .where(and(eq(roleAssignments.userId, userId), inArray(roleAssignments.contextId, contextIds)));
  }

  // --- capability overrides ---------------------------------------------------
  /**
   * Ghi override quyền của role tại một context (CAP_*); ghi đè nếu đã có.
   */
  async upsertRoleCapability(values: typeof roleCapabilities.$inferInsert): Promise<void> {
    await this.db.insert(roleCapabilities).values(values).onConflictDoUpdate({
      target: [roleCapabilities.contextId, roleCapabilities.roleId, roleCapabilities.capability],
      set: { permission: values.permission, updatedAt: new Date() },
    });
  }
  /**
   * Xoá một override cụ thể.
   */
  async deleteRoleCapability(contextId: string, roleId: string, capability: string): Promise<void> {
    await this.db.delete(roleCapabilities).where(and(
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
  /** Remove a role's seeded default overrides at one context (used by seed to keep archetype defaults in sync with code). */
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

  // --- site config (siteadmins lives in the `config` table, like Moodle $CFG->siteadmins) ---
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
