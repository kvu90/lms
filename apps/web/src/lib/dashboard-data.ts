import { queryOptions, useQuery } from '@tanstack/react-query';
import type { DashboardOverviewView } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu riêng của trang tổng quan (F-01 của rà soát #133):
 * khối tổng hợp DASH1 và thẻ số thông báo chưa đọc của học sinh.
 * Các nguồn còn lại của trang dùng tuỳ chọn/hook của module miền
 * tương ứng (người dùng, cây danh mục, vai trò, huy hiệu, lịch).
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
    queryFn: () => apiJson<DashboardOverviewView>('/api/v1/dashboard/overview?days=7'),
  });
}

/** Hook đọc khối tổng hợp DASH1 cho các khối vai trò của trang tổng quan. */
export function useDashboardOverview() {
  return useQuery(dashboardOverviewQueryOptions());
}

/**
 * Tuỳ chọn truy vấn số thông báo chưa đọc cho thẻ thống kê của học
 * sinh (GET /notifications/unread-count): khoá `notifications` giữ
 * nguyên như trước vì loader SL-1 của route `/` nạp trước đúng khoá
 * này để dehydrate — đổi khoá sẽ phá hợp đồng SSR đó.
 */
export function dashboardUnreadCountQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.notifications,
    queryFn: () => apiJson<{ unread: number }>('/api/v1/notifications/unread-count'),
  });
}
