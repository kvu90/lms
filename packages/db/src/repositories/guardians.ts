/**
 * Repository của cụm LIÊN KẾT GIÁM HỘ trên Kysely — một phần của
 * nhóm G9 trong chiến dịch chuyển tầng dữ liệu Drizzle → Kysely
 * (issue #649).
 *
 * Vai trò: mọi truy cập tới bảng `guardian_links` (liên kết giám hộ
 * phụ huynh – học sinh của một trung tâm) tập trung ở đây. Liên kết
 * là cổng quyền của toàn bộ bề mặt phụ huynh: một liên kết ở trạng
 * thái `active` cho cặp (phụ huynh, học sinh) mới cho phép phụ huynh
 * xem dữ kiện của học sinh đó (bề mặt chỉ-đọc nằm ở repository
 * `guardian-view.ts` đi kèm). Repository không chứa luật nghiệp vụ —
 * kiểm tra trùng liên kết đang hiệu lực, kiểm tra tư cách thành viên
 * của trung tâm và ghi sự kiện kiểm toán nằm ở tầng service phía ứng
 * dụng; repository chỉ nhận handle (instance gốc hoặc transaction
 * đang mở) để phía gọi ghép nhiều thao tác vào một transaction khi
 * cần.
 *
 * Khuôn hình dạng dữ liệu ở biên repository (khuôn của pilot kho
 * control plane, xem sổ tay trong `AGENTS.md` của package):
 * - Bên trong repository, truy vấn viết trên interface schema sinh
 *   bằng codegen: tên bảng/cột giữ nguyên snake_case của database,
 *   kiểu dòng nội bộ qua `Selectable`/`Insertable`/`Updateable`.
 * - Bên ngoài, repository trả NHẬN các hình dạng dòng camelCase như
 *   phía tiêu thụ đang dùng: cột được chọn bằng danh sách tường minh
 *   có bí danh (`tenant_id as tenantId`), giá trị ghi được ánh xạ
 *   từng trường từ camelCase sang snake_case ở các hàm
 *   `*InsertValues`/`*UpdateSet` trong file này. Phía tiêu thụ vì
 *   vậy chỉ đổi điểm import khi chuyển đổi.
 * - Giá trị `undefined` bị LOẠI khỏi values/set trong các hàm ánh
 *   xạ ghi (thử nghiệm T-4 đã đo ở pilot): trường vắng mặt phải để
 *   default của database quyết định. Ngược lại, `undefined` lọt vào
 *   mệnh đề WHERE được biên dịch thành placeholder mà driver gắn
 *   NULL lúc thực thi, khiến phép so sánh lặng lẽ không khớp dòng
 *   nào — vì vậy bộ lọc động của `listLinks` chỉ dựng điều kiện từ
 *   các giá trị thật sự có mặt và bỏ hẳn mệnh đề WHERE khi không có
 *   điều kiện nào (khuôn T-13), không bao giờ truyền `undefined`.
 * - Repository không import từ `apps/*`, không đọc ALS/ngữ cảnh ứng
 *   dụng, không tự mở pool: handle do tầng ứng dụng dựng bằng
 *   factory của package (facade định tuyến theo không gian của kho
 *   trung tâm) rồi truyền vào lúc khởi tạo.
 */
import type { Expression, Insertable, SqlBool, Updateable } from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/** Handle đọc/ghi mà repository nhận: instance gốc hoặc transaction đang mở của kho trung tâm. */
export type GuardianDb = CentreDb | CentreTx;

