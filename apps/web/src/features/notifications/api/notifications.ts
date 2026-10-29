import { apiJson } from '#lib/api';
import type {
  NotificationCourseOverrideView,
  NotificationGroupsPage,
  NotificationItemView,
  NotificationPreferenceView,
  PreferencePatch,
} from '../types/notifications';
import { groupsUrl } from '../utils/notifications';

/**
 * Tầng gọi API thuần của trung tâm thông báo thuộc feature
 * notifications: chỉ chứa các hàm gọi HTTP, không phụ thuộc React
 * hay React Query. Tầng `queries/` của feature bọc các hàm này
 * thành options/hook và thao tác cache. Tách từ module phẳng
 * `src/lib/notifications.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc số thông báo chưa đọc cho huy hiệu (GET /notifications/unread-count).
 *
 * @returns Số chưa đọc.
 */
export function fetchNotificationUnreadCount() {
  return apiJson<{ unread: number }>('/api/v1/notifications/unread-count');
}

/**
 * Đọc một trang danh sách nhóm thông báo theo bộ lọc và con trỏ (GET /notifications).
 *
 * @param group - Bộ lọc nhóm ('all' hoặc một nhóm).
 * @param unreadOnly - Chỉ lấy nhóm còn chưa đọc.
 * @param cursor - Con trỏ phân trang (khi có).
 * @returns Trang nhóm kèm con trỏ trang kế.
 */
export function fetchNotificationGroupsPage(group: string, unreadOnly: boolean, cursor?: string) {
  return apiJson<NotificationGroupsPage>(groupsUrl(group, unreadOnly, cursor));
}

/**
 * Đọc các mục phẳng của một dòng gộp (GET /notifications/items).
 *
 * @param eventType - Loại sự kiện của dòng gộp.
 * @param contextUrl - URL ngữ cảnh (chuỗi rỗng khi không có).
 * @param day - Ngày của dòng gộp.
 * @returns Các mục của dòng gộp.
 */
export async function fetchNotificationGroupItems(eventType: string, contextUrl: string, day: string) {
  const params = new URLSearchParams({ eventType, contextUrl, day, limit: '100' });
  const page = await apiJson<{ items: NotificationItemView[]; nextCursor: string | null }>(
    `/api/v1/notifications/items?${params.toString()}`,
  );
  return page.items;
}

/**
 * Đánh dấu một mục đã đọc (POST /notifications/:id/read). Lỗi mạng bị
 * nuốt như hành vi cũ (UI vẫn cập nhật tại chỗ).
 *
 * @param id - Định danh mục thông báo.
 * @returns Đáp ứng của API hoặc undefined khi lỗi.
 */
export function markNotificationRead(id: string) {
  return apiJson(`/api/v1/notifications/${id}/read`, { method: 'POST', body: '{}' }).catch(() => undefined);
}

/**
 * Đánh dấu đã đọc cả một dòng gộp (POST /notifications/read-group) — cùng quy ước nuốt lỗi như đánh dấu một mục.
 *
 * @param group - Khoá của dòng gộp.
 * @returns Đáp ứng của API hoặc undefined khi lỗi.
 */
export function readNotificationGroup(group: { eventType: string; contextUrl: string | null; day: string }) {
  return apiJson('/api/v1/notifications/read-group', {
    method: 'POST',
    body: JSON.stringify({ eventType: group.eventType, contextUrl: group.contextUrl, day: group.day }),
  }).catch(() => undefined);
}

/**
 * Xoá một mục thông báo (DELETE /notifications/:id) — nuốt lỗi như cũ.
 *
 * @param id - Định danh mục thông báo.
 * @returns Đáp ứng của API hoặc undefined khi lỗi.
 */
export function deleteNotification(id: string) {
  return apiJson(`/api/v1/notifications/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

/**
 * Đánh dấu tất cả đã đọc (POST /notifications/mark-read với thân yêu cầu `{"scope": "all"}`).
 *
 * @returns Đáp ứng của API.
 */
export function markAllNotificationsRead() {
  return apiJson('/api/v1/notifications/mark-read', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
}

/**
 * Dọn các thông báo đã đọc (POST /notifications/clear-read).
 *
 * @returns Đáp ứng của API.
 */
export function clearReadNotifications() {
  return apiJson('/api/v1/notifications/clear-read', { method: 'POST', body: '{}' });
}

/**
 * Đọc toàn bộ dòng tuỳ chọn v2 của chính người dùng (GET /messages/preferences).
 *
 * @returns Danh sách dòng tuỳ chọn.
 */
export function fetchMessagePreferences() {
  return apiJson<NotificationPreferenceView[]>('/api/v1/messages/preferences');
}

/**
 * Đọc mọi khoá tôi thuộc về kèm chế độ ghi đè hiệu lực (GET /messages/preferences/courses).
 *
 * @returns Danh sách ghi đè theo khoá.
 */
export async function fetchNotificationCourseOverrides() {
  const res = await apiJson<{ courses: NotificationCourseOverrideView[] }>('/api/v1/messages/preferences/courses');
  return res.courses;
}

/**
 * Đặt ghi đè cho đúng một khoá (PUT /messages/preferences/courses).
 *
 * @param input - Khoá và chế độ mới.
 * @returns Dòng ghi đè sau khi lưu.
 */
export function setNotificationCourseOverride(input: { courseId: string; mode: NotificationCourseOverrideView['mode'] }) {
  return apiJson<NotificationCourseOverrideView>('/api/v1/messages/preferences/courses', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/**
 * Đặt tuỳ chọn v2 cho đúng một provider (PUT /messages/preferences).
 *
 * @param input - Provider và bản vá tuỳ chọn.
 * @returns Dòng tuỳ chọn sau khi lưu.
 */
export function setMessagePreference(input: { provider: string; patch: PreferencePatch }) {
  return apiJson<NotificationPreferenceView>('/api/v1/messages/preferences', {
    method: 'PUT',
    body: JSON.stringify({ provider: input.provider, ...input.patch }),
  });
}
