import {
  sql,
  type ExpressionBuilder,
  type Insertable,
  type InsertObject,
  type RawBuilder,
  type Updateable,
} from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';
import type { UserListStatus } from '@lms/contracts';

/**
 * Kho dữ liệu phân quyền trên Kysely (issue #651, nhóm C của chiến
 * dịch chuyển tầng dữ liệu sang Kysely): chuyển nguyên vẹn bề mặt
 * của `AccessRepository` cũ ở `apps/api`  sang đây — bảng
 * `context`, `capabilities`, `role`, `role_assignments`,
 * `role_capabilities` và `config` (khoá `siteadmins`), cùng bốn
 * phép đọc cổng tenant (`tenants`, `tenant_memberships`).
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640) và
 * các repository đã chuyển trước đó:
 * - Cột đọc khai tường minh kèm bí danh camelCase dùng chung cho
 *   select và returning — KHÔNG bật CamelCasePlugin.
 * - Kiểu dòng công khai khai tay trong file này, khớp hình dạng
 *   `$inferSelect` của repository cũ để phía tiêu thụ không đổi
 *   hợp đồng.
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4).
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U): insert bỏ
 *   qua `id` và lấy id qua `returning`.
 * - `count(*)` ép `::int` tường minh để giữ kiểu `number` của hợp
 *   đồng cũ (T-7: `count(*)` là int8, qua pg sẽ là `string` nếu
 *   không ép).
 * - Điều kiện động dựng theo mẫu T-13: mọi điều kiện đều là biểu
 *   thức có giá trị bắt buộc, hợp bằng `eb.and(conds)`; KHÔNG bao
 *   giờ truyền `undefined` vào `where` (nó bị gắn thành NULL và
 *   lặng lẽ trả 0 dòng).
 * - Giá trị ghi vào cột jsonb đi qua helper `jsonbValue` duy nhất
 *   (khuôn §4 của PLAYBOOK: mảng cấp cao nhất qua pg bị hiểu là
 *   mảng PostgreSQL nếu không serialize trước).
 *
 * RANH GIỚI NGỮ CẢNH: repository này KHÔNG đọc ALS hay bất kỳ ngữ
 * cảnh app nào, KHÔNG tự lập ngữ cảnh platform. Bốn phép đọc dữ
 * kiện cổng (`getTenantGateInfo(s)`, `getMembershipStatus(es)`)
 * là truy vấn thuần túy — ngữ cảnh platform tường minh do tầng
 * service lập (`PermissionEvaluator.platformScope` bọc đúng bốn
 * điểm gọi, giữ không gian của request; xem issue #651 bước nâng
 * lớp bọc). Hai bảng cổng bật FORCE RLS nên đọc ngoài ngữ cảnh
 * platform sẽ thấy thiếu dòng — đó là trách nhiệm của bên gọi,
 * không phải của repository.
 *
 * Mọi truy vấn thuần dữ liệu; quy tắc nghiệp vụ nằm ở tầng
 * service/evaluator phía ứng dụng.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type AccessDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm. */
export type AccessTx = CentreTx;

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `context`. */
export interface ContextRow {
  id: string;
  contextLevel: number;
  instanceId: string | null;
  path: string;
  depth: number;
  locked: boolean;
  version: number;
}

/** Dòng `capabilities`. */
export interface CapabilityRow {
  id: string;
  name: string;
  capType: string;
  contextLevel: number;
  component: string;
  riskBitmask: number;
}

/** Dòng `role`. */
export interface RoleRow {
  id: string;
  name: string;
  shortName: string;
  description: string;
  sortOrder: number;
  archetype: string | null;
}

/** Dòng `role_assignments`. */
export interface AssignmentRow {
  id: string;
  roleId: string;
  userId: string;
  contextId: string;
  updatedAt: Date;
  modifierId: string | null;
  component: string;
  itemId: string | null;
}

/**
 * Một dòng của bảng gán vai: dòng gán đã lưu kèm tên đầy đủ và email của
 * người dùng được gán, do phép ghép với bảng người dùng trả về. Tên và
 * email là `null` khi người dùng không còn tồn tại — cột `userId` của
 * bảng gán không có khoá ngoại tới bảng người dùng nên dòng gán mồ côi
 * vẫn phải liệt kê được thay vì bị phép ghép nuốt mất.
 */
export type AssignmentListRow = AssignmentRow & {
  userName: string | null;
  userEmail: string | null;
};

