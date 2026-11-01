/**
 * Repository của cụm TỆP trên Kysely — hạng mục nhân rộng G7 của
 * chiến dịch chuyển tầng dữ liệu (issue #647), chuyển từ
 * repository Drizzle cũ ở
 * `apps/api/src/modules/files/files.repository.ts`.
 *
 * Vai trò: mọi truy cập tới bảng `files` của kho trung tâm (bản
 * ghi logic của tệp theo khuôn Moodle: mỗi bản ghi là một file tại
 * (context, component, fileArea, itemId, filePath, fileName), nội
 * dung vật lý được deduplicate theo `contentHash` và refcount suy
 * ra từ số bản ghi cùng hash) tập trung ở đây, kèm ba hình chiếu
 * đọc tối thiểu trên các bảng của module Bài tập
 * (`assign_submission_files`, `assign_submissions`,
 * `assign_grades`) phục vụ chốt khoá bài nộp của đường xoá tệp
 * dùng chung. Luật nghiệp vụ (kiểm quyền context, URL ký, dọn nội
 * dung vật lý khi refcount về 0) nằm ở tầng service phía ứng
 * dụng; repository chỉ thực thi truy cập dữ kiện.
 *
 * Khuôn hình dạng dữ liệu ở biên repository — cùng khuôn pilot kho
 * control plane (xem mục "Sổ tay chuyển đổi repository sang Kysely"
 * trong `AGENTS.md` của package): bên trong dùng tên cột
 * snake_case của interface schema codegen; bên ngoài trả/nhận hình
 * dạng camelCase qua danh sách cột tường minh có bí danh và hàm
 * ánh xạ ghi loại `undefined` từng trường (thử nghiệm T-4); mọi
 * giá trị where là tham số bắt buộc. Phép đếm refcount giữ nguyên
 * biểu thức `count(*)::int` của đường Drizzle cũ (hàm tổng hợp của
 * `sql` template — họ FunctionModule/`sql` trong tài liệu Kysely)
 * để kiểu runtime ở biên vẫn là `number`, không trôi thành chuỗi
 * int8. Repository không import từ `apps/*`, không đọc ALS/ngữ
 * cảnh ứng dụng, không tự mở pool, không đọc biến môi trường.
 *
 * Lưu ý giao dịch: không phía gọi nào của cụm này mở giao dịch
 * qua repository (kiểm kê ở thân PR của issue #647) — phương thức
 * `transaction` vẫn có mặt theo khuôn chung, và mọi phương thức
 * nhận handle tuỳ chọn làm tham số cuối như các repository đã
 * chuyển đổi khác.
 */
import { sql, type Insertable } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: transaction đang mở hoặc chính instance gốc. */
type RepoDb = CentreDb | CentreTx;