/** Một dòng liên kết giám hộ phụ huynh – học sinh (hình dạng camelCase phía tiêu thụ dùng). */
export interface GuardianLinkRow {
  id: string;
  /** Trung tâm mà liên kết thuộc về. */
  tenantId: string;
  /** Tài khoản của phụ huynh. */
  guardianUserId: string;
  /** Tài khoản của học sinh được giám hộ. */
  studentUserId: string;
  /** Quan hệ của phụ huynh với học sinh (cha, mẹ, người giám hộ…). */
  relationship: string;
  /** active | revoked — chỉ liên kết `active` mới mở quyền xem. */
  status: string;
  /** Người tạo liên kết. */
  createdBy: string;
  /** Người thu hồi liên kết; null khi liên kết chưa bị thu hồi. */
  revokedBy: string | null;
  /** Thời điểm thu hồi; null khi liên kết chưa bị thu hồi. */
  revokedAt: Date | null;
  /** Ghi chú kèm liên kết; có thể trống. */
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Dữ kiện ghi một liên kết giám hộ mới. Các trường có default ở
 * database (khoá chính UUIDv7, `status`, hai mốc thời gian) và các
 * trường nullable đều không bắt buộc — trường vắng mặt để database
 * quyết định, đúng hợp đồng `$inferInsert` của đường Drizzle trước
 * đây.
 */
export interface NewGuardianLink {
  id?: string;
  tenantId: string;
  guardianUserId: string;
  studentUserId: string;
  relationship: string;
  status?: string;
  createdBy: string;
  revokedBy?: string | null;
  revokedAt?: Date | null;
  note?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/** Danh sách cột tường minh có bí danh camelCase cho bảng liên kết giám hộ (dùng cho cả select lẫn returning). */
const GUARDIAN_LINK_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'guardian_user_id as guardianUserId',
  'student_user_id as studentUserId',
  'relationship',
  'status',
  'created_by as createdBy',
  'revoked_by as revokedBy',
  'revoked_at as revokedAt',
  'note',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/**
 * Ánh xạ dữ kiện ghi liên kết (camelCase) sang values insert
 * (snake_case), LOẠI mọi trường mang `undefined` — trường vắng mặt
 * phải để default của database quyết định, không được biên dịch
 * thành tham số `null` (quy tắc T-4 trong sổ tay của package).
 */
function guardianLinkInsertValues(values: NewGuardianLink): Insertable<CentreDB['guardian_links']> {
  const row: Insertable<CentreDB['guardian_links']> = {
    tenant_id: values.tenantId,
    guardian_user_id: values.guardianUserId,
    student_user_id: values.studentUserId,
    relationship: values.relationship,
    created_by: values.createdBy,
  };
  if (values.id !== undefined) row.id = values.id;
  if (values.status !== undefined) row.status = values.status;
  if (values.revokedBy !== undefined) row.revoked_by = values.revokedBy;
  if (values.revokedAt !== undefined) row.revoked_at = values.revokedAt;
  if (values.note !== undefined) row.note = values.note;
  if (values.createdAt !== undefined) row.created_at = values.createdAt;
  if (values.updatedAt !== undefined) row.updated_at = values.updatedAt;
  return row;
}

/**
 * Ánh xạ một patch cập nhật liên kết (camelCase) sang set update
 * (snake_case), LOẠI mọi trường `undefined` — patch chứa trường nào
 * thì chỉ trường đó đổi, đúng ngữ nghĩa bỏ qua `undefined` của đường
 * Drizzle trước đây (quy tắc T-4).
 */
function guardianLinkUpdateSet(patch: Partial<GuardianLinkRow>): Updateable<CentreDB['guardian_links']> {
  const set: Updateable<CentreDB['guardian_links']> = {};
  if (patch.id !== undefined) set.id = patch.id;
  if (patch.tenantId !== undefined) set.tenant_id = patch.tenantId;
  if (patch.guardianUserId !== undefined) set.guardian_user_id = patch.guardianUserId;
  if (patch.studentUserId !== undefined) set.student_user_id = patch.studentUserId;
  if (patch.relationship !== undefined) set.relationship = patch.relationship;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.createdBy !== undefined) set.created_by = patch.createdBy;
  if (patch.revokedBy !== undefined) set.revoked_by = patch.revokedBy;
  if (patch.revokedAt !== undefined) set.revoked_at = patch.revokedAt;
  if (patch.note !== undefined) set.note = patch.note;
  if (patch.createdAt !== undefined) set.created_at = patch.createdAt;
  return set;
}

/**
 * Kho dữ liệu liên kết giám hộ PH–HS (PH-0, issue #116) trên Kysely.
 *
 * Handle gốc được truyền lúc khởi tạo (facade định tuyến của kho
 * trung tâm do tầng ứng dụng cấp); mọi phương thức nhận thêm handle
 * tuỳ chọn để phía gọi ghép thao tác vào transaction đang mở của
 * chúng — repository không tự mở transaction ngoài phương thức
 * `transaction` tường minh.
 */
export class GuardiansRepository {
  constructor(private readonly handle: GuardianDb) {}