/** Dòng `role_capabilities`. */
export interface RoleCapabilityRow {
  id: string;
  contextId: string;
  roleId: string;
  capability: string;
  permission: number;
  updatedAt: Date;
  modifierId: string | null;
}

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

// ---------------------------------------------------------------------------
// Kiểu ghi vào (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `context` (id do database sinh bằng uuidv7). */
export interface NewContext {
  contextLevel: number;
  instanceId: string | null;
  path: string;
  depth: number;
}

/** Giá trị chèn `role`. */
export interface NewRole {
  name: string;
  shortName: string;
  description?: string;
  archetype?: string | null;
  sortOrder?: number;
}

/** Giá trị chèn `role_assignments`. */
export interface NewAssignment {
  roleId: string;
  userId: string;
  contextId: string;
  modifierId?: string | null;
  component?: string;
  itemId?: string | null;
}

/** Giá trị chèn `role_capabilities`. */
export interface NewRoleCapability {
  contextId: string;
  roleId: string;
  capability: string;
  permission: number;
  modifierId?: string | null;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning)
// ---------------------------------------------------------------------------

const CONTEXT_COLUMNS = [
  'id',
  'context_level as contextLevel',
  'instance_id as instanceId',
  'path',
  'depth',
  'locked',
  'version',
] as const;

const CAPABILITY_COLUMNS = [
  'id',
  'name',
  'cap_type as capType',
  'context_level as contextLevel',
  'component',
  'risk_bitmask as riskBitmask',
] as const;

const ROLE_COLUMNS = [
  'id',
  'name',
  'short_name as shortName',
  'description',
  'sort_order as sortOrder',
  'archetype',
] as const;

const ASSIGNMENT_COLUMNS = [
  'id',
  'role_id as roleId',
  'user_id as userId',
  'context_id as contextId',
  'updated_at as updatedAt',
  'modifier_id as modifierId',
  'component',
  'item_id as itemId',
] as const;

