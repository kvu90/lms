/**
 * Ánh xạ kết quả tìm kiếm toàn cục (GET /api/v1/search) sang đường
 * dẫn đích trong app — dùng chung cho bề mặt tìm kiếm hợp nhất ở
 * header (bảng lệnh Ctrl/Cmd+K) và trang kết quả `/search`, để hai
 * nơi không bao giờ suy diễn đích lệch nhau.
 *
 * Nguồn sự thật về `area`: phía API (search.service) đăng ký đúng
 * ba area dựng sẵn — `courses`, `users`, `contentbank` — và
 * `itemId` là định danh của chính item trong area đó. Đích được
 * chọn theo đúng route hiện hành của hệ cho từng loại item:
 *
 * - `courses` → `/courses/:itemId` — trang của khoá học.
 * - `users` → `/admin/users/:itemId/edit` — route theo một người
 *   dùng duy nhất hệ hiện có (màn quản trị người dùng), NHƯNG chỉ
 *   gắn đích khi người đang tìm có quyền quản trị người dùng (xem
 *   luật riêng của area này bên dưới); ngoài ra trả null.
 * - `contentbank` → `/content-bank/:itemId/edit` — route theo một
 *   học liệu duy nhất hệ hiện có (màn tạo/sửa của Kho học liệu);
 *   trang đích và API tự gác quyền sửa theo chủ sở hữu.
 *
 * Luật riêng của area `users` — đích phụ thuộc quyền của NGƯỜI TÌM:
 * phía API chỉ re-check area này bằng `user:viewdetails`, là
 * capability nền mà PermissionEvaluator phân giải cho MỌI người
 * dùng đã đăng nhập (để xem hồ sơ lẫn nhau) — nên mọi vai trò đều
 * NHẬN kết quả `users` khi từ khoá khớp, kể cả học viên và phụ
 * huynh. Trong khi đó đích duy nhất theo một người dùng của hệ là
 * màn quản trị, tự gác bằng `user:update` (PATCH ở
 * users.controller, archetype quản trị). Trỏ người không có quyền
 * đó vào màn quản trị là ngõ cụt (vào được thì cũng bị chặn), nên
 * ánh xạ chỉ gắn đích khi ảnh chụp quyền của người đang tìm cho
 * thấy quyền quản trị người dùng; mọi vai trò còn lại giữ kết quả
 * ở dạng thông tin không điều hướng — đúng cơ chế không-đích của
 * area lạ ở dưới, không bịa đường dẫn và không trỏ vào màn quản
 * trị.
 *
 * Area lạ (module khác có thể đăng ký area mới phía API qua
 * registerArea mà web chưa biết đích): trả null — bề mặt hiển thị
 * giữ kết quả ở dạng thông tin, không bịa đường dẫn.
 */

/** Một bản ghi kết quả của GET /api/v1/search (khớp hình dạng phía API trả). */
export interface GlobalSearchDoc {
  id: string;
  area: string;
  itemId: string;
  title: string;
  content: string;
}

/**
 * Phần ảnh chụp quyền của người đang tìm mà ánh xạ đích cần để
 * quyết định đích của area `users`. Bề mặt hiển thị suy từ
 * GET /users/me/capabilities của chính người đang tìm: site admin,
 * hoặc capability `user:update` đã phân giải tại context hệ thống
 * (capability mà màn đích `/admin/users/:id/edit` tự gác).
 */
export interface SearchTargetViewer {
  /** Có quyền quản trị người dùng — điều kiện gắn đích màn quản trị cho kết quả `users`. */
  canManageUsers: boolean;
}

/**
 * Đích điều hướng của một kết quả tìm kiếm, hoặc null khi kết quả
 * phải giữ ở dạng thông tin (area chưa có route đích, hoặc kết
 * quả `users` mà người đang tìm không có quyền quản trị người
 * dùng). Thiếu `viewer` thì area `users` luôn không đích — chiều
 * an toàn mặc định.
 *
 * @param doc - Bản ghi kết quả từ GET /api/v1/search.
 * @param viewer - Quyền của người đang tìm (chỉ area `users` cần).
 * @returns Path đích trong app, hoặc null nếu kết quả không điều hướng được.
 */
export function globalSearchTarget(
  doc: Pick<GlobalSearchDoc, 'area' | 'itemId'>,
  viewer?: SearchTargetViewer,
): string | null {
  switch (doc.area) {
    case 'courses':
      return `/courses/${doc.itemId}`;
    case 'users':
      return viewer?.canManageUsers ? `/admin/users/${doc.itemId}/edit` : null;
    case 'contentbank':
      return `/content-bank/${doc.itemId}/edit`;
    default:
      return null;
  }
}