  /** Instance gốc của repository. */
  private db(): GuardianDb {
    return this.handle;
  }

  /** Mở một transaction trên kho trung tâm và chạy `fn` với handle giao dịch. */
  async transaction<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.db().transaction().execute(fn);
  }

  /** Chèn một liên kết giám hộ mới và trả về dòng vừa chèn. */
  async insertLink(v: NewGuardianLink, db: GuardianDb = this.db()): Promise<GuardianLinkRow> {
    const rows = await db
      .insertInto('guardian_links')
      .values(guardianLinkInsertValues(v))
      .returning(GUARDIAN_LINK_COLUMNS)
      .execute();
    return rows[0]!;
  }

  /** Lấy liên kết theo id. */
  async getLink(id: string, db: GuardianDb = this.db()): Promise<GuardianLinkRow | undefined> {
    return db
      .selectFrom('guardian_links')
      .select(GUARDIAN_LINK_COLUMNS)
      .where('id', '=', id)
      .limit(1)
      .executeTakeFirst();
  }

  /** Liên kết đang hiệu lực của đúng một cặp (phụ huynh, học sinh), nếu có. */
  async findActiveLink(
    guardianUserId: string,
    studentUserId: string,
    db: GuardianDb = this.db(),
  ): Promise<GuardianLinkRow | undefined> {
    return db
      .selectFrom('guardian_links')
      .select(GUARDIAN_LINK_COLUMNS)
      .where('guardian_user_id', '=', guardianUserId)
      .where('student_user_id', '=', studentUserId)
      .where('status', '=', 'active')
      .limit(1)
      .executeTakeFirst();
  }

  /**
   * Mọi liên kết (kể cả đã thu hồi) khớp bộ lọc — dùng cho bề mặt
   * quản lý và bề mặt "của tôi". Bộ lọc rỗng thì không dựng mệnh đề
   * WHERE nào (mọi liên kết đều khớp); có điều kiện thì các điều
   * kiện được nối bằng AND trong một biểu thức duy nhất (khuôn
   * T-13 cho điều kiện động).
   */
  async listLinks(
    filters: { guardianUserId?: string; studentUserId?: string; status?: string },
    db: GuardianDb = this.db(),
  ): Promise<GuardianLinkRow[]> {
    const { guardianUserId, studentUserId, status } = filters;
    let query = db.selectFrom('guardian_links').select(GUARDIAN_LINK_COLUMNS);
    if (guardianUserId !== undefined || studentUserId !== undefined || status !== undefined) {
      query = query.where((eb) => {
        const conds: Expression<SqlBool>[] = [];
        if (guardianUserId !== undefined) conds.push(eb('guardian_user_id', '=', guardianUserId));
        if (studentUserId !== undefined) conds.push(eb('student_user_id', '=', studentUserId));
        if (status !== undefined) conds.push(eb('status', '=', status));
        return eb.and(conds);
      });
    }
    return query.orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  }

  /** Cập nhật một liên kết (thu hồi); mốc `updatedAt` luôn lấy thời điểm cập nhật. */
  async updateLink(id: string, patch: Partial<GuardianLinkRow>, db: GuardianDb = this.db()): Promise<void> {
    await db
      .updateTable('guardian_links')
      .set({ ...guardianLinkUpdateSet(patch), updated_at: new Date() })
      .where('id', '=', id)
      .execute();
  }
}
