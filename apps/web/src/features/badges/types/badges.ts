/**
 * Kiểu dữ liệu của trang huy hiệu thuộc feature badges. Tách từ
 * module phẳng `src/lib/badges.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500): kiểu nằm ở tầng types/, lời
 * gọi API thuần ở tầng api/, hook ở tầng queries/.
 */

/** Huy hiệu (BadgeRow ở tầng API) như các bề mặt hiển thị cần. */
export interface BadgeView {
  id: string;
  name: string;
  description: string;
  type: number;
  courseId: string | null;
  status: number;
}

/** Bản ghi đã cấp (IssuedRow ở tầng API): bằng chứng bất biến của một lần cấp. */
export interface IssuedView {
  id: string;
  badgeId: string;
  userId: string;
  uniqueHash: string;
  dateIssued: string;
  dateExpire: string | null;
  revoked: boolean;
}

/**
 * Một dòng của GET /badges/mine: bản ghi đã cấp kèm chính huy hiệu lồng
 * bên trong (badges.service listMyBadges trả `IssuedRow & { badge }`).
 */
export interface MyBadgeView extends IssuedView {
  badge?: BadgeView;
}
