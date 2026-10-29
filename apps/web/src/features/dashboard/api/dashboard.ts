import type { DashboardOverviewView } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Tầng gọi API thuần của feature dashboard: chỉ chứa các hàm đọc dữ
 * liệu qua HTTP, không phụ thuộc React hay React Query. Tầng
 * `queries/` của feature bọc các hàm này thành queryOptions và hook.
 * Trước đây các lời gọi này nằm inline trong queryFn của module dữ
 * liệu phẳng `src/lib/dashboard-data.ts`; việc tổ chức lại theo mô
 * hình features/ (issue #500) tách chúng thành hàm có tên ở tầng api/.
 */

/**
 * Đọc khối tổng hợp DASH1 (GET /dashboard/overview). Endpoint đồng
 * thời cập nhật mốc xem trước phía server khi tính xong danh sách
 * "mới".
 *
 * @returns Khối tổng hợp DASH1 của người dùng hiện tại.
 */
export function fetchDashboardOverview() {
  return apiJson<DashboardOverviewView>('/api/v1/dashboard/overview?days=7');
}

/**
 * Đọc số thông báo chưa đọc (GET /notifications/unread-count) cho
 * thẻ thống kê của học sinh trên trang tổng quan.
 *
 * @returns Số thông báo chưa đọc của người dùng hiện tại.
 */
export function fetchNotificationUnreadCount() {
  return apiJson<{ unread: number }>('/api/v1/notifications/unread-count');
}
