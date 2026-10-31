/**
 * Chuỗi class của ô chọn native dùng chung trong các bề mặt vai trò
 * của feature admin (bộ chọn ngữ cảnh, bộ lọc, cỡ trang).
 *
 * File trung tính này chỉ giữ hằng số trình bày của `<select>` native
 * để mọi ô chọn của feature nhìn nhất quán (cao h-9, bo rounded-md,
 * cỡ chữ text-sm — theo SelectTrigger của hệ). Ô chọn bốn trạng thái
 * quyền từng sống cùng file này đã rời khỏi các bề mặt ma trận theo
 * phán quyết vòng sửa 3 của PR #601: ma trận nay dùng checkbox/toggle
 * hai trạng thái Cho phép/Kế thừa (xem `permission-cells.tsx`), nên
 * hằng số được dời sang đây để các ô chọn còn lại không phụ thuộc vào
 * một component đã gỡ.
 */

/** Chuỗi class của ô chọn native trong các bề mặt vai trò — dùng chung để mọi ô chọn nhìn nhất quán. */
export const NATIVE_SELECT_CLASS =
  'h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
