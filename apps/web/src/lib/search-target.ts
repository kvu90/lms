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
 *   dùng duy nhất hệ hiện có (màn quản trị người dùng); trang đích
 *   tự gác capability quản trị như mọi đường vào màn đó.
 * - `contentbank` → `/content-bank/:itemId/edit` — route theo một
 *   học liệu duy nhất hệ hiện có (màn tạo/sửa của Kho học liệu);
 *   trang đích và API tự gác quyền sửa theo chủ sở hữu.
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
 * Đích điều hướng của một kết quả tìm kiếm, hoặc null khi area
 * chưa có route đích trong hệ.
 *
 * @param doc - Bản ghi kết quả từ GET /api/v1/search.
 * @returns Path đích trong app, hoặc null nếu area không ánh xạ được.
 */
export function globalSearchTarget(doc: Pick<GlobalSearchDoc, 'area' | 'itemId'>): string | null {
  switch (doc.area) {
    case 'courses':
      return `/courses/${doc.itemId}`;
    case 'users':
      return `/admin/users/${doc.itemId}/edit`;
    case 'contentbank':
      return `/content-bank/${doc.itemId}/edit`;
    default:
      return null;
  }
}
