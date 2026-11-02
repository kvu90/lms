import type { CentreDb, CentreTx } from '../client';

/**
 * Kho dữ liệu nhóm trên Kysely (issue #645, nhóm G5 của chiến
 * dịch chuyển tầng dữ liệu sang Kysely): TOÀN BỘ bề mặt của
 * `GroupsRepository` cũ ở `apps/api` (Drizzle) được chuyển nguyên
 * vẹn sang đây — group, grouping, thành viên nhóm và cohort (nhóm
 * hệ thống/danh mục).
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640):
 * - Cột đọc khai tường minh kèm bí danh camelCase dùng chung cho
 *   select và returning — KHÔNG bật CamelCasePlugin.
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4).
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U): insert bỏ
 *   qua `id` và lấy id qua `returning`.
 * - Ba điểm `onConflictDoNothing` của bản Drizzle cũ (thêm thành
 *   viên nhóm, đưa nhóm vào grouping, thêm thành viên cohort)
 *   dùng `onConflict … doNothing()` tương đương; riêng
 *   `addCohortMember` suy luận "đã chèn thật hay chưa" từ độ dài
 *   của `returning` như bản cũ.
 *
 * `removeCohortMember` nhận handle tuỳ chọn (mặc định handle
 * thường): đường gỡ thành viên TRONG transaction của bên gọi
 * (settle hoàn tiền — điểm nối C-8/C, đã đóng ở #656) truyền
 * transaction của bên gọi vào để việc gỡ và ghi sổ hoàn commit
 * cùng nhau.
 *
 * Bề mặt kiểu dòng giữ đúng hình dạng `$inferSelect` của
 * repository cũ để phía tiêu thụ trong module groups không đổi
 * hợp đồng.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type GroupsDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm. */
export type GroupsTx = CentreTx;

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `course_groups`. */
export interface GroupRow {
  id: string;
  courseId: string;
  name: string;
  idNumber: string;
  description: string;
  enrolmentKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `groups_members`. */
export interface GroupMemberRow {
  id: string;
  groupId: string;
  userId: string;
  timeAdded: Date;
  component: string;
  itemId: string | null;
}

/** Dòng `groupings`. */
export interface GroupingRow {
  id: string;
  courseId: string;
  name: string;
  idNumber: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `cohort`. */
export interface CohortRow {
  id: string;
  tenantId: string;
  name: string;
  idNumber: string;
  description: string;
  contextId: string;
  component: string;
  visible: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `cohort_members`. */
export interface CohortMemberRow {
  cohortId: string;
  userId: string;
  timeAdded: Date;
}

// ---------------------------------------------------------------------------
// Kiểu ghi vào (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `course_groups`. */
export interface NewGroup {
  id?: string;
  courseId: string;
  name: string;
  idNumber?: string;
  description?: string;
  enrolmentKey?: string | null;
}

/** Giá trị chèn `groupings`. */
export interface NewGrouping {
  id?: string;
  courseId: string;
  name: string;
  idNumber?: string;
  description?: string;
}

/** Giá trị chèn `cohort`. */
export interface NewCohort {
  id?: string;
  tenantId: string;
  name: string;
  idNumber?: string;
  description?: string;
  contextId: string;
  component?: string;
  visible?: boolean;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning)
// ---------------------------------------------------------------------------

const GROUP_COLUMNS = [
  'id',
  'course_id as courseId',
  'name',
  'id_number as idNumber',
  'description',
  'enrolment_key as enrolmentKey',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const GROUP_MEMBER_COLUMNS = [
  'id',
  'group_id as groupId',
  'user_id as userId',
  'time_added as timeAdded',
  'component',
  'item_id as itemId',
] as const;

const GROUPING_COLUMNS = [
  'id',
  'course_id as courseId',
  'name',
  'id_number as idNumber',
  'description',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const COHORT_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'name',
  'id_number as idNumber',
  'description',
  'context_id as contextId',
  'component',
  'visible',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const COHORT_MEMBER_COLUMNS = ['cohort_id as cohortId', 'user_id as userId', 'time_added as timeAdded'] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function groupInsertValues(v: NewGroup) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course_id: v.courseId,
    name: v.name,
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.enrolmentKey !== undefined ? { enrolment_key: v.enrolmentKey } : {}),
  };
}

function groupUpdateValues(v: Partial<NewGroup>) {
  return {
    ...(v.courseId !== undefined ? { course_id: v.courseId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.enrolmentKey !== undefined ? { enrolment_key: v.enrolmentKey } : {}),
  };
}

function groupingInsertValues(v: NewGrouping) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course_id: v.courseId,
    name: v.name,
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
  };
}

function cohortInsertValues(v: NewCohort) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    tenant_id: v.tenantId,
    name: v.name,
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    context_id: v.contextId,
    ...(v.component !== undefined ? { component: v.component } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
  };
}

