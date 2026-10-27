import { queryOptions } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';
import type { GlobalSearchDoc } from './search-target';

/**
 * Tầng dữ liệu TanStack Query cho tìm kiếm toàn cục (F-01 của rà soát
 * #133): trang `/search` là bề mặt có máy trạng thái riêng (ô từ khoá,
 * cờ đã tìm, danh sách kết quả do chính trang giữ nhịp chạy tìm theo
 * tham số `q` trên URL và theo form trong trang) nên trang đọc bằng
 * `fetchQuery` đúng tại các nhịp chạy tìm đó thay vì `useQuery` khai
 * báo — cùng khuôn các trang máy trạng thái khác của đợt F-01. Khoá
 * dùng chung `queryKeys.globalSearch` với nhóm "Nội dung" của bề mặt
 * Ctrl/Cmd+K ở header.
 *
 * `staleTime: 0` là giữ nguyên hành vi bản fetch thủ công: mỗi lượt
 * chạy tìm (vào trang theo `q`, đổi `q` ngay trong trang, bấm nút
 * "Tìm kiếm") đều gọi API thật bằng đúng từ khoá đó, không trả kết
 * quả đã cache của cùng từ khoá từ một lượt tìm trước. Options riêng
 * của bề mặt palette không đổi — nhịp debounce của palette vẫn dùng
 * cache mặc định trên cùng khoá.
 */

/** Tuỳ chọn truy vấn kết quả tìm kiếm toàn cục theo từ khoá (GET /search?q=). */
export function globalSearchQueryOptions(keyword: string) {
  return queryOptions({
    queryKey: queryKeys.globalSearch(keyword),
    queryFn: () => apiJson<GlobalSearchDoc[]>(`/api/v1/search?q=${encodeURIComponent(keyword)}`),
    staleTime: 0,
  });
}
