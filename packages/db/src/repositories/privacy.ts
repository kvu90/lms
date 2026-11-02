/**
 * Repository của cụm PRIVACY trên Kysely — chuyển đổi Drizzle →
 * Kysely thuộc nhóm G8 của chiến dịch chuyển tầng dữ liệu (issue
 * #648).
 *
 * Vai trò: mọi truy cập tới hai bảng privacy_requests và
 * privacy_export_files của kho trung tâm tập trung ở đây. Việc
 * xuất/xoá dữ liệu cá nhân theo từng subsystem nằm ở các provider
 * của tầng service phía ứng dụng, chạy trên chính handle mà
 * repository này phơi ra qua `dbHandle`. Repository không chứa
 * luật nghiệp vụ — phê duyệt, cổng sở hữu và xử lý yêu cầu nằm ở
 * service.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (theo khuôn pilot kho
 * control plane): bên trong dùng tên bảng/cột snake_case của
 * schema codegen; bên ngoài nhận/trả hình dạng camelCase qua danh
 * sách cột có bí danh tường minh và các hàm ánh xạ
 * `*InsertValues`/`*UpdateSet` loại `undefined` từng trường (luật
 * T-4). Các cột jsonb (`result`, `manifest`) khi ghi đi qua
 * `jsonbValue` (serialize tường minh + `::jsonb`).
 */
import { sql, type InsertObject, type RawBuilder, type UpdateObject } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';
import type { JsonValue } from '../types/centre-db';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
export type PrivacyDb = CentreDb | CentreTx;

/** Một dòng yêu cầu quyền riêng tư (xuất hoặc xoá dữ liệu của một chủ thể). */
export interface PrivacyRequestRow {
  id: string;
  userId: string;
  type: string;
  status: string;
  requestedBy: string;
  approvedBy: string | null;
  /** Kết quả xử lý của yêu cầu (jsonb). */
  result: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Một dòng tệp xuất dữ liệu gắn với một yêu cầu. */
export interface ExportFileRow {
  id: string;
  requestId: string;
  fileId: string | null;
  subsystem: string;
  /** Manifest của tệp xuất (jsonb). */
  manifest: unknown | null;
  createdAt: Date;
}

/** Dữ kiện ghi một yêu cầu mới. */
export interface NewPrivacyRequest {
  id?: string;
  userId: string;
  type: string;
  status?: string;
  requestedBy: string;
  approvedBy?: string | null;
  result?: unknown | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Dữ kiện ghi một tệp xuất mới. */
export interface NewExportFile {
  id?: string;
  requestId: string;
  fileId?: string | null;
  subsystem?: string;
  manifest?: unknown | null;
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

/** Danh sách cột tường minh có bí danh camelCase cho bảng privacy_requests. */
const PRIVACY_REQUEST_COLUMNS = [
  'id',
  'user_id as userId',
  'type',
  'status',
  'requested_by as requestedBy',
  'approved_by as approvedBy',
  'result',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột tường minh có bí danh camelCase cho bảng privacy_export_files. */
const PRIVACY_EXPORT_FILE_COLUMNS = [
  'id',
  'request_id as requestId',
  'file_id as fileId',
  'subsystem',
  'manifest',
  'created_at as createdAt',
] as const;

/** Ánh xạ dữ kiện ghi yêu cầu từ camelCase sang snake_case, loại `undefined` từng trường. */
function privacyRequestInsertValues(values: NewPrivacyRequest): InsertObject<CentreDB, 'privacy_requests'> {
  const row: InsertObject<CentreDB, 'privacy_requests'> = {
    user_id: values.userId,
    type: values.type,
    requested_by: values.requestedBy,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.status !== undefined) row.status = values.status;
  if (values.approvedBy !== undefined) row.approved_by = values.approvedBy;
  if (values.result !== undefined) row.result = jsonbValue(values.result);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/** Ánh xạ bản vá yêu cầu từ camelCase sang snake_case, loại `undefined` từng trường. */
function privacyRequestUpdateSet(patch: Partial<NewPrivacyRequest>): UpdateObject<CentreDB, 'privacy_requests'> {
  const set: UpdateObject<CentreDB, 'privacy_requests'> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.userId !== undefined) set.user_id = patch.userId;
  if (patch.type !== undefined) set.type = patch.type;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.requestedBy !== undefined) set.requested_by = patch.requestedBy;
  if (patch.approvedBy !== undefined) set.approved_by = patch.approvedBy;
  if (patch.result !== undefined) set.result = jsonbValue(patch.result);
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt;
  return set;
}

/** Ánh xạ dữ kiện ghi tệp xuất từ camelCase sang snake_case, loại `undefined` từng trường. */
function exportFileInsertValues(values: NewExportFile): InsertObject<CentreDB, 'privacy_export_files'> {
  const row: InsertObject<CentreDB, 'privacy_export_files'> = {
    request_id: values.requestId,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.fileId !== undefined) row.file_id = values.fileId;
  if (values.subsystem !== undefined) row.subsystem = values.subsystem;
  if (values.manifest !== undefined) row.manifest = jsonbValue(values.manifest);
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  return row;
}

/** Kho dữ liệu privacy_requests / privacy_export_files. */
export class PrivacyRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Handle Kysely của kho trung tâm mà repository đang giữ (tầng service dùng cho các provider xuất/xoá dữ liệu theo subsystem). */
  get dbHandle(): CentreDb {
    return this.handle;
  }

