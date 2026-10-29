import { apiJson } from '#lib/api';
import type { GlobalSearchDoc } from '#lib/search-target';

/**
 * Tầng gọi API thuần của tìm kiếm toàn cục thuộc feature
 * platform: chỉ chứa hàm gọi HTTP, không phụ thuộc React hay
 * React Query. Tầng `queries/` của feature bọc hàm này thành
 * queryOptions. Tách từ module phẳng `src/lib/search-data.ts`
 * khi tổ chức lại apps/web theo mô hình features/ (issue #500).
 */

/**
 * Đọc kết quả tìm kiếm toàn cục theo từ khoá (GET /search?q=).
 *
 * @param keyword - Từ khoá tìm.
 * @returns Danh sách tài liệu khớp.
 */
export function fetchGlobalSearch(keyword: string) {
  return apiJson<GlobalSearchDoc[]>(`/api/v1/search?q=${encodeURIComponent(keyword)}`);
}
