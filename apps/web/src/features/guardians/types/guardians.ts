/**
 * Kiểu dữ liệu của bề mặt phụ huynh thuộc feature guardians.
 * Tách từ module phẳng `src/lib/guardian-data.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500): kiểu nằm ở tầng
 * types/, lời gọi API thuần ở tầng api/, options/hook và
 * clientLoader ở tầng queries/.
 */

/** Một liên kết con của phụ huynh (GET /guardian-links/mine/students). */
export interface GuardianMyStudentEntry {
  student: { id: string; firstName: string; lastName: string; username: string };
}

/**
 * Một liên kết giám hộ ở bề mặt quản lý (GET /guardian-links): đúng
 * hình dạng hàng `guardian_links` mà API trả về — ngày giờ là chuỗi
 * ISO vì đáp ứng đi qua JSON. `status` là 'active' | 'revoked'; thu
 * hồi là thu hồi mềm nên liên kết đã thu hồi vẫn nằm trong danh sách
 * kèm `revokedAt`/`revokedBy`, không biến mất.
 */
export interface GuardianLinkView {
  id: string;
  tenantId: string;
  guardianUserId: string;
  studentUserId: string;
  relationship: string;
  status: string;
  createdBy: string;
  revokedBy: string | null;
  revokedAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Thân tạo liên kết giám hộ (POST /guardian-links) — khớp `createGuardianLinkSchema` của contracts. */
export interface CreateGuardianLinkDraft {
  guardianUserId: string;
  studentUserId: string;
  relationship: string;
  note?: string;
}
