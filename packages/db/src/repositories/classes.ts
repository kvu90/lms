import { sql } from 'kysely';
import type { CentreDb, CentreTx } from '../client';
import type { CourseRow } from './courses';

/**
 * Kho dữ liệu lớp học trên Kysely (issue #645, nhóm G5 của chiến
 * dịch chuyển tầng dữ liệu sang Kysely): TOÀN BỘ bề mặt của
 * `ClassesRepository` cũ ở `apps/api` (Drizzle) được chuyển nguyên
 * vẹn sang đây — bảng `classes`, các truy vấn vật chất hoá phía lớp
 * (khoá của lớp, ghi danh active/đình chỉ suy từ instance cohort),
 * mã tham gia và hàng chờ tự báo danh. Riêng ba lệnh ghi của giao
 * dịch tạo lớp (cohort nền, dòng lớp, nối context cho cohort)
 * KHÔNG nằm ở đây: giao dịch tạo lớp còn giữ phía Drizzle theo
 * điểm dừng của điểm nối C-8/B (xem `CORRECTIONS.md` của chiến
 * dịch) nên chúng sống ở repository chuyển tiếp phía api cho tới
 * khi đợt access (#651) lật giao dịch đó sang Kysely.
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640):
 * - Cột đọc khai tường minh kèm bí danh camelCase dùng chung cho
 *   select và returning — KHÔNG bật CamelCasePlugin.
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4).
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U): insert bỏ
 *   qua `id` và lấy id qua `returning`.
 * - Hai truy vấn `selectDistinct` của bản Drizzle cũ dùng
 *   `SelectQueryBuilder#distinct` tương đương (đính chính C-1 của
 *   chiến dịch: `distinct` là họ API CÓ dùng, lớp A).
 * - `count(*)` ép `::int` tường minh để giữ kiểu `number` của hợp
 *   đồng cũ (T-7: `count(*)` là int8, qua pg sẽ là `string` nếu
 *   không ép).
 *
 * Bề mặt kiểu dòng giữ đúng hình dạng `$inferSelect` của
 * repository cũ để phía tiêu thụ trong module classes không đổi
 * hợp đồng.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type ClassesDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm. */
export type ClassesTx = CentreTx;

/** Nhóm "cả lớp" tự sinh trong mọi khoá thuộc lớp — đích giao mặc định cho hoạt động nhắm cả lớp (issue #184, mục 4.2 của hồ sơ). */
export const CLASS_WHOLE_GROUP_NAME = 'Cả lớp';

/** Component đánh dấu backing cohort do module classes quản (không hiện ở bề mặt quản cohort thủ công). */
export const CLASS_COHORT_COMPONENT = 'class';

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `classes`. */
export interface ClassRow {
  id: string;
  tenantId: string;
  name: string;
  code: string | null;
  schoolYear: string | null;
  ownerId: string;
  cohortId: string;
  allowSelfReport: boolean;
  joinCode: string | null;
  joinAutoApprove: boolean;
  onLeave: string;
  status: string;
  description: string;
  feeCost: number | null;
  feeCurrency: string;
  feePaymentAccountId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `cohort` (chỉ đọc tại đây — ghi cohort thuộc repository groups và repository chuyển tiếp của giao dịch tạo lớp). */
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

/** Dòng `class_join_requests`. */
export interface ClassJoinRequestRow {
  id: string;
  tenantId: string;
  classId: string;
  userId: string;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Kiểu ghi vào (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `class_join_requests`. */
export interface NewClassJoinRequest {
  id?: string;
  tenantId: string;
  classId: string;
  userId: string;
  status?: string;
  decidedBy?: string | null;
  decidedAt?: Date | null;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning)
// ---------------------------------------------------------------------------

const CLASS_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'name',
  'code',
  'school_year as schoolYear',
  'owner_id as ownerId',
  'cohort_id as cohortId',
  'allow_self_report as allowSelfReport',
  'join_code as joinCode',
  'join_auto_approve as joinAutoApprove',
  'on_leave as onLeave',
  'status',
  'description',
  'fee_cost as feeCost',
  'fee_currency as feeCurrency',
  'fee_payment_account_id as feePaymentAccountId',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const JOIN_REQUEST_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'class_id as classId',
  'user_id as userId',
  'status',
  'decided_by as decidedBy',
  'decided_at as decidedAt',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const CLASS_COURSE_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'category',
  'class_id as classId',
  'full_name as fullName',
  'short_name as shortName',
  'id_number as idNumber',
  'summary',
  'format',
  'visible',
  'start_date as startDate',
  'end_date as endDate',
  'group_mode as groupMode',
  'group_mode_force as groupModeForce',
  'sort_order as sortOrder',
  'subject_id as subjectId',
  'grade',
  'is_template as isTemplate',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function classUpdateValues(v: Partial<ClassRow>) {
  return {
    ...(v.tenantId !== undefined ? { tenant_id: v.tenantId } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.code !== undefined ? { code: v.code } : {}),
    ...(v.schoolYear !== undefined ? { school_year: v.schoolYear } : {}),
    ...(v.ownerId !== undefined ? { owner_id: v.ownerId } : {}),
    ...(v.cohortId !== undefined ? { cohort_id: v.cohortId } : {}),
    ...(v.allowSelfReport !== undefined ? { allow_self_report: v.allowSelfReport } : {}),
    ...(v.joinCode !== undefined ? { join_code: v.joinCode } : {}),
    ...(v.joinAutoApprove !== undefined ? { join_auto_approve: v.joinAutoApprove } : {}),
    ...(v.onLeave !== undefined ? { on_leave: v.onLeave } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.description !== undefined ? { description: v.description } : {}),
    ...(v.feeCost !== undefined ? { fee_cost: v.feeCost } : {}),
    ...(v.feeCurrency !== undefined ? { fee_currency: v.feeCurrency } : {}),
    ...(v.feePaymentAccountId !== undefined ? { fee_payment_account_id: v.feePaymentAccountId } : {}),
  };
}

function joinRequestInsertValues(v: NewClassJoinRequest) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    tenant_id: v.tenantId,
    class_id: v.classId,
    user_id: v.userId,
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.decidedBy !== undefined ? { decided_by: v.decidedBy } : {}),
    ...(v.decidedAt !== undefined ? { decided_at: v.decidedAt } : {}),
  };
}

