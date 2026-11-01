/**
 * Repository của cụm REPORT BUILDER trên Kysely — chuyển đổi
 * Drizzle → Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ
 * liệu (issue #648).
 *
 * Vai trò: mọi truy cập tới ba bảng report_builder_report,
 * report_builder_audience và report_builder_schedule của kho
 * trung tâm tập trung ở đây, cộng truy vấn kiểm tra audience theo
 * vai trò trên hai bảng role_assignments/role (bảng của module
 * access — repository này chỉ ĐỌC chúng cho đúng một truy vấn
 * nghiệp vụ của reports, không sở hữu chúng). Repository không
 * chứa luật nghiệp vụ — gác quyền, lọc từng dòng và chạy lịch nằm
 * ở tầng service phía ứng dụng.
 *
 * Điểm nóng T-11 (thử nghiệm ghép mảnh động bằng `sql.join`, chốt
 * tại chính issue này): `userHasAnyRole` ghép danh sách tên vai
 * trò thành mệnh đề `IN (...)`. Khuôn đã đo trên cụm PostgreSQL
 * thật với Kysely 0.29.7 (spec đi kèm file này):
 * - Mỗi tên vai trò là một mảnh `sql` mang đúng một tham số vô
 *   hướng; `sql.join` chèn dấu tách `, ` giữa các mảnh và giữ thứ
 *   tự tham số: tham số của mệnh đề ngoài (userId) đứng trước, rồi
 *   tới tham số của từng mảnh theo thứ tự mảng.
 * - Mảnh chứa biểu thức con có tham số riêng vẫn giữ đúng thứ tự
 *   tham số toàn cục (tham số của biểu thức con nằm tại vị trí của
 *   mảnh trong danh sách).
 * - Danh sách RỖNG: `IN ()` không phải SQL hợp lệ nên khuôn KHÔNG
 *   phát truy vấn — hàm trả `false` ngay (không có vai trò nào thì
 *   không thuộc audience theo vai trò). Tầng gọi hiện hành vốn đã
 *   chặn rỗng; khuôn chốt thêm chốt chặn này trong chính hàm để
 *   mọi phía gọi sau (nhóm messaging) dùng lại an toàn.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo khuôn pilot kho
 * control plane): bên trong dùng tên bảng/cột snake_case của
 * schema codegen; bên ngoài nhận/trả hình dạng camelCase qua danh
 * sách cột có bí danh tường minh và các hàm ánh xạ
 * `*InsertValues`/`*UpdateSet` loại `undefined` từng trường (luật
 * T-4). Cột jsonb (`columns`, `filters`, `last_result`) khi ghi đi
 * qua `jsonbValue` (serialize tường minh + `::jsonb`) vì một MẢNG
 * ở cấp cao nhất bị driver `pg` hiểu là mảng PostgreSQL.
 */
