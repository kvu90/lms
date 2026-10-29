import { queryOptions, useQuery } from '@tanstack/react-query';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import { fetchDashboardOverview, fetchNotificationUnreadCount } from '../api/dashboard';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu riêng của trang tổng quan (F-01 của rà soát #133):
 * khối tổng hợp DASH1 và thẻ số thông báo chưa đọc của học sinh.
 * Các nguồn còn lại của trang dùng tuỳ chọn/hook của module miền
 * tương ứng (người dùng, cây danh mục, vai trò, huy hiệu, lịch).
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của dashboard nằm ở `keys.ts` cùng tầng này.
 */

/**
 * Tuỳ chọn truy vấn khối tổng hợp DASH1 (GET /dashboard/overview):
 * đúng MỘT query cho cả hai vai trên trang (TanStack dedupe theo
 * queryKey). Endpoint đồng thời cập nhật mốc xem trước phía server
 * khi tính xong danh sách "mới".
 */
export function dashboardOverviewQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.dashboardOverview,
    queryFn: () => fetchDashboardOverview(),
  });
}

/** Hook đọc khối tổng hợp DASH1 cho các khối vai trò của trang tổng quan. */
export function useDashboardOverview() {
  return useQuery(dashboardOverviewQueryOptions());
}

/**
 * Tuỳ chọn truy vấn số thông báo chưa đọc cho thẻ thống kê của học
 * sinh (GET /notifications/unread-count): dùng CHUNG khoá
 * `notificationUnreadCount` với chuông/sidebar — một dữ kiện chỉ có
 * một khoá để stream SSE và các đột biến đọc/xoá cập nhật đúng mục
 * cache mà thẻ này đọc. Loader SL-1 của route `/` cũng nạp trước
 * đúng khoá này để dehydrate cho cả hai bề mặt.
 */
export function dashboardUnreadCountQueryOptions() {
  return queryOptions({
    queryKey: sharedQueryKeys.notificationUnreadCount,
    queryFn: () => fetchNotificationUnreadCount(),
  });
}
