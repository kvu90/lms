import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq, exists, ilike, inArray, isNull, like, notInArray, or, sql } from 'drizzle-orm';
import type { UserListStatus } from '@lms/contracts';
import type { Database, DbTx } from '../../db/database';
import { capabilities, config, context, role, roleAssignments, roleCapabilities, tenantMemberships, tenants, users } from '../../db/schema';
import { tenantAls } from '../tenants/tenant-als';

export type ContextRow = typeof context.$inferSelect;
export type RoleRow = typeof role.$inferSelect;

/**
 * Một dòng của bảng gán vai: dòng gán đã lưu kèm tên đầy đủ và email của
 * người dùng được gán, do phép ghép với bảng người dùng trả về. Tên và
 * email là `null` khi người dùng không còn tồn tại — cột `userId` của
 * bảng gán không có khoá ngoại tới bảng người dùng nên dòng gán mồ côi
 * vẫn phải liệt kê được thay vì bị phép ghép nuốt mất.
 */
export type AssignmentListRow = (typeof roleAssignments.$inferSelect) & {
  userName: string | null;
  userEmail: string | null;
};

/**
 * Một dòng gán nằm trong danh sách người dùng kèm gán: dòng gán đã lưu
 * kèm tên hiển thị của vai và số cấp của context, do hai phép ghép nội
 * với bảng vai và bảng context trả về. Cả hai phép ghép đều là ghép nội
 * vì `roleId`/`contextId` của dòng gán là khoá ngoại bắt buộc — dòng gán
 * không thể trỏ tới vai hay context không tồn tại.
 */
export interface UserWithAssignmentsAssignmentRow {
  id: string;
  roleId: string;
  roleName: string;
  contextId: string;
  contextLevel: number;
  component: string;
}

/**
 * Một người dùng trong danh sách kèm gán vai: các trường tài khoản mà
 * bảng người dùng của trang vai trò cần (kèm `createdAt` cho cột ngày
 * tham gia và hai cờ trạng thái) cùng toàn bộ dòng gán của người đó.
 * `assignments` rỗng khi người dùng chưa giữ vai nào.
 */
export interface UserWithAssignmentsRow {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  suspended: boolean;
  deleted: boolean;
  createdAt: Date;
  assignments: UserWithAssignmentsAssignmentRow[];
}

/** Truy cập dữ liệu chỉ dành cho module Access — các module khác phải dùng các service facade của Access. */
@Injectable()
/**
 * Kho dữ liệu phân quyền: context, capability, role, gán role và override.
 * Mọi truy vấn thuần SQL qua Drizzle; quy tắc nghiệp vụ nằm ở tầng service/evaluator.
 */