import { sql, type Insertable, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type ReportsDb = CentreDb | CentreTx;

/** Một dòng định nghĩa báo cáo (columns/filters là jsonb do người tạo cấu hình). */
export interface ReportRow {
  id: string;
  name: string;
  dataSource: string;
  /** Danh sách cột đã chọn của báo cáo (jsonb). */
  columns: unknown;
  /** Bộ lọc cấu hình của báo cáo (jsonb). */
  filters: unknown;
  createdBy: string;
  contextId: string | null;
  createdAt: Date;
}

/** Một dòng audience của báo cáo: hoặc một user cụ thể, hoặc một vai trò theo tên. */
export interface AudienceRow {
  id: string;
  reportId: string;
  userId: string | null;
  role: string | null;
}

/** Một dòng lịch chạy báo cáo. */
export interface ScheduleRow {
  id: string;
  reportId: string;
  createdBy: string;
  cron: string;
  enabled: boolean;
  lastRun: Date | null;
  /** Kết quả lượt chạy gần nhất (jsonb). */
  lastResult: unknown | null;
  createdAt: Date;
}

/** Dữ kiện ghi một định nghĩa báo cáo mới. */
export interface NewReport {
  id?: string;
  name: string;
  dataSource: string;
  columns?: unknown;
  filters?: unknown;
  createdBy: string;
  contextId?: string | null;
  createdAt?: Date;
}

/** Dữ kiện ghi một dòng audience mới. */
export interface NewAudience {
  id?: string;
  reportId: string;
  userId?: string | null;
  role?: string | null;
}

/** Dữ kiện ghi một lịch chạy mới. */
export interface NewSchedule {
  id?: string;
  reportId: string;
  createdBy: string;
  cron?: string;
  enabled?: boolean;
  lastRun?: Date | null;
  lastResult?: unknown | null;
  createdAt?: Date;
}

/**
 * Bọc một giá trị jsonb thành biểu thức tham số JSON tường minh
 * (serialize + `::jsonb`) — xem lý do ở phần đầu file.
 *
 * @param value - Giá trị nghiệp vụ sẽ nằm trong cột jsonb (hình
 *   dạng do phía gọi chịu trách nhiệm — các cột jsonb của cụm này
 *   không khai kiểu nghiệp vụ riêng ở schema).
 * @returns Biểu thức Kysely mang chuỗi JSON đã serialize.
 */
function jsonbValue(value: unknown): RawBuilder<JsonValue> {
  return sql<JsonValue>`${JSON.stringify(value)}::jsonb`;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng report_builder_report. */
const REPORT_COLUMNS = [
  'id',
  'name',
  'data_source as dataSource',
  'columns',
  'filters',
  'created_by as createdBy',
  'context_id as contextId',
  'created_at as createdAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng report_builder_audience. */
const AUDIENCE_COLUMNS = [
  'id',
  'report_id as reportId',
  'user_id as userId',
  'role',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng report_builder_schedule. */
const SCHEDULE_COLUMNS = [
  'id',
  'report_id as reportId',
  'created_by as createdBy',
  'cron',
  'enabled',
  'last_run as lastRun',
  'last_result as lastResult',
  'created_at as createdAt',
] as const;

/** Ánh xạ dữ kiện ghi báo cáo từ camelCase sang snake_case, loại `undefined` từng trường. */
function reportInsertValues(values: NewReport): InsertObject<CentreDB, 'report_builder_report'> {
  const row: InsertObject<CentreDB, 'report_builder_report'> = {
    name: values.name,
    data_source: values.dataSource,
    created_by: values.createdBy,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.columns !== undefined) row.columns = jsonbValue(values.columns);
  if (values.filters !== undefined) row.filters = jsonbValue(values.filters);
  if (values.contextId !== undefined) row.context_id = values.contextId;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ dữ kiện ghi audience từ camelCase sang snake_case, loại `undefined` từng trường. */
function audienceInsertValues(values: NewAudience): Insertable<CentreDB['report_builder_audience']> {
  const row: Insertable<CentreDB['report_builder_audience']> = {
    report_id: values.reportId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.userId !== undefined) row.user_id = values.userId;
  if (values.role !== undefined) row.role = values.role;
  return row;
}

/** Ánh xạ dữ kiện ghi lịch chạy từ camelCase sang snake_case, loại `undefined` từng trường. */
function scheduleInsertValues(values: NewSchedule): InsertObject<CentreDB, 'report_builder_schedule'> {
  const row: InsertObject<CentreDB, 'report_builder_schedule'> = {
    report_id: values.reportId,
    created_by: values.createdBy,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.cron !== undefined) row.cron = values.cron;
  if (values.enabled !== undefined) row.enabled = values.enabled;
  if (values.lastRun !== undefined) row.last_run = values.lastRun;
  if (values.lastResult !== undefined) row.last_result = jsonbValue(values.lastResult);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Ánh xạ bản vá lịch chạy từ camelCase sang snake_case, loại `undefined` từng trường. */
function scheduleUpdateSet(patch: Partial<NewSchedule>): UpdateObject<CentreDB, 'report_builder_schedule'> {
  const set: UpdateObject<CentreDB, 'report_builder_schedule'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.reportId !== undefined) set.report_id = patch.reportId;
  if (patch.createdBy !== undefined) set.created_by = patch.createdBy;
  if (patch.cron !== undefined) set.cron = patch.cron;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.lastRun !== undefined) set.last_run = patch.lastRun;
  if (patch.lastResult !== undefined) set.last_result = jsonbValue(patch.lastResult);
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/** Kho dữ liệu report_builder_*. */
export class ReportsRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle Kysely của kho trung tâm mà repository đang giữ (tầng service dùng cho các truy vấn đọc phụ trợ của module). */
  get dbHandle(): CentreDb {
    return this.handle;
  }

  /** Ghi một định nghĩa báo cáo mới, trả dòng vừa ghi. */
  async insertReport(v: NewReport, db: ReportsDb = this.handle): Promise<ReportRow> {
    const rows = await db
      .insertInto('report_builder_report')
      .values(reportInsertValues(v))
      .returning(REPORT_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy định nghĩa báo cáo theo id. */
  async getReport(id: string, db: ReportsDb = this.handle): Promise<ReportRow | undefined> {
    return db
      .selectFrom('report_builder_report')
      .select(REPORT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi định nghĩa báo cáo. */
  async listReports(db: ReportsDb = this.handle): Promise<ReportRow[]> {
    return db.selectFrom('report_builder_report').select(REPORT_COLUMNS).execute();
  }

  /** Ghi một dòng audience mới, trả dòng vừa ghi. */
  async insertAudience(v: NewAudience, db: ReportsDb = this.handle): Promise<AudienceRow> {
    const rows = await db
      .insertInto('report_builder_audience')
      .values(audienceInsertValues(v))
      .returning(AUDIENCE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Liệt kê audience của một báo cáo. */
  async listAudience(reportId: string, db: ReportsDb = this.handle): Promise<AudienceRow[]> {
    return db
      .selectFrom('report_builder_audience')
      .select(AUDIENCE_COLUMNS)
      .where('report_id', '=', reportId)
      .execute();
  }

  /** Ghi một lịch chạy mới, trả dòng vừa ghi. */
  async insertSchedule(v: NewSchedule, db: ReportsDb = this.handle): Promise<ScheduleRow> {
    const rows = await db
      .insertInto('report_builder_schedule')
      .values(scheduleInsertValues(v))
      .returning(SCHEDULE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy lịch chạy theo id. */
  async getSchedule(id: string, db: ReportsDb = this.handle): Promise<ScheduleRow | undefined> {
    return db
      .selectFrom('report_builder_schedule')
      .select(SCHEDULE_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi lịch chạy. */
  async listSchedules(db: ReportsDb = this.handle): Promise<ScheduleRow[]> {
    return db.selectFrom('report_builder_schedule').select(SCHEDULE_COLUMNS).execute();
  }

  /** Cập nhật một lịch chạy theo bản vá từng phần. */
  async updateSchedule(id: string, v: Partial<NewSchedule>, db: ReportsDb = this.handle): Promise<void> {
    await db
      .updateTable('report_builder_schedule')
      .set(scheduleUpdateSet(v))
      .where('id', '=', id)
      .execute();
  }

  /**
   * User có giữ BẤT KỲ vai trò nào trong danh sách tên hay không
   * (đối chiếu `role.short_name` qua bảng role_assignments) — điểm
   * nóng T-11, khuôn ghép mảnh xem ở phần đầu file. Danh sách rỗng
   * trả `false` ngay, không phát truy vấn.
   */
  async userHasAnyRole(userId: string, roleNames: string[], db: ReportsDb = this.handle): Promise<boolean> {
    if (!roleNames.length) return false;
    const fragments = roleNames.map((name) => sql`${name}`);
    const result = await sql<{ ok: number }>`
      select 1 as ok from role_assignments ra join role r on r.id = ra.role_id
      where ra.user_id = ${userId} and r.short_name in (${sql.join(fragments, sql`, `)}) limit 1`
      .execute(db);
    return result.rows.length > 0;
  }
}
