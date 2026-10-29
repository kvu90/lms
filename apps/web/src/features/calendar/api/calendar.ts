import { apiJson } from '#lib/api';
import type { CalendarEventView, CalendarExportTokenView, CalendarSubscriptionView } from '../types/calendar';

/**
 * Tầng gọi API thuần của trang lịch thuộc feature calendar: chỉ
 * chứa các hàm gọi HTTP, không phụ thuộc React hay React Query.
 * Tầng `queries/` của feature bọc các hàm này thành hook. Tách
 * từ module phẳng `src/lib/calendar.ts` khi tổ chức lại apps/web
 * theo mô hình features/ (issue #500).
 */

/**
 * Đọc sự kiện trong một khoảng ngày (GET /calendar/events?from=&to=).
 *
 * @param fromIso - Đầu khoảng (ISO).
 * @param toIso - Cuối khoảng (ISO).
 * @returns Danh sách sự kiện.
 */
export function fetchCalendarEvents(fromIso: string, toIso: string) {
  return apiJson<CalendarEventView[]>(`/api/v1/calendar/events?from=${fromIso}&to=${toIso}`);
}

/**
 * Đọc đăng ký lịch ngoài (GET /calendar/subscriptions).
 *
 * @returns Danh sách đăng ký.
 */
export function fetchCalendarSubscriptions() {
  return apiJson<CalendarSubscriptionView[]>('/api/v1/calendar/subscriptions');
}

/**
 * Đọc đường dẫn xuất lịch hiện tại (GET /calendar/export-token).
 *
 * @returns Token xuất lịch hoặc null khi chưa tạo.
 */
export function fetchCalendarExportToken() {
  return apiJson<CalendarExportTokenView | null>('/api/v1/calendar/export-token');
}

/**
 * Tạo sự kiện lịch (POST /calendar/events) theo đúng DTO phía trang dựng.
 *
 * @param body - Thân tạo sự kiện.
 * @returns Đáp ứng của API.
 */
export function createCalendarEvent(body: Record<string, unknown>) {
  return apiJson('/api/v1/calendar/events', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Xoá một sự kiện của mình (DELETE /calendar/events/:id).
 *
 * @param id - Định danh sự kiện.
 * @returns Đáp ứng của API.
 */
export function deleteCalendarEvent(id: string) {
  return apiJson(`/api/v1/calendar/events/${id}`, { method: 'DELETE' });
}

/**
 * Đặt nhắc trước sự kiện (POST /calendar/events/:id/remind).
 *
 * @param id - Định danh sự kiện.
 * @returns Đáp ứng của API.
 */
export function remindCalendarEvent(id: string) {
  return apiJson(`/api/v1/calendar/events/${id}/remind`, {
    method: 'POST',
    body: JSON.stringify({ minutesBefore: 60 }),
  });
}

/**
 * Thêm đăng ký lịch ngoài từ URL ICS (POST /calendar/subscriptions).
 *
 * @param input - Tên và URL của đăng ký.
 * @returns Đáp ứng của API.
 */
export function createCalendarSubscription(input: { name: string; url: string }) {
  return apiJson('/api/v1/calendar/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, url: input.url, eventType: 'user' }),
  });
}

/**
 * Yêu cầu nhập ngay một đăng ký (POST /calendar/subscriptions/:id/import).
 *
 * @param id - Định danh đăng ký.
 * @returns Đáp ứng của API.
 */
export function importCalendarSubscription(id: string) {
  return apiJson(`/api/v1/calendar/subscriptions/${id}/import`, { method: 'POST', body: '{}' });
}

/**
 * Tạo/tạo lại đường dẫn xuất lịch (POST /calendar/export-token) — token cũ hết hiệu lực phía server.
 *
 * @returns Token xuất lịch vừa tạo.
 */
export function createCalendarExportToken() {
  return apiJson<CalendarExportTokenView>('/api/v1/calendar/export-token', { method: 'POST' });
}

/**
 * Thu hồi đường dẫn xuất lịch (DELETE /calendar/export-token).
 *
 * @returns Đáp ứng của API.
 */
export function revokeCalendarExportToken() {
  return apiJson('/api/v1/calendar/export-token', { method: 'DELETE' });
}