function cohortUpdateValues(v: Partial<NewCohort>) {
  return {
    ...(v.tenantId !== undefined ? { tenant_id: v.tenantId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.idNumber !== undefined ? { id_number: v.idNumber } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.contextId !== undefined ? { context_id: v.contextId } : {}),
    ...(v.component !== undefined ? { component: v.component } : {}),
    ...(v.visible !== undefined ? { visible: v.visible } : {}),
  };
}

/**
 * Kho dữ liệu nhóm: group, grouping, thành viên nhóm và cohort
 * (nhóm hệ thống/danh mục).
 */
export class GroupsRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Mở một transaction trên kho trung tâm. */
  async transaction<T>(fn: (tx: GroupsTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  /** Chèn nhóm khoá học. */
  async insertGroup(v: NewGroup): Promise<GroupRow> {
    return this.handle
      .insertInto('course_groups')
      .values(groupInsertValues(v))
      .returning(GROUP_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<GroupRow>;
  }

  /** Lấy nhóm theo id. */
  async getGroup(id: string): Promise<GroupRow | undefined> {
    return this.handle
      .selectFrom('course_groups')
      .select(GROUP_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<GroupRow | undefined>;
  }

  /** Liệt kê nhóm của khoá học. */
  async listGroups(courseId: string): Promise<GroupRow[]> {
    return this.handle
      .selectFrom('course_groups')
      .select(GROUP_COLUMNS)
      .where('course_id', '=', courseId)
      .orderBy('id', 'asc')
      .execute() as Promise<GroupRow[]>;
  }

  /** Cập nhật nhóm. */
  async updateGroup(id: string, v: Partial<NewGroup>): Promise<void> {
    await this.handle
      .updateTable('course_groups')
      .set({ ...groupUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá nhóm. */
  async deleteGroup(id: string): Promise<void> {
    await this.handle.deleteFrom('course_groups').where('id', '=', id).execute();
  }

  /** Thêm thành viên vào nhóm (trùng thì bỏ qua). */
  async addMember(groupId: string, userId: string, component = '', itemId: string | null = null): Promise<void> {
    await this.handle
      .insertInto('groups_members')
      .values({ group_id: groupId, user_id: userId, component, item_id: itemId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /** Gỡ thành viên khỏi nhóm. */
  async removeMember(groupId: string, userId: string): Promise<void> {
    await this.handle
      .deleteFrom('groups_members')
      .where('group_id', '=', groupId)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Thành viên của một nhóm. */
  async listMembers(groupId: string): Promise<GroupMemberRow[]> {
    return this.handle
      .selectFrom('groups_members')
      .select(GROUP_MEMBER_COLUMNS)
      .where('group_id', '=', groupId)
      .orderBy('id', 'asc')
      .execute() as Promise<GroupMemberRow[]>;
  }

  /** Thành viên của nhiều nhóm (gộp). */
  async listMembersOfGroups(groupIds: string[]): Promise<GroupMemberRow[]> {
    if (!groupIds.length) return [];
    return this.handle
      .selectFrom('groups_members')
      .select(GROUP_MEMBER_COLUMNS)
      .where('group_id', 'in', groupIds)
      .execute() as Promise<GroupMemberRow[]>;
  }

  /** Các nhóm user thuộc về trong khoá học. */
  async groupsOfUser(courseId: string, userId: string): Promise<GroupRow[]> {
    const memberRows = (await this.handle
      .selectFrom('groups_members')
      .select(GROUP_MEMBER_COLUMNS)
      .where('user_id', '=', userId)
      .execute()) as GroupMemberRow[];
    const ids = memberRows.map((m) => m.groupId);
    if (!ids.length) return [];
    return this.handle
      .selectFrom('course_groups')
      .select(GROUP_COLUMNS)
      .where('course_id', '=', courseId)
      .where('id', 'in', ids)
      .execute() as Promise<GroupRow[]>;
  }

  /** User có là thành viên nhóm hay không. */
  async isMember(groupId: string, userId: string): Promise<boolean> {
    const row = await this.handle
      .selectFrom('groups_members')
      .select(GROUP_MEMBER_COLUMNS)
      .where('group_id', '=', groupId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return !!row;
  }

  /** Chèn grouping (nhóm của các nhóm). */
  async insertGrouping(v: NewGrouping): Promise<GroupingRow> {
    return this.handle
      .insertInto('groupings')
      .values(groupingInsertValues(v))
      .returning(GROUPING_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<GroupingRow>;
  }

  /** Lấy grouping theo id. */
  async getGrouping(id: string): Promise<GroupingRow | undefined> {
    return this.handle
      .selectFrom('groupings')
      .select(GROUPING_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<GroupingRow | undefined>;
  }

  /** Liệt kê grouping của khoá học. */
  async listGroupings(courseId: string): Promise<GroupingRow[]> {
    return this.handle
      .selectFrom('groupings')
      .select(GROUPING_COLUMNS)
      .where('course_id', '=', courseId)
      .orderBy('id', 'asc')
      .execute() as Promise<GroupingRow[]>;
  }

  /** Xoá grouping. */
  async deleteGrouping(id: string): Promise<void> {
    await this.handle.deleteFrom('groupings').where('id', '=', id).execute();
  }

  /** Đưa nhóm vào grouping (trùng thì bỏ qua). */
  async addGroupToGrouping(groupingId: string, groupId: string): Promise<void> {
    await this.handle
      .insertInto('groupings_groups')
      .values({ grouping_id: groupingId, group_id: groupId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  /** Gỡ nhóm khỏi grouping. */
  async removeGroupFromGrouping(groupingId: string, groupId: string): Promise<void> {
    await this.handle
      .deleteFrom('groupings_groups')
      .where('grouping_id', '=', groupingId)
      .where('group_id', '=', groupId)
      .execute();
  }

  /** Các nhóm thuộc grouping. */
  async groupsInGrouping(groupingId: string): Promise<GroupRow[]> {
    const links = await this.handle
      .selectFrom('groupings_groups')
      .select(['grouping_id as groupingId', 'group_id as groupId', 'time_added as timeAdded'])
      .where('grouping_id', '=', groupingId)
      .execute();
    if (!links.length) return [];
    return this.handle
      .selectFrom('course_groups')
      .select(GROUP_COLUMNS)
      .where('id', 'in', links.map((l) => l.groupId))
      .execute() as Promise<GroupRow[]>;
  }

  /** Chèn cohort. */
  async insertCohort(v: NewCohort): Promise<CohortRow> {
    return this.handle
      .insertInto('cohort')
      .values(cohortInsertValues(v))
      .returning(COHORT_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<CohortRow>;
  }

  /** Lấy cohort theo id. */
  async getCohort(id: string): Promise<CohortRow | undefined> {
    return this.handle
      .selectFrom('cohort')
      .select(COHORT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<CohortRow | undefined>;
  }

  /** Liệt kê cohort. */
  async listCohorts(): Promise<CohortRow[]> {
    return this.handle
      .selectFrom('cohort')
      .select(COHORT_COLUMNS)
      .orderBy('id', 'asc')
      .execute() as Promise<CohortRow[]>;
  }

  /** Cập nhật cohort. */
  async updateCohort(id: string, v: Partial<NewCohort>): Promise<void> {
    await this.handle
      .updateTable('cohort')
      .set({ ...cohortUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá cohort. */
  async deleteCohort(id: string): Promise<void> {
    await this.handle.deleteFrom('cohort').where('id', '=', id).execute();
  }

  /** Thêm thành viên cohort; trả `true` khi dòng thật sự được chèn (chưa là thành viên). */
  async addCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const inserted = await this.handle
      .insertInto('cohort_members')
      .values({ cohort_id: cohortId, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .returning('cohort_id as cohortId')
      .execute();
    return inserted.length > 0;
  }

  /** Gỡ thành viên cohort; trả `true` khi có dòng bị xoá. */
  async removeCohortMember(cohortId: string, userId: string, db: GroupsDb = this.handle): Promise<boolean> {
    const deleted = await db
      .deleteFrom('cohort_members')
      .where('cohort_id', '=', cohortId)
      .where('user_id', '=', userId)
      .returning('cohort_id as cohortId')
      .execute();
    return deleted.length > 0;
  }

  /** Thành viên của cohort. */
  async listCohortMembers(cohortId: string): Promise<CohortMemberRow[]> {
    return this.handle
      .selectFrom('cohort_members')
      .select(COHORT_MEMBER_COLUMNS)
      .where('cohort_id', '=', cohortId)
      .orderBy('time_added', 'asc')
      .execute() as Promise<CohortMemberRow[]>;
  }

  /** User có thuộc cohort hay không. */
  async isCohortMember(cohortId: string, userId: string): Promise<boolean> {
    const row = await this.handle
      .selectFrom('cohort_members')
      .select(COHORT_MEMBER_COLUMNS)
      .where('cohort_id', '=', cohortId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return !!row;
  }
}
