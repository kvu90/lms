import type { CentreDb, CentreTx } from '../client';

/**
 * Kho dữ liệu ghi danh trên Kysely (issue #645, nhóm G5 của chiến
 * dịch chuyển tầng dữ liệu sang Kysely): TOÀN BỘ bề mặt của
 * `EnrolRepository` cũ ở `apps/api` (Drizzle) được chuyển nguyên
 * vẹn sang đây — enrol instance (phương thức ghi danh của khoá
 * học) và user enrolment (ghi danh của từng user).
 *
 * Hai bảng này DÙNG CHUNG với package `@lms/enrol` (bề mặt vật
 * chất hoá cohort) — thứ tự chuyển đổi G5 trước, D5 (#657) sau
 * giữ nguyên như kế hoạch; repository này không đổi hình dạng
 * bảng hay ngữ nghĩa ghi nào của bề mặt đó.
 *
 * Khuôn truy vấn theo đúng pilot kho control plane (issue #640):
 * - Cột đọc khai tường minh kèm bí danh camelCase dùng chung cho
 *   select và returning — KHÔNG bật CamelCasePlugin.
 * - Ghi qua hàm ánh xạ Insert/Update loại `undefined` tường minh
 *   từng trường (thử nghiệm T-4).
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U): insert bỏ
 *   qua `id` và lấy id qua `returning`.
 * - Điểm mở giao dịch của repository là `transaction(fn)`; các
 *   phương thức nhận handle tuỳ chọn (`EnrolDb` = handle thường
 *   hoặc handle giao dịch) để phía gọi lồng thao tác vào giao
 *   dịch của mình (luồng hết hạn ghi danh, đường tự mở giao dịch
 *   của `setSuspended`).
 *
 * Hai ca lọc tại bộ nhớ của repository cũ (`listCohortInstances`,
 * `listExpiredActive`) giữ nguyên cách làm: chúng là một phần của
 * hợp đồng hành vi đã chốt, không đổi sang lọc tại SQL.
 *
 * Bề mặt kiểu dòng giữ đúng hình dạng `$inferSelect` của
 * repository cũ để phía tiêu thụ trong module enrol không đổi
 * hợp đồng.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type EnrolDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm. */