  /** Ghi một yêu cầu mới, trả dòng vừa ghi. */
  async insertRequest(v: NewPrivacyRequest, db: PrivacyDb = this.handle): Promise<PrivacyRequestRow> {
    const rows = await db
      .insertInto('privacy_requests')
      .values(privacyRequestInsertValues(v))
      .returning(PRIVACY_REQUEST_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy yêu cầu theo id. */
  async getRequest(id: string, db: PrivacyDb = this.handle): Promise<PrivacyRequestRow | undefined> {
    return db
      .selectFrom('privacy_requests')
      .select(PRIVACY_REQUEST_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst();
  }

  /** Liệt kê mọi yêu cầu. */
  async listRequests(db: PrivacyDb = this.handle): Promise<PrivacyRequestRow[]> {
    return db.selectFrom('privacy_requests').select(PRIVACY_REQUEST_COLUMNS).execute();
  }

  /** Liệt kê yêu cầu của một chủ thể. */
  async listRequestsForUser(userId: string, db: PrivacyDb = this.handle): Promise<PrivacyRequestRow[]> {
    return db
      .selectFrom('privacy_requests')
      .select(PRIVACY_REQUEST_COLUMNS)
      .where('user_id', '=', userId)
      .execute();
  }

  /** Cập nhật một yêu cầu theo bản vá từng phần; updatedAt luôn được làm mới tại thời điểm cập nhật. */
  async updateRequest(id: string, v: Partial<NewPrivacyRequest>, db: PrivacyDb = this.handle): Promise<void> {
    await db
      .updateTable('privacy_requests')
      .set({ ...privacyRequestUpdateSet(v), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }

  /** Ghi một tệp xuất mới, trả dòng vừa ghi. */
  async insertExportFile(v: NewExportFile, db: PrivacyDb = this.handle): Promise<ExportFileRow> {
    const rows = await db
      .insertInto('privacy_export_files')
      .values(exportFileInsertValues(v))
      .returning(PRIVACY_EXPORT_FILE_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Liệt kê các tệp xuất của một yêu cầu. */
  async listExportFiles(requestId: string, db: PrivacyDb = this.handle): Promise<ExportFileRow[]> {
    return db
      .selectFrom('privacy_export_files')
      .select(PRIVACY_EXPORT_FILE_COLUMNS)
      .where('request_id', '=', requestId)
      .execute();
  }
}