export class AccessRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  /** Handle DB thô cho các service cần mở transaction nhiều bước (cùng khuôn với các repository khác của API). */
  get dbHandle(): Database { return this.db; }

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
   * Context của NHIỀU instance cùng một level trong một truy vấn
   * (DL-07, issue #489): bản theo lô của `getContextByLevelInstance`
   * cho các đường đọc phải tra context của nhiều đối tượng cùng lúc
   * (vd context user của cả một trang danh sách tài khoản).
   */
  async getContextsByLevelInstances(contextLevel: number, instanceIds: string[]): Promise<ContextRow[]> {
    if (!instanceIds.length) return [];
    return this.db.select().from(context)
      .where(and(eq(context.contextLevel, contextLevel), inArray(context.instanceId, instanceIds)));
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
   * Số người dùng PHÂN BIỆT đang giữ từng role — dữ kiện tổng hợp cho
   * danh sách role. Một người giữ cùng role ở nhiều context (hoặc qua
   * nhiều nguồn gán khác nhau) sinh nhiều dòng gán, nên phải đếm
   * `distinct user_id` chứ không đếm dòng: đếm dòng sẽ thổi phồng số
   * người giữ trên thẻ role. Role không có dòng gán nào vắng mặt trong
   * kết quả — tầng service hiểu là 0.
   */
  async countDistinctUsersByRole(): Promise<{ roleId: string; userCount: number }[]> {
    return this.db.select({
      roleId: roleAssignments.roleId,
      userCount: sql<number>`count(distinct ${roleAssignments.userId})::int`,
    }).from(roleAssignments).groupBy(roleAssignments.roleId);
  }
  /**
   * Tổng hợp năng lực theo từng role, tính từ tập ghi đè đã lưu của role
   * (đúng tập dữ kiện mà `listRoleCapabilities` trả về, ở mọi context):
   * tổng số ghi đè, số ghi đè theo `capType` của năng lực (read/write —
   * tra từ bảng danh mục qua phép ghép trái theo tên, ghi đè trỏ tới tên
   * ngoài danh mục vẫn tính vào tổng nhưng không vào hai cột read/write),
   * và số resource phân biệt mà các ghi đè chạm tới (resource là tiền tố
   * trước dấu `:` của tên năng lực). Role chưa có ghi đè nào vắng mặt
   * trong kết quả — tầng service hiểu là toàn 0.
   */
  async getRoleOverrideAggregates(): Promise<{ roleId: string; overrideCount: number; readOverrideCount: number; writeOverrideCount: number; resourceCount: number }[]> {
    return this.db.select({
      roleId: roleCapabilities.roleId,
      overrideCount: sql<number>`count(*)::int`,
      readOverrideCount: sql<number>`coalesce(sum(case when ${capabilities.capType} = 'read' then 1 else 0 end), 0)::int`,
      writeOverrideCount: sql<number>`coalesce(sum(case when ${capabilities.capType} = 'write' then 1 else 0 end), 0)::int`,
      resourceCount: sql<number>`count(distinct split_part(${roleCapabilities.capability}, ':', 1))::int`,
    }).from(roleCapabilities)
      .leftJoin(capabilities, eq(capabilities.name, roleCapabilities.capability))
      .groupBy(roleCapabilities.roleId);
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
  /**
   * Liệt kê gán role cho bảng quản trị: lọc theo user/context/role, tìm
   * kiếm theo người dùng và phân trang — mọi việc đều ở phía server.
   *
   * Flow: dựng điều kiện từ các bộ lọc đã cho → đếm tổng số dòng khớp
   * → lấy đúng một trang dòng, sắp theo id cho thứ tự trang ổn định
   * (cùng khuôn với phép tìm kiếm người dùng của module users). Tìm
   * kiếm khớp không phân biệt hoa thường trên họ, tên, họ+tên ghép,
   * email và tên đăng nhập của người dùng — cùng tập trường với phép
   * tìm kiếm người dùng hiện hành, cộng thêm dạng họ+tên ghép để tìm
   * theo tên đầy đủ ra kết quả. Phép ghép với bảng người dùng là ghép
   * TRÁI: dòng gán trỏ tới người dùng không còn tồn tại vẫn được liệt
   * kê (kèm tên/email null) thay vì biến mất khỏi bảng. Tên hiển thị
   * ghép họ + tên, rỗng cả hai thì lùi về tên đăng nhập.
   */
  async listAssignmentsPage(
    filter: { userId?: string; contextId?: string; roleId?: string; search?: string },
    page: number,
    pageSize: number,
  ): Promise<{ rows: AssignmentListRow[]; total: number }> {
    const conds = [];
    if (filter.userId !== undefined) conds.push(eq(roleAssignments.userId, filter.userId));
    if (filter.contextId !== undefined) conds.push(eq(roleAssignments.contextId, filter.contextId));
    if (filter.roleId !== undefined) conds.push(eq(roleAssignments.roleId, filter.roleId));
    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conds.push(or(
        ilike(users.firstName, pattern),
        ilike(users.lastName, pattern),
        ilike(users.email, pattern),
        ilike(users.username, pattern),
        sql`${users.firstName} || ' ' || ${users.lastName} ilike ${pattern}`,
      ));
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await this.db.select({
      id: roleAssignments.id,
      roleId: roleAssignments.roleId,
      userId: roleAssignments.userId,
      contextId: roleAssignments.contextId,
      component: roleAssignments.component,
      itemId: roleAssignments.itemId,
      modifierId: roleAssignments.modifierId,
      updatedAt: roleAssignments.updatedAt,
      userName: sql<string | null>`case when ${users.id} is null then null when trim(${users.firstName} || ' ' || ${users.lastName}) = '' then ${users.username} else trim(${users.firstName} || ' ' || ${users.lastName}) end`,
      userEmail: users.email,
    }).from(roleAssignments)
      .leftJoin(users, eq(users.id, roleAssignments.userId))
      .where(where)
      .orderBy(roleAssignments.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` })
      .from(roleAssignments)
      .leftJoin(users, eq(users.id, roleAssignments.userId))
      .where(where);
    return { rows, total: count?.n ?? 0 };
  }
  /**
   * Liệt kê người dùng kèm toàn bộ gán vai của họ cho bảng người dùng
   * của trang vai trò — đơn vị phân trang là NGƯỜI DÙNG, khác
   * `listAssignmentsPage` phân trang theo từng dòng gán.
   *
   * Flow: dựng điều kiện trên bảng người dùng từ ba bộ lọc → đếm tổng
   * số NGƯỜI DÙNG khớp → lấy đúng một trang người dùng sắp theo id
   * tăng dần cho thứ tự trang ổn định → chỉ khi trang không rỗng mới
   * nạp dòng gán của đúng các người dùng trong trang (ghép nội với
   * bảng vai để lấy tên vai và với bảng context để lấy số cấp) rồi
   * gom theo người dùng. Nhờ vậy chi phí nạp gán tỉ lệ với kích thước
   * trang, không tỉ lệ với toàn bộ tập khớp lọc.
   *
   * Ngữ nghĩa lọc: trạng thái suy ra từ hai cờ của tài khoản đúng như
   * phép tìm kiếm người dùng của module users (không truyền thì chỉ
   * lấy tài khoản chưa xoá gồm cả đang bị đình chỉ; `active` thêm
   * điều kiện không bị đình chỉ; `suspended` lấy tài khoản chưa xoá
   * đang bị đình chỉ; `deleted` chỉ lấy tài khoản đã xoá mềm). Lọc
   * theo vai là điều kiện TỒN TẠI một dòng gán với vai đó ở bất kỳ
   * context nào (EXISTS trên bảng gán) — nó chỉ quyết định người
   * dùng nào được liệt kê, KHÔNG cắt mảng gán: mỗi người trong kết
   * quả vẫn mang toàn bộ dòng gán của mình. Tìm kiếm khớp không phân
   * biệt hoa thường trên họ, tên, họ+tên ghép, email và tên đăng
   * nhập — cùng tập trường với `listAssignmentsPage`.
   *
   * @param filter - Ba bộ lọc tuỳ chọn: `search`, `roleId`, `status`.
   * @param page - Trang cần lấy (bắt đầu từ 1).
   * @param pageSize - Số người dùng tối đa trên một trang.
   * @returns Các người dùng của trang kèm mảng gán đã gom, và tổng số
   * người dùng khớp bộ lọc trên toàn bộ kết quả.
   */
  async listUsersWithAssignmentsPage(
    filter: { search?: string; roleId?: string; status?: UserListStatus },
    page: number,
    pageSize: number,
  ): Promise<{ rows: UserWithAssignmentsRow[]; total: number }> {
    const conds = [];
    if (filter.status === 'deleted') conds.push(eq(users.deleted, true));
    else conds.push(eq(users.deleted, false));
    if (filter.status === 'active') conds.push(eq(users.suspended, false));
    if (filter.status === 'suspended') conds.push(eq(users.suspended, true));
    if (filter.roleId !== undefined) {
      conds.push(exists(
        this.db.select({ one: sql`1` }).from(roleAssignments)
          .where(and(eq(roleAssignments.userId, users.id), eq(roleAssignments.roleId, filter.roleId))),
      ));
    }
    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conds.push(or(
        ilike(users.firstName, pattern),
        ilike(users.lastName, pattern),
        ilike(users.email, pattern),
        ilike(users.username, pattern),
        sql`${users.firstName} || ' ' || ${users.lastName} ilike ${pattern}`,
      ));
    }
    const where = conds.length ? and(...conds) : undefined;
    const [count] = await this.db.select({ n: sql<number>`count(*)::int` }).from(users).where(where);
    const total = count?.n ?? 0;
    const userRows = await this.db.select({
      id: users.id,
      username: users.username,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      suspended: users.suspended,
      deleted: users.deleted,
      createdAt: users.createdAt,
    }).from(users)
      .where(where)
      .orderBy(users.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    if (userRows.length === 0) return { rows: [], total };
    const assignmentRows = await this.db.select({
      id: roleAssignments.id,
      userId: roleAssignments.userId,
      roleId: roleAssignments.roleId,
      roleName: role.name,
      contextId: roleAssignments.contextId,
      contextLevel: context.contextLevel,
      component: roleAssignments.component,
    }).from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .innerJoin(context, eq(context.id, roleAssignments.contextId))
      .where(inArray(roleAssignments.userId, userRows.map((row) => row.id)))
      .orderBy(roleAssignments.id);
    const assignmentsByUser = new Map<string, UserWithAssignmentsAssignmentRow[]>();
    for (const row of assignmentRows) {
      const entry: UserWithAssignmentsAssignmentRow = {
        id: row.id,
        roleId: row.roleId,
        roleName: row.roleName,
        contextId: row.contextId,
        contextLevel: row.contextLevel,
        component: row.component,
      };
      const entries = assignmentsByUser.get(row.userId);
      if (entries) entries.push(entry);
      else assignmentsByUser.set(row.userId, [entry]);
    }
    return {
      rows: userRows.map((row) => ({ ...row, assignments: assignmentsByUser.get(row.id) ?? [] })),
      total,
    };
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
  /**
   * Liệt kê override đã lưu của một role tại đúng một context — tập kết
   * quả của thao tác lưu ma trận thay toàn bộ và đầu vào kiểm chứng của nó.
   */
  async listRoleCapabilitiesAtContext(roleId: string, contextId: string, tx?: DbTx): Promise<(typeof roleCapabilities.$inferSelect)[]> {
    const db = tx ?? this.db;
    return db.select().from(roleCapabilities).where(and(
      eq(roleCapabilities.roleId, roleId), eq(roleCapabilities.contextId, contextId)));
  }
  /**
   * Xoá MỌI override của một role tại đúng một context — bước dọn tập
   * cũ của thao tác lưu ma trận thay toàn bộ (sau bước này tầng service
   * ghi lại đúng tập mới trong cùng một transaction, nên tập lưu cuối
   * cùng bằng đúng tập được gửi lên). Khác
   * `deleteRoleCapabilitiesAtContext` ở chỗ hàm đó chỉ xoá theo danh
   * sách tên cho đường seed, còn hàm này xoá trọn tập của cặp
   * (role, context) bất kể tên.
   */
  async deleteRoleCapabilitiesInContext(roleId: string, contextId: string, tx?: DbTx): Promise<void> {
    const db = tx ?? this.db;
    await db.delete(roleCapabilities).where(and(
      eq(roleCapabilities.roleId, roleId), eq(roleCapabilities.contextId, contextId)));
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