export type EnrolTx = CentreTx;

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `enrol` (instance ghi danh của một khoá học). */
export interface EnrolRow {
  id: string;
  courseId: string;
  enrol: string;
  name: string | null;
  roleId: string | null;
  status: number;
  enrolPeriod: number;
  timeStart: Date | null;
  timeEnd: Date | null;
  enrolmentKey: string | null;
  customInt1: string | null;
  customInt2: string | null;
  customText1: string;
  cost: number;
  currency: string;
  paymentAccountId: string | null;
  sendWelcomeMessage: boolean;
  welcomeMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `user_enrolments` (ghi danh của một user qua một instance). */
export interface UserEnrolmentRow {
  id: string;
  enrolId: string;
  userId: string;
  status: number;
  timeStart: Date;
  timeEnd: Date | null;
  modifierId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Kiểu ghi vào (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `enrol`. */
export interface NewEnrolInstance {
  id?: string;
  courseId: string;
  enrol: string;
  name?: string | null;
  roleId?: string | null;
  status?: number;
  enrolPeriod?: number;
  timeStart?: Date | null;
  timeEnd?: Date | null;
  enrolmentKey?: string | null;
  customInt1?: string | null;
  customInt2?: string | null;
  customText1?: string;
  cost?: number;
  currency?: string;
  paymentAccountId?: string | null;
  sendWelcomeMessage?: boolean;
  welcomeMessage?: string | null;
}

/** Giá trị chèn `user_enrolments`. */
export interface NewUserEnrolment {
  id?: string;
  enrolId: string;
  userId: string;
  status?: number;
  timeStart?: Date;
  timeEnd?: Date | null;
  modifierId?: string | null;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning)
// ---------------------------------------------------------------------------

const ENROL_COLUMNS = [
  'id',
  'course_id as courseId',
  'enrol',
  'name',
  'role_id as roleId',
  'status',
  'enrol_period as enrolPeriod',
  'time_start as timeStart',
  'time_end as timeEnd',
  'enrolment_key as enrolmentKey',
  'custom_int1 as customInt1',
  'custom_int2 as customInt2',
  'custom_text1 as customText1',
  'cost',
  'currency',
  'payment_account_id as paymentAccountId',
  'send_welcome_message as sendWelcomeMessage',
  'welcome_message as welcomeMessage',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

const USER_ENROLMENT_COLUMNS = [
  'id',
  'enrol_id as enrolId',
  'user_id as userId',
  'status',
  'time_start as timeStart',
  'time_end as timeEnd',
  'modifier_id as modifierId',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function enrolInsertValues(v: NewEnrolInstance) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    course_id: v.courseId,
    enrol: v.enrol,
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.roleId !== undefined ? { role_id: v.roleId } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.enrolPeriod !== undefined ? { enrol_period: v.enrolPeriod } : {}),
    ...(v.timeStart !== undefined ? { time_start: v.timeStart } : {}),
    ...(v.timeEnd !== undefined ? { time_end: v.timeEnd } : {}),
    ...(v.enrolmentKey !== undefined ? { enrolment_key: v.enrolmentKey } : {}),
    ...(v.customInt1 !== undefined ? { custom_int1: v.customInt1 } : {}),
    ...(v.customInt2 !== undefined ? { custom_int2: v.customInt2 } : {}),
    ...(v.customText1 !== undefined ? { custom_text1: v.customText1 } : {}),
    ...(v.cost !== undefined ? { cost: v.cost } : {}),
    ...(v.currency !== undefined ? { currency: v.currency } : {}),
    ...(v.paymentAccountId !== undefined ? { payment_account_id: v.paymentAccountId } : {}),
    ...(v.sendWelcomeMessage !== undefined ? { send_welcome_message: v.sendWelcomeMessage } : {}),
    ...(v.welcomeMessage !== undefined ? { welcome_message: v.welcomeMessage } : {}),
  };
}

function enrolUpdateValues(v: Partial<NewEnrolInstance>) {
  return {
    ...(v.courseId !== undefined ? { course_id: v.courseId } : {}),
    ...(v.enrol !== undefined ? { enrol: v.enrol } : {}),
    ...(v.name !== undefined ? { name: v.name } : {}),
    ...(v.roleId !== undefined ? { role_id: v.roleId } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.enrolPeriod !== undefined ? { enrol_period: v.enrolPeriod } : {}),
    ...(v.timeStart !== undefined ? { time_start: v.timeStart } : {}),
    ...(v.timeEnd !== undefined ? { time_end: v.timeEnd } : {}),
    ...(v.enrolmentKey !== undefined ? { enrolment_key: v.enrolmentKey } : {}),
    ...(v.customInt1 !== undefined ? { custom_int1: v.customInt1 } : {}),
    ...(v.customInt2 !== undefined ? { custom_int2: v.customInt2 } : {}),
    ...(v.customText1 !== undefined ? { custom_text1: v.customText1 } : {}),
    ...(v.cost !== undefined ? { cost: v.cost } : {}),
    ...(v.currency !== undefined ? { currency: v.currency } : {}),
    ...(v.paymentAccountId !== undefined ? { payment_account_id: v.paymentAccountId } : {}),
    ...(v.sendWelcomeMessage !== undefined ? { send_welcome_message: v.sendWelcomeMessage } : {}),
    ...(v.welcomeMessage !== undefined ? { welcome_message: v.welcomeMessage } : {}),
  };
}

function userEnrolmentInsertValues(v: NewUserEnrolment) {
  return {
    ...(v.id !== undefined ? { id: v.id } : {}),
    enrol_id: v.enrolId,
    user_id: v.userId,
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.timeStart !== undefined ? { time_start: v.timeStart } : {}),
    ...(v.timeEnd !== undefined ? { time_end: v.timeEnd } : {}),
    ...(v.modifierId !== undefined ? { modifier_id: v.modifierId } : {}),
  };
}

function userEnrolmentUpdateValues(v: Partial<NewUserEnrolment>) {
  return {
    ...(v.enrolId !== undefined ? { enrol_id: v.enrolId } : {}),
    ...(v.userId !== undefined ? { user_id: v.userId } : {}),
    ...(v.status !== undefined ? { status: v.status } : {}),
    ...(v.timeStart !== undefined ? { time_start: v.timeStart } : {}),
    ...(v.timeEnd !== undefined ? { time_end: v.timeEnd } : {}),
    ...(v.modifierId !== undefined ? { modifier_id: v.modifierId } : {}),
  };
}

/**
 * Kho dữ liệu ghi danh: enrol instance (phương thức ghi danh của
 * khoá học) và user enrolment (ghi danh của từng user).
 */
export class EnrolRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Mở một transaction trên kho trung tâm. */
  async transaction<T>(fn: (tx: EnrolTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  /** Chèn enrol instance. */
  async insertInstance(v: NewEnrolInstance, db: EnrolDb = this.handle): Promise<EnrolRow> {
    return db
      .insertInto('enrol')
      .values(enrolInsertValues(v))
      .returning(ENROL_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<EnrolRow>;
  }

  /** Lấy instance theo id. */
  async getInstance(id: string): Promise<EnrolRow | undefined> {
    return this.handle
      .selectFrom('enrol')
      .select(ENROL_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<EnrolRow | undefined>;
  }

  /** Instance của một khoá học. */
  async listInstances(courseId: string): Promise<EnrolRow[]> {
    return this.handle
      .selectFrom('enrol')
      .select(ENROL_COLUMNS)
      .where('course_id', '=', courseId)
      .orderBy('id', 'asc')
      .execute() as Promise<EnrolRow[]>;
  }

  /** Instance theo phương thức (manual, self, cohort, paypal…). */
  async listInstancesByMethod(method: string): Promise<EnrolRow[]> {
    return this.handle
      .selectFrom('enrol')
      .select(ENROL_COLUMNS)
      .where('enrol', '=', method)
      .orderBy('id', 'asc')
      .execute() as Promise<EnrolRow[]>;
  }

  /** Các instance đồng bộ cohort đang trỏ tới một cohort. */
  async listCohortInstances(cohortId: string): Promise<EnrolRow[]> {
    const rows = (await this.handle
      .selectFrom('enrol')
      .select(ENROL_COLUMNS)
      .where('enrol', '=', 'cohort')
      .execute()) as EnrolRow[];
    return rows.filter((r) => r.customInt1 === cohortId);
  }

  /** Cập nhật instance. */
  async updateInstance(id: string, v: Partial<NewEnrolInstance>): Promise<void> {
    await this.handle
      .updateTable('enrol')
      .set({ ...enrolUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá instance. */
  async deleteInstance(id: string): Promise<void> {
    await this.handle.deleteFrom('enrol').where('id', '=', id).execute();
  }

  /** Chèn ghi danh của user. */
  async insertUserEnrolment(v: NewUserEnrolment, db: EnrolDb = this.handle): Promise<UserEnrolmentRow> {
    return db
      .insertInto('user_enrolments')
      .values(userEnrolmentInsertValues(v))
      .returning(USER_ENROLMENT_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<UserEnrolmentRow>;
  }

  /** Lấy ghi danh theo (instance, user). */
  async getUserEnrolment(enrolId: string, userId: string): Promise<UserEnrolmentRow | undefined> {
    return this.handle
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('enrol_id', '=', enrolId)
      .where('user_id', '=', userId)
      .executeTakeFirst() as Promise<UserEnrolmentRow | undefined>;
  }

  /** Cập nhật ghi danh (trạng thái, thời hạn). */
  async updateUserEnrolment(id: string, v: Partial<NewUserEnrolment>, db: EnrolDb = this.handle): Promise<void> {
    await db
      .updateTable('user_enrolments')
      .set({ ...userEnrolmentUpdateValues(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Xoá ghi danh. */
  async deleteUserEnrolment(id: string): Promise<void> {
    await this.handle.deleteFrom('user_enrolments').where('id', '=', id).execute();
  }

  /** Mọi ghi danh trong khoá học, kèm phương thức của instance sở hữu. */
  async listUserEnrolmentsForCourse(courseId: string): Promise<(UserEnrolmentRow & { enrolMethod: string })[]> {
    const instances = await this.listInstances(courseId);
    if (!instances.length) return [];
    const rows = (await this.handle
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('enrol_id', 'in', instances.map((i) => i.id))
      .execute()) as UserEnrolmentRow[];
    const methodById = new Map(instances.map((i) => [i.id, i.enrol]));
    return rows.map((r) => ({ ...r, enrolMethod: methodById.get(r.enrolId) ?? '' }));
  }

  /** Mọi ghi danh của một user. */
  async listUserEnrolmentsForUser(userId: string): Promise<UserEnrolmentRow[]> {
    return this.handle
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('user_id', '=', userId)
      .execute() as Promise<UserEnrolmentRow[]>;
  }

  /** Mọi ghi danh qua một instance — đầu vào của việc gán lại role khi instance đổi role. */
  async listUserEnrolmentsForInstance(enrolId: string): Promise<UserEnrolmentRow[]> {
    return this.handle
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('enrol_id', '=', enrolId)
      .execute() as Promise<UserEnrolmentRow[]>;
  }

  /** Các ghi danh đang hiệu lực nhưng đã quá hạn — đầu vào của tiến trình hết hạn. */
  async listExpiredActive(now: Date): Promise<UserEnrolmentRow[]> {
    const rows = (await this.handle
      .selectFrom('user_enrolments')
      .select(USER_ENROLMENT_COLUMNS)
      .where('status', '=', 0)
      .execute()) as UserEnrolmentRow[];
    return rows.filter((r) => r.timeEnd !== null && r.timeEnd < now);
  }
}