/** Một dòng bản ghi tệp logic (nội dung vật lý định địa chỉ theo `contentHash`). */
export interface FileRow {
  id: string;
  contentHash: string;
  contextId: string;
  component: string;
  fileArea: string;
  itemId: string | null;
  filePath: string;
  fileName: string;
  userId: string | null;
  fileSize: number;
  mimeType: string | null;
  status: number;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Dữ kiện ghi một bản ghi tệp mới. */
export interface NewFile {
  id?: string;
  contentHash: string;
  contextId: string;
  component: string;
  fileArea: string;
  itemId?: string | null;
  filePath?: string;
  fileName: string;
  userId?: string | null;
  fileSize: number;
  mimeType?: string | null;
  status?: number;
  source?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Hình chiếu tối thiểu của một bài nộp mà chốt xoá tệp cần: bài
 * nộp nào, của ai, đang ở trạng thái vòng đời nào và thuộc lần
 * nộp thứ mấy — đủ để đường xoá dùng chung áp đúng khoá bài nộp
 * của module Bài tập mà không phải nạp toàn bộ bản ghi bài nộp.
 */
export interface LinkedSubmissionRow {
  submissionId: string;
  assignmentId: string;
  userId: string;
  status: string;
  attemptNumber: number;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng tệp. */
const FILE_COLUMNS = [
  'id',
  'content_hash as contentHash',
  'context_id as contextId',
  'component',
  'file_area as fileArea',
  'item_id as itemId',
  'file_path as filePath',
  'file_name as fileName',
  'user_id as userId',
  'file_size as fileSize',
  'mime_type as mimeType',
  'status',
  'source',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Danh sách cột hình chiếu bài nộp cho chốt xoá tệp (dùng cho cả đường join lẫn đường đọc thẳng). */
const LINKED_SUBMISSION_COLUMNS = [
  'assign_submissions.id as submissionId',
  'assign_submissions.assignment_id as assignmentId',
  'assign_submissions.user_id as userId',
  'assign_submissions.status as status',
  'assign_submissions.attempt_number as attemptNumber',
] as const;

/** Ánh xạ dữ kiện ghi tệp (camelCase) sang values insert (snake_case), LOẠI mọi trường `undefined` (T-4). */
function fileInsertValues(values: NewFile): Insertable<CentreDB['files']> {
  const row: Insertable<CentreDB['files']> = {
    content_hash: values.contentHash,
    context_id: values.contextId,
    component: values.component,
    file_area: values.fileArea,
    file_name: values.fileName,
    file_size: values.fileSize,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.itemId !== undefined) row.item_id = values.itemId;
  if (values.filePath !== undefined) row.file_path = values.filePath;
  if (values.userId !== undefined) row.user_id = values.userId;
  if (values.mimeType !== undefined) row.mime_type = values.mimeType;
  if (values.status !== undefined) row.status = values.status;
  if (values.source !== undefined) row.source = values.source;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Repository metadata tệp trên Kysely: bản ghi tệp logic và các
 * hình chiếu chốt khoá bài nộp của kho trung tâm.
 */
export class FilesRepository {
  constructor(private readonly handle: CentreDb) {}

  /** Instance gốc của repository. */
  private db(): CentreDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm qua handle của repository. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /** Chèn bản ghi tệp mới. */
  async insert(values: NewFile, db: RepoDb = this.db()): Promise<FileRow> {
    const rows = await db.insertInto('files').values(fileInsertValues(values)).returning(FILE_COLUMNS).execute();
    return rows[0]!;
  }

  /** Lấy bản ghi theo id. */
  async getById(id: string, db: RepoDb = this.db()): Promise<FileRow | undefined> {
    return db.selectFrom('files').select(FILE_COLUMNS).where('id', '=', id).limit(1).executeTakeFirst();
  }

  /** Xoá bản ghi theo id. */
  async deleteById(id: string, db: RepoDb = this.db()): Promise<void> {
    await db.deleteFrom('files').where('id', '=', id).execute();
  }

  /**
   * Đếm bản ghi cùng contentHash — refcount của nội dung vật lý
   * (ngữ nghĩa Moodle: dữ liệu vật lý còn sống khi refcount > 0).
   * Ép `::int` giữ kiểu runtime là `number` như đường Drizzle cũ.
   */
  async countByHash(contentHash: string, db: RepoDb = this.db()): Promise<number> {
    const row = await db
      .selectFrom('files')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('content_hash', '=', contentHash)
      .executeTakeFirst();
    return row?.n ?? 0;
  }

  /** Liệt kê tệp trong một context, theo id tăng dần. */
  async listByContext(contextId: string, db: RepoDb = this.db()): Promise<FileRow[]> {
    return db
      .selectFrom('files')
      .select(FILE_COLUMNS)
      .where('context_id', '=', contextId)
      .orderBy('id', 'asc')
      .execute();
  }

  /**
   * Các bài nộp đang gắn với một tệp qua bảng liên kết của module
   * Bài tập (`assign_submission_files`): tệp bài nộp nào cũng có
   * đúng một dòng liên kết tại đây. Đường xoá dùng chung dùng kết
   * quả này để biết tệp có đang chịu khoá bài nộp hay không trước
   * khi xoá.
   */
  async listSubmissionLinks(fileId: string, db: RepoDb = this.db()): Promise<LinkedSubmissionRow[]> {
    return db
      .selectFrom('assign_submission_files')
      .innerJoin('assign_submissions', 'assign_submission_files.submission_id', 'assign_submissions.id')
      .select(LINKED_SUBMISSION_COLUMNS)
      .where('assign_submission_files.file_id', '=', fileId)
      .execute();
  }

  /**
   * Một bài nộp theo id, ở hình chiếu tối thiểu của chốt xoá tệp
   * — dùng khi bản ghi tệp tự khai là tệp bài nộp (component/file
   * area của module Bài tập, item id là id bài nộp) nhưng dòng
   * liên kết vắng mặt.
   */
  async getSubmission(submissionId: string, db: RepoDb = this.db()): Promise<LinkedSubmissionRow | undefined> {
    return db
      .selectFrom('assign_submissions')
      .select(LINKED_SUBMISSION_COLUMNS)
      .where('assign_submissions.id', '=', submissionId)
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Gói chấm hiện hành của một học viên cho một bài tập (trạng
   * thái + lần nộp mà gói thuộc về): chốt xoá tệp so lần nộp của
   * gói với lần nộp hiện hành của bài nộp để biết bài đã được TRẢ
   * BÀI hay chưa, đúng ngữ nghĩa "gói chấm của lần nộp hiện hành"
   * của module Bài tập.
   */
  async getGradeForSubmission(
    assignmentId: string,
    userId: string,
    db: RepoDb = this.db(),
  ): Promise<{ status: string; attemptNumber: number } | undefined> {
    return db
      .selectFrom('assign_grades')
      .select(['status', 'attempt_number as attemptNumber'])
      .where('assignment_id', '=', assignmentId)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
  }
}