function joinRequestUpdateValues(v: Partial<ClassJoinRequestRow>) {
  return {
    ...(v.tenantId !== undefined ? { tenant_id: v.tenantId } : {}),
    ...(v.classId !== undefined ? { class_id: v.classId } : {}),
    ...(v.userId !== undefined ? { user_id: v.userId } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.decidedBy !== undefined ? { decided_by: v.decidedBy } : {}),
    ...(v.decidedAt !== undefined ? { decided_at: v.decidedAt } : {}),
  };
}

/**
 * Kho dữ liệu lớp học: bảng `classes` + các truy vấn vật chất hoá
 * phía lớp (instance cohort của các khoá trong lớp). Thuần dữ
 * liệu — quyết định quyền nằm ở ClassesService / PermissionEvaluator.
 */
export class ClassesRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Mở một transaction trên kho trung tâm. */
  async transaction<T>(fn: (tx: ClassesTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  /** Lấy lớp theo id. */
  async getClass(id: string): Promise<ClassRow | undefined> {
    return this.handle
      .selectFrom('classes')
      .select(CLASS_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<ClassRow | undefined>;
  }

  /** Lấy lớp theo mã lớp trong một tenant. */
  async getClassByCode(tenantId: string, code: string): Promise<ClassRow | undefined> {
    return this.handle
      .selectFrom('classes')
      .select(CLASS_COLUMNS)
      .where('tenant_id', '=', tenantId)
      .where('code', '=', code)
      .executeTakeFirst() as Promise<ClassRow | undefined>;
  }

  /** Lấy lớp theo backing cohort. */
  async getClassByCohortId(cohortId: string): Promise<ClassRow | undefined> {
    return this.handle
      .selectFrom('classes')
      .select(CLASS_COLUMNS)
      .where('cohort_id', '=', cohortId)
      .executeTakeFirst() as Promise<ClassRow | undefined>;
  }

  /** Mọi lớp của một tenant, theo thời điểm tạo. */
  async listClassesByTenant(tenantId: string): Promise<ClassRow[]> {
    return this.handle
      .selectFrom('classes')
      .select(CLASS_COLUMNS)
      .where('tenant_id', '=', tenantId)
      .orderBy('created_at', 'asc')
      .execute() as Promise<ClassRow[]>;
  }

  /** Cập nhật lớp. */
  async updateClass(id: string, patch: Partial<ClassRow>): Promise<void> {
    await this.handle
      .updateTable('classes')
      .set({ ...classUpdateValues(patch), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá lớp. */
  async deleteClass(id: string): Promise<void> {
    await this.handle.deleteFrom('classes').where('id', '=', id).execute();
  }

  /** Xoá backing cohort của lớp (bảng `cohort` do module groups sở hữu — xoá qua đây như repository cũ). */
  async deleteCohort(cohortId: string): Promise<void> {
    await this.handle.deleteFrom('cohort').where('id', '=', cohortId).execute();
  }

  /** Số khoá đang thuộc lớp — chốt chặn xoá lớp (FK RESTRICT ở DB là lưới cuối). */
  async countCoursesInClass(classId: string): Promise<number> {
    const row = await this.handle
      .selectFrom('course')
      .select(sql<number>`count(*)::int`.as('value'))
      .where('class_id', '=', classId)
      .executeTakeFirst();
    return row?.value ?? 0;
  }

  /** Mọi khoá thuộc lớp (gồm cả khoá ẩn — bề mặt lớp là bề mặt quản trị của staff lớp). */
  async listCoursesInClass(classId: string): Promise<CourseRow[]> {
    return this.handle
      .selectFrom('course')
      .select(CLASS_COURSE_COLUMNS)
      .where('class_id', '=', classId)
      .orderBy('sort_order', 'asc')
      .execute() as Promise<CourseRow[]>;
  }

  /**
   * Các khoá của lớp mà một học sinh đang ghi danh ACTIVE (status = 0 —
   * `ENROL_ACTIVE` của module enrol; xét mọi instance của khoá, đường
   * chính là instance cohort của lớp). Đình chỉ ở một khoá đặt dòng ghi
   * danh thành SUSPENDED (status = 1) nên khoá đó rơi khỏi tập này —
   * dashboard phía học sinh (CLASS-2) chỉ hiện các khoá trong tập này.
   */
  async listActiveEnrolledCourseIds(classId: string, userId: string): Promise<string[]> {
    const rows = await this.handle
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .innerJoin('course', 'course.id', 'enrol.course_id')
      .select('enrol.course_id as courseId')
      .distinct()
      .where('course.class_id', '=', classId)
      .where('user_enrolments.user_id', '=', userId)
      .where('user_enrolments.status', '=', 0)
      .execute();
    return rows.map((r) => r.courseId);
  }

  /**
   * Đẩy chế độ rời lớp mới xuống `custom_text1` của mọi instance cohort
   * của lớp (các khoá đã tạo trước khi lớp đổi `on_leave` phải theo chế
   * độ hiện hành của lớp, không giữ ảnh chụp lúc tạo khoá).
   */
  async syncOnLeaveToInstances(cohortId: string, onLeave: string): Promise<void> {
    await this.handle
      .updateTable('enrol')
      .set({ custom_text1: onLeave, updated_at: new Date() })
      .where('enrol', '=', 'cohort')
      .where('custom_int1', '=', cohortId)
      .execute();
  }

  // --- tự báo danh (CLASS-1) ---------------------------------------------------

  /** Lớp theo mã tham gia: `join_code` là unique toàn hệ khi có đặt, nên tra cứu không cần tenant. */
  async getClassByJoinCode(joinCode: string): Promise<ClassRow | undefined> {
    return this.handle
      .selectFrom('classes')
      .select(CLASS_COLUMNS)
      .where('join_code', '=', joinCode)
      .executeTakeFirst() as Promise<ClassRow | undefined>;
  }

  /** Chèn một yêu cầu tham gia lớp. */
  async insertJoinRequest(v: NewClassJoinRequest): Promise<ClassJoinRequestRow> {
    return this.handle
      .insertInto('class_join_requests')
      .values(joinRequestInsertValues(v))
      .returning(JOIN_REQUEST_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<ClassJoinRequestRow>;
  }

  /** Lấy yêu cầu tham gia theo id. */
  async getJoinRequest(id: string): Promise<ClassJoinRequestRow | undefined> {
    return this.handle
      .selectFrom('class_join_requests')
      .select(JOIN_REQUEST_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<ClassJoinRequestRow | undefined>;
  }

  /** Yêu cầu đang chờ của một học sinh cho một lớp (unique từng phần ở DB là lưới cuối). */
  async findPendingJoinRequest(classId: string, userId: string): Promise<ClassJoinRequestRow | undefined> {
    return this.handle
      .selectFrom('class_join_requests')
      .select(JOIN_REQUEST_COLUMNS)
      .where('class_id', '=', classId)
      .where('user_id', '=', userId)
      .where('status', '=', 'pending')
      .executeTakeFirst() as Promise<ClassJoinRequestRow | undefined>;
  }

  /** Các yêu cầu tham gia của một lớp theo trạng thái, theo thời điểm tạo. */
  async listJoinRequests(classId: string, status: string): Promise<ClassJoinRequestRow[]> {
    return this.handle
      .selectFrom('class_join_requests')
      .select(JOIN_REQUEST_COLUMNS)
      .where('class_id', '=', classId)
      .where('status', '=', status)
      .orderBy('created_at', 'asc')
      .execute() as Promise<ClassJoinRequestRow[]>;
  }

  /** Cập nhật yêu cầu tham gia. */
  async updateJoinRequest(id: string, patch: Partial<ClassJoinRequestRow>): Promise<void> {
    await this.handle
      .updateTable('class_join_requests')
      .set({ ...joinRequestUpdateValues(patch), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /**
   * Học sinh đã đình chỉ khỏi lớp: còn dòng ghi danh SUSPENDED (status
   * = 1) trên instance cohort của lớp nhưng KHÔNG còn trong backing
   * cohort — suy ra từ chính vật chất hoá ghi danh, không bảng phụ
   * (roster chỉ có hai trạng thái thuộc/không thuộc, xem hồ sơ mục 4.3).
   */
  async listSuspendedMemberIds(cohortId: string): Promise<string[]> {
    const rows = await this.handle
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .select('user_enrolments.user_id as userId')
      .distinct()
      .where('enrol.enrol', '=', 'cohort')
      .where('enrol.custom_int1', '=', cohortId)
      .where('user_enrolments.status', '=', 1)
      .execute();
    return rows.map((r) => r.userId);
  }
}