const ROLE_CAPABILITY_COLUMNS = [
  'id',
  'context_id as contextId',
  'role_id as roleId',
  'capability',
  'permission',
  'updated_at as updatedAt',
  'modifier_id as modifierId',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function contextInsertValues(v: NewContext): Insertable<CentreDB['context']> {
  return {
    context_level: v.contextLevel,
    instance_id: v.instanceId,
    path: v.path,
    depth: v.depth,
  };
}

function roleInsertValues(v: NewRole): Insertable<CentreDB['role']> {
  const row: Insertable<CentreDB['role']> = {
    name: v.name,
    short_name: v.shortName,
  };
  if (v.description !== undefined) row.description = v.description;
  if (v.archetype !== undefined) row.archetype = v.archetype;
  if (v.sortOrder !== undefined) row.sort_order = v.sortOrder;
  return row;
}

function roleUpdateValues(v: Partial<NewRole>): Updateable<CentreDB['role']> {
  const set: Updateable<CentreDB['role']> = {};
  if (v.name !== undefined) set.name = v.name;
  if (v.shortName !== undefined) set.short_name = v.shortName;
  if (v.description !== undefined) set.description = v.description;
  if (v.archetype !== undefined) set.archetype = v.archetype;
  if (v.sortOrder !== undefined) set.sort_order = v.sortOrder;
  return set;
}

function assignmentInsertValues(v: NewAssignment): Insertable<CentreDB['role_assignments']> {
  const row: Insertable<CentreDB['role_assignments']> = {
    role_id: v.roleId,
    user_id: v.userId,
    context_id: v.contextId,
  };
  if (v.modifierId !== undefined) row.modifier_id = v.modifierId;
  if (v.component !== undefined) row.component = v.component;
  if (v.itemId !== undefined) row.item_id = v.itemId;
  return row;
}

function roleCapabilityInsertValues(v: NewRoleCapability): Insertable<CentreDB['role_capabilities']> {
  const row: Insertable<CentreDB['role_capabilities']> = {
    context_id: v.contextId,
    role_id: v.roleId,
    capability: v.capability,
    permission: v.permission,
  };
  if (v.modifierId !== undefined) row.modifier_id = v.modifierId;
  return row;
}

/**
 * Serialize một giá trị ghi vào cột jsonb (khuôn §4 của PLAYBOOK):
 * `pg` tự `JSON.stringify` object thường khi gắn tham số, nhưng mảng
 * ở cấp cao nhất bị hiểu là mảng PostgreSQL → cột jsonb báo lỗi cú
 * pháp. Mọi giá trị jsonb đều đi qua helper này.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Kho dữ liệu phân quyền: context, capability, role, gán role và override. Thuần dữ liệu — quyết định quyền nằm ở tầng service/evaluator. */
export class AccessRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Mở một transaction trên kho trung tâm. */
  async transaction<T>(fn: (tx: AccessTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  // --- contexts -----------------------------------------------------------

  /**
   * Chèn context mới; path/depth được service tính và cập nhật sau khi có id.
   */
  async insertContext(values: NewContext, tx?: AccessDb): Promise<ContextRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('context')
      .values(contextInsertValues(values))
      .returning(CONTEXT_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<ContextRow>;
  }

  /**
   * Cập nhật path vật chất hoá (danh sách id tổ tiên) và depth của context sau khi chèn/di chuyển.
   */
  async updateContextPath(id: string, path: string, depth: number, tx?: AccessDb): Promise<void> {
    const db = tx ?? this.handle;
    await db.updateTable('context').set({ path, depth }).where('id', '=', id).execute();
  }

  /**
   * Lấy context theo id; undefined nếu không tồn tại.
   */
  async getContextById(id: string, tx?: AccessDb): Promise<ContextRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('context')
      .select(CONTEXT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<ContextRow | undefined>;
  }

  /**
   * Lấy context theo cặp (contextLevel, instanceId) — khoá tự nhiên của cây context.
   */
  async getContextByLevelInstance(contextLevel: number, instanceId: string | null, tx?: AccessDb): Promise<ContextRow | undefined> {
    const db = tx ?? this.handle;
    let query = db
      .selectFrom('context')
      .select(CONTEXT_COLUMNS)
      .where('context_level', '=', contextLevel);
    query = instanceId === null
      ? query.where('instance_id', 'is', null)
      : query.where('instance_id', '=', instanceId);
    return query.executeTakeFirst() as Promise<ContextRow | undefined>;
  }

  /**
   * Context của NHIỀU instance cùng một level trong một truy vấn
   * (DL-07, issue #489): bản theo lô của `getContextByLevelInstance`
   * cho các đường đọc phải tra context của nhiều đối tượng cùng lúc
   * (vd context user của cả một trang danh sách tài khoản).
   */
  async getContextsByLevelInstances(contextLevel: number, instanceIds: string[]): Promise<ContextRow[]> {
    if (instanceIds.length === 0) return [];
    return this.handle
      .selectFrom('context')
      .select(CONTEXT_COLUMNS)
      .where('context_level', '=', contextLevel)
      .where('instance_id', 'in', instanceIds)
      .execute() as Promise<ContextRow[]>;
  }

  /**
   * Lấy nhiều context theo danh sách id (dùng khi duyệt path).
   */
  async getContextsByIds(ids: string[]): Promise<ContextRow[]> {
    if (ids.length === 0) return [];
    return this.handle
      .selectFrom('context')
      .select(CONTEXT_COLUMNS)
      .where('id', 'in', ids)
      .execute() as Promise<ContextRow[]>;
  }

  /**
   * Liệt kê toàn bộ context (phục vụ quản trị).
   */
  async listContexts(): Promise<ContextRow[]> {
    return this.handle
      .selectFrom('context')
      .select(CONTEXT_COLUMNS)
      .orderBy('path')
      .execute() as Promise<ContextRow[]>;
  }

  /**
   * Xoá context theo id.
   */
  async deleteContext(id: string): Promise<void> {
    await this.handle.deleteFrom('context').where('id', '=', id).execute();
  }

  /**
   * Tăng `version` cho một context và mọi context con cháu (theo tiền tố path) — cơ chế đánh dấu dirty đứng sau việc vô hiệu hoá cache của evaluator.
   */
  async bumpContextVersions(pathPrefix: string, tx?: AccessDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('context')
      .set({ version: sql<number>`version + 1` })
      .where((eb) => eb.or([
        eb('path', '=', pathPrefix),
        eb('path', 'like', `${pathPrefix}/%`),
      ]))
      .execute();
  }

  // --- tenants (cổng membership của evaluator, TENANT-0 #168) --------------
  //
  // Xem ghi chú ranh giới ngữ cảnh ở đầu file: bốn phép đọc này là
  // truy vấn thuần túy, ngữ cảnh platform do tầng service lập.

  /**
   * Thông tin cổng của tenant (kind + status) theo id; undefined khi tenant không tồn tại.
   * Gọi trong ngữ cảnh platform do evaluator lập.
   */
  async getTenantGateInfo(tenantId: string): Promise<{ kind: string; status: string } | undefined> {
    return this.handle
      .selectFrom('tenants')
      .select(['kind', 'status'])
      .where('id', '=', tenantId)
      .executeTakeFirst();
  }

  /** Trạng thái membership của user trong tenant; undefined khi chưa từng là thành viên. Gọi trong ngữ cảnh platform do evaluator lập. */
  async getMembershipStatus(tenantId: string, userId: string): Promise<string | undefined> {
    const row = await this.handle
      .selectFrom('tenant_memberships')
      .select(['status'])
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.status;
  }

  /** Thông tin cổng (kind + status) của NHIỀU tenant trong một truy vấn — bản theo lô của getTenantGateInfo, phục vụ phép phân giải theo lô của ảnh chụp quyền. Gọi trong ngữ cảnh platform do evaluator lập. */
  async getTenantGateInfos(tenantIds: string[]): Promise<{ id: string; kind: string; status: string }[]> {
    if (tenantIds.length === 0) return [];
    return this.handle
      .selectFrom('tenants')
      .select(['id', 'kind', 'status'])
      .where('id', 'in', tenantIds)
      .execute();
  }

  /** Trạng thái membership của một user trong NHIỀU tenant trong một truy vấn — bản theo lô của getMembershipStatus. Gọi trong ngữ cảnh platform do evaluator lập. */
  async getMembershipStatuses(tenantIds: string[], userId: string): Promise<{ tenantId: string; status: string }[]> {
    if (tenantIds.length === 0) return [];
    return this.handle
      .selectFrom('tenant_memberships')
      .select(['tenant_id as tenantId', 'status'])
      .where('tenant_id', 'in', tenantIds)
      .where('user_id', '=', userId)
      .execute();
  }

  // --- capabilities ---------------------------------------------------------

  /**
   * Khai báo/cập nhật định nghĩa capability (tên, loại rủi ro, contextLevel, archetypes).
   */
  async upsertCapability(def: { name: string; capType: string; contextLevel: number; component: string }): Promise<void> {
    await this.handle
      .insertInto('capabilities')
      .values({ name: def.name, cap_type: def.capType, context_level: def.contextLevel, component: def.component })
      .onConflict((oc) => oc.column('name').doUpdateSet({
        cap_type: def.capType,
        context_level: def.contextLevel,
        component: def.component,
      }))
      .execute();
  }

  /**
   * Liệt kê mọi capability đã khai báo.
   */
  async listCapabilities(): Promise<CapabilityRow[]> {
    return this.handle
      .selectFrom('capabilities')
      .select(CAPABILITY_COLUMNS)
      .orderBy('name')
      .execute() as Promise<CapabilityRow[]>;
  }

  /**
   * Xoá các định nghĩa capability không còn trong sổ đăng ký ở code (đồng bộ seed:
   * tên đã đổi/bỏ thì hàng cũ không được sót lại trong DB).
   */
  async deleteCapabilitiesNotIn(names: string[]): Promise<void> {
    await this.handle.deleteFrom('capabilities').where('name', 'not in', names).execute();
  }

  /**
   * Xoá các override role_capabilities trỏ tới capability không còn trong sổ đăng ký ở code.
   */
  async deleteRoleCapabilitiesNotIn(capabilityNames: string[]): Promise<void> {
    await this.handle.deleteFrom('role_capabilities').where('capability', 'not in', capabilityNames).execute();
  }

  // --- roles ----------------------------------------------------------------

  /**
   * Chèn role mới.
   */
  async insertRole(values: NewRole, tx?: AccessDb): Promise<RoleRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('role')
      .values(roleInsertValues(values))
      .returning(ROLE_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<RoleRow>;
  }

  /**
   * Lấy role theo id.
   */
  async getRoleById(id: string): Promise<RoleRow | undefined> {
    return this.handle
      .selectFrom('role')
      .select(ROLE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<RoleRow | undefined>;
  }

  /**
   * Lấy role theo shortName duy nhất.
   */
  async getRoleByShortname(shortName: string): Promise<RoleRow | undefined> {
    return this.handle
      .selectFrom('role')
      .select(ROLE_COLUMNS)
      .where('short_name', '=', shortName)
      .executeTakeFirst() as Promise<RoleRow | undefined>;
  }

  /**
   * Liệt kê mọi role.
   */
  async listRoles(): Promise<RoleRow[]> {
    return this.handle
      .selectFrom('role')
      .select(ROLE_COLUMNS)
      .orderBy('sort_order')
      .execute() as Promise<RoleRow[]>;
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
    return this.handle
      .selectFrom('role_assignments')
      .select([
        'role_id as roleId',
        sql<number>`count(distinct role_assignments.user_id)::int`.as('userCount'),
      ])
      .groupBy('role_id')
      .execute();
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
    return this.handle
      .selectFrom('role_capabilities')
      .leftJoin('capabilities', 'capabilities.name', 'role_capabilities.capability')
      .select([
        'role_capabilities.role_id as roleId',
        sql<number>`count(*)::int`.as('overrideCount'),
        sql<number>`coalesce(sum(case when capabilities.cap_type = 'read' then 1 else 0 end), 0)::int`.as('readOverrideCount'),
        sql<number>`coalesce(sum(case when capabilities.cap_type = 'write' then 1 else 0 end), 0)::int`.as('writeOverrideCount'),
        sql<number>`count(distinct split_part(role_capabilities.capability, ':', 1))::int`.as('resourceCount'),
      ])
      .groupBy('role_capabilities.role_id')
      .execute();
  }

  /**
   * Cập nhật thông tin role.
   */
  async updateRole(id: string, values: Partial<NewRole>): Promise<void> {
    await this.handle
      .updateTable('role')
      .set(roleUpdateValues(values))
      .where('id', '=', id)
      .execute();
  }

  /**
   * Xoá role (kèm gán và override của nó).
   */
  async deleteRole(id: string): Promise<void> {
    await this.handle.deleteFrom('role_assignments').where('role_id', '=', id).execute();
    await this.handle.deleteFrom('role_capabilities').where('role_id', '=', id).execute();
    await this.handle.deleteFrom('role').where('id', '=', id).execute();
  }

  // --- assignments ------------------------------------------------------------

  /**
   * Tìm dòng gán khớp đúng bộ (role, user, context, component, itemId) —
   * kể cả khi itemId NULL (điều kiện `is null`, vì `=` không bao giờ
   * khớp NULL). Dùng chung cho rào dedup trước khi chèn và fallback
   * đọc bù sau xung đột unique.
   */
  private findAssignmentByTuple(db: AccessDb, values: NewAssignment): Promise<AssignmentRow | undefined> {
    return db
      .selectFrom('role_assignments')
      .select(ASSIGNMENT_COLUMNS)
      .where((eb) => eb.and([
        eb('role_id', '=', values.roleId),
        eb('user_id', '=', values.userId),
        eb('context_id', '=', values.contextId),
        eb('component', '=', values.component ?? ''),
        ...(values.itemId != null
          ? [eb('item_id', '=', values.itemId)]
          : [eb('item_id', 'is', null)]),
      ]))
      .executeTakeFirst() as Promise<AssignmentRow | undefined>;
  }

  /**
   * Gán role cho user tại một context. Chèn trùng bộ unique trả về dòng
   * đã có thay vì lỗi — kể cả gán tay (itemId NULL): ràng buộc unique
   * của Postgres KHÔNG bắt được trùng khi itemId NULL (NULL coi như
   * khác nhau), nên bản cũ trước chuyển đổi lẫn bản port đầu tiên đều tạo dòng
   * mới cho trường hợp này dù ý đồ trong comment là dedup (phần
   * fallback của nó chỉ chạy khi có xung đột unique, tức không bao giờ
   * chạy cho itemId NULL). Vì vậy phải đọc trước dòng khớp đúng nguồn
   * rồi mới chèn; `onConflict doNothing` + đọc bù vẫn giữ làm lưới
   * chặn cho trường hợp itemId khác NULL và cho cuộc đua chèn song song.
   */
  async insertAssignment(values: NewAssignment, tx?: AccessDb): Promise<AssignmentRow> {
    const db = tx ?? this.handle;
    const preExisting = await this.findAssignmentByTuple(db, values);
    if (preExisting) return preExisting;
    const row = await db
      .insertInto('role_assignments')
      .values(assignmentInsertValues(values))
      .onConflict((oc) => oc.doNothing())
      .returning(ASSIGNMENT_COLUMNS)
      .executeTakeFirst();
    if (row) return row as AssignmentRow;
    // Fallback khi trùng unique (role, user, context, component, itemId):
    // phải khớp đúng NGUỒN của dòng sắp chèn — nếu không, gán của enrol có
    // thể trả về nhầm dòng gán tay (hoặc ngược lại) cùng role/user/context.
    const existing = await this.findAssignmentByTuple(db, values);
    return existing! as AssignmentRow;
  }

  /**
   * Gỡ một gán role cụ thể.
   */
  async deleteAssignment(id: string): Promise<void> {
    await this.handle.deleteFrom('role_assignments').where('id', '=', id).execute();
  }

  /**
   * Lấy một gán role theo id (phục vụ gỡ gán cần biết user/role/context của dòng sắp xoá).
   */
  async getAssignment(id: string): Promise<AssignmentRow | undefined> {
    return this.handle
      .selectFrom('role_assignments')
      .select(ASSIGNMENT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<AssignmentRow | undefined>;
  }

  /**
   * Liệt kê mọi gán role của một role (mọi user, mọi context). Phục vụ
   * đường xoá role: phải biết trước các context từng mang gán của role
   * để vô hiệu hoá cache quyền ở đúng các context đó sau khi xoá.
   */
  async listAssignmentsByRole(roleId: string): Promise<AssignmentRow[]> {
    return this.handle
      .selectFrom('role_assignments')
      .select(ASSIGNMENT_COLUMNS)
      .where('role_id', '=', roleId)
      .execute() as Promise<AssignmentRow[]>;
  }

  /**
   * Liệt kê gán role, lọc tuỳ chọn theo user.
   */
  async listAssignments(filter: { userId?: string; contextId?: string }, tx?: AccessDb): Promise<AssignmentRow[]> {
    const db = tx ?? this.handle;
    let query = db.selectFrom('role_assignments').select(ASSIGNMENT_COLUMNS);
    if (filter.userId !== undefined) query = query.where('user_id', '=', filter.userId);
    if (filter.contextId !== undefined) query = query.where('context_id', '=', filter.contextId);
    return query.execute() as Promise<AssignmentRow[]>;
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
   *
   * Điều kiện lọc dựng theo mẫu T-13 (chuỗi `.where` có điều kiện —
   * không có bộ lọc nào thì không có mệnh đề where, KHÔNG truyền
   * `undefined` vào where); cùng một bộ lọc áp cho cả truy vấn dòng
   * và truy vấn đếm.
   */
  async listAssignmentsPage(
    filter: { userId?: string; contextId?: string; roleId?: string; search?: string },
    page: number,
    pageSize: number,
  ): Promise<{ rows: AssignmentListRow[]; total: number }> {
    const filtered = () => {
      let query = this.handle
        .selectFrom('role_assignments')
        .leftJoin('users', 'users.id', 'role_assignments.user_id');
      if (filter.userId !== undefined) query = query.where('role_assignments.user_id', '=', filter.userId);
      if (filter.contextId !== undefined) query = query.where('role_assignments.context_id', '=', filter.contextId);
      if (filter.roleId !== undefined) query = query.where('role_assignments.role_id', '=', filter.roleId);
      if (filter.search) {
        const pattern = `%${filter.search}%`;
        query = query.where((eb) => eb.or([
          eb('users.first_name', 'ilike', pattern),
          eb('users.last_name', 'ilike', pattern),
          eb('users.email', 'ilike', pattern),
          eb('users.username', 'ilike', pattern),
          sql<boolean>`users.first_name || ' ' || users.last_name ilike ${pattern}`,
        ]));
      }
      return query;
    };
    const rows = await (filtered()
      .select([
        'role_assignments.id as id',
        'role_assignments.role_id as roleId',
        'role_assignments.user_id as userId',
        'role_assignments.context_id as contextId',
        'role_assignments.component as component',
        'role_assignments.item_id as itemId',
        'role_assignments.modifier_id as modifierId',
        'role_assignments.updated_at as updatedAt',
        sql<string | null>`case when users.id is null then null when trim(users.first_name || ' ' || users.last_name) = '' then users.username else trim(users.first_name || ' ' || users.last_name) end`.as('userName'),
        'users.email as userEmail',
      ])
      .orderBy('role_assignments.id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute() as Promise<AssignmentListRow[]>);
    const count = await filtered()
      .select(sql<number>`count(*)::int`.as('n'))
      .executeTakeFirst();
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
    const applyConditions = (eb: ExpressionBuilder<CentreDB, 'users'>) => {
      const conds = [eb('deleted', '=', filter.status === 'deleted')];
      if (filter.status === 'active') conds.push(eb('suspended', '=', false));
      if (filter.status === 'suspended') conds.push(eb('suspended', '=', true));
      if (filter.roleId !== undefined) {
        const roleId = filter.roleId;
        conds.push(eb.exists(
          eb.selectFrom('role_assignments')
            .select(sql`1`.as('one'))
            .where('role_assignments.user_id', '=', eb.ref('users.id'))
            .where('role_assignments.role_id', '=', roleId),
        ));
      }
      if (filter.search) {
        const pattern = `%${filter.search}%`;
        conds.push(eb.or([
          eb('first_name', 'ilike', pattern),
          eb('last_name', 'ilike', pattern),
          eb('email', 'ilike', pattern),
          eb('username', 'ilike', pattern),
          sql<boolean>`first_name || ' ' || last_name ilike ${pattern}`,
        ]));
      }
      return eb.and(conds);
    };
    const count = await this.handle
      .selectFrom('users')
      .select(sql<number>`count(*)::int`.as('n'))
      .where((eb) => applyConditions(eb))
      .executeTakeFirst();
    const total = count?.n ?? 0;
    const userRows = await this.handle
      .selectFrom('users')
      .select([
        'id',
        'username',
        'first_name as firstName',
        'last_name as lastName',
        'email',
        'suspended',
        'deleted',
        'created_at as createdAt',
      ])
      .where((eb) => applyConditions(eb))
      .orderBy('id')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    if (userRows.length === 0) return { rows: [], total };
    const assignmentRows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .innerJoin('context', 'context.id', 'role_assignments.context_id')
      .select([
        'role_assignments.id as id',
        'role_assignments.user_id as userId',
        'role_assignments.role_id as roleId',
        'role.name as roleName',
        'role_assignments.context_id as contextId',
        'context.context_level as contextLevel',
        'role_assignments.component as component',
      ])
      .where('role_assignments.user_id', 'in', userRows.map((row) => row.id))
      .orderBy('role_assignments.id')
      .execute();
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

  /**
   * Lấy mọi gán role của user tại các context cho trước (đầu vào của PermissionEvaluator).
   */
  async getAssignmentsForUserInContexts(userId: string, contextIds: string[]): Promise<AssignmentRow[]> {
    if (contextIds.length === 0) return [];
    return this.handle
      .selectFrom('role_assignments')
      .select(ASSIGNMENT_COLUMNS)
      .where('user_id', '=', userId)
      .where('context_id', 'in', contextIds)
      .execute() as Promise<AssignmentRow[]>;
  }

  // --- ghi đè capability ------------------------------------------------------

  /**
   * Ghi override quyền của role tại một context (CAP_*); ghi đè nếu đã có.
   */
  async upsertRoleCapability(values: NewRoleCapability, tx?: AccessDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .insertInto('role_capabilities')
      .values(roleCapabilityInsertValues(values))
      .onConflict((oc) => oc.columns(['context_id', 'role_id', 'capability']).doUpdateSet({
        permission: values.permission,
        updated_at: new Date(),
      }))
      .execute();
  }

  /**
   * Xoá một override cụ thể.
   */
  async deleteRoleCapability(contextId: string, roleId: string, capability: string, tx?: AccessDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .deleteFrom('role_capabilities')
      .where('context_id', '=', contextId)
      .where('role_id', '=', roleId)
      .where('capability', '=', capability)
      .execute();
  }

  /**
   * Lấy mọi override của các role tại các context cho trước (đầu vào của PermissionEvaluator).
   */
  async getOverridesForRoles(roleIds: string[], capability: string, contextIds: string[]): Promise<RoleCapabilityRow[]> {
    if (roleIds.length === 0 || contextIds.length === 0) return [];
    return this.handle
      .selectFrom('role_capabilities')
      .select(ROLE_CAPABILITY_COLUMNS)
      .where('role_id', 'in', roleIds)
      .where('capability', '=', capability)
      .where('context_id', 'in', contextIds)
      .execute() as Promise<RoleCapabilityRow[]>;
  }

  /**
   * Lấy mọi override của các role tại các context cho trước mà KHÔNG lọc theo
   * capability — bản theo lô phục vụ phép phân giải của ảnh chụp quyền: một
   * truy vấn nạp trọn ma trận override cần cho mọi capability, thay cho một
   * truy vấn riêng cho từng capability như getOverridesForRoles.
   */
  async getOverridesForRolesInContexts(roleIds: string[], contextIds: string[]): Promise<RoleCapabilityRow[]> {
    if (roleIds.length === 0 || contextIds.length === 0) return [];
    return this.handle
      .selectFrom('role_capabilities')
      .select(ROLE_CAPABILITY_COLUMNS)
      .where('role_id', 'in', roleIds)
      .where('context_id', 'in', contextIds)
      .execute() as Promise<RoleCapabilityRow[]>;
  }

  /** Xoá các override mặc định đã seed của một role tại một context (seed dùng để giữ các giá trị mặc định theo archetype đồng bộ với code). */
  async deleteRoleCapabilitiesAtContext(roleId: string, contextId: string, capabilityNames: string[]): Promise<void> {
    await this.handle
      .deleteFrom('role_capabilities')
      .where('role_id', '=', roleId)
      .where('context_id', '=', contextId)
      .where('capability', 'in', capabilityNames)
      .execute();
  }

  /**
   * Liệt kê override đã lưu của role (hiển thị ma trận capability).
   */
  async listRoleCapabilities(roleId: string): Promise<RoleCapabilityRow[]> {
    return this.handle
      .selectFrom('role_capabilities')
      .select(ROLE_CAPABILITY_COLUMNS)
      .where('role_id', '=', roleId)
      .execute() as Promise<RoleCapabilityRow[]>;
  }

  /**
   * Liệt kê override đã lưu của một role tại đúng một context — tập kết
   * quả của thao tác lưu ma trận thay toàn bộ và đầu vào kiểm chứng của nó.
   */
  async listRoleCapabilitiesAtContext(roleId: string, contextId: string, tx?: AccessDb): Promise<RoleCapabilityRow[]> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('role_capabilities')
      .select(ROLE_CAPABILITY_COLUMNS)
      .where('role_id', '=', roleId)
      .where('context_id', '=', contextId)
      .execute() as Promise<RoleCapabilityRow[]>;
  }

  /**
   * Liệt kê MỌI dòng ghi đè của MỌI role tại đúng một context — đầu
   * vào của ma trận quyền theo context: một truy vấn duy nhất nạp
   * trọn tập ghi đè của context, thay cho một truy vấn riêng cho
   * từng role khi phía gọi chỉ có `listRoleCapabilitiesAtContext`.
   * Sắp theo tên năng lực để tầng service ghép theo role ra tập đã
   * có thứ tự ổn định; ghi đè của context khác không nằm trong kết
   * quả vì điều kiện lọc neo đúng một context.
   *
   * @param contextId - Định danh của context cần đọc.
   * @returns Mọi dòng ghi đè thuộc context đó, của mọi role.
   */
  async listAllRoleCapabilitiesAtContext(contextId: string): Promise<RoleCapabilityRow[]> {
    return this.handle
      .selectFrom('role_capabilities')
      .select(ROLE_CAPABILITY_COLUMNS)
      .where('context_id', '=', contextId)
      .orderBy('capability')
      .execute() as Promise<RoleCapabilityRow[]>;
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
  async deleteRoleCapabilitiesInContext(roleId: string, contextId: string, tx?: AccessDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .deleteFrom('role_capabilities')
      .where('role_id', '=', roleId)
      .where('context_id', '=', contextId)
      .execute();
  }

  // --- cấu hình site (siteadmins nằm trong bảng `config`, giống $CFG->siteadmins của Moodle) ---

  /**
   * Đọc một giá trị cấu hình hệ thống (bảng config).
   */
  async getConfigValue(key: string): Promise<unknown> {
    const row = await this.handle
      .selectFrom('config')
      .select(['value'])
      .where('key', '=', key)
      .executeTakeFirst();
    return row?.value as unknown;
  }

  /**
   * Ghi một giá trị cấu hình hệ thống.
   */
  async setConfigValue(key: string, value: unknown): Promise<void> {
    const row: InsertObject<CentreDB, 'config'> = { key, value: jsonbValue(value) };
    await this.handle
      .insertInto('config')
      .values(row)
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: jsonbValue(value), updated_at: new Date() }))
      .execute();
  }
}
