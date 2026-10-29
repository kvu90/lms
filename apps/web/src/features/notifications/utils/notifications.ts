import type { NotificationGroupView, NotificationPreferenceView } from '../types/notifications';

/**
 * Hàm thuần của trung tâm thông báo thuộc feature notifications.
 * Tách từ module phẳng `src/lib/notifications.ts` khi tổ chức lại
 * apps/web theo mô hình features/ (issue #500).
 */

/** Khoá định danh một dòng gộp trong cache/trạng thái hiển thị. */
export function notificationGroupKey(g: Pick<NotificationGroupView, 'eventType' | 'contextUrl' | 'day'>): string {
  return `${g.eventType}|${g.contextUrl ?? ''}|${g.day}`;
}

/** Khoá định danh một dòng tuỳ chọn v2 (một dòng cho mỗi provider). */
export function preferenceKey(row: Pick<NotificationPreferenceView, 'provider'>): string {
  return row.provider;
}

/**
 * URL một trang danh sách nhóm theo bộ lọc + con trỏ — dùng chung cho
 * hook phía client và loader SL-1 (loader phải gọi ĐÚNG URL này cho
 * bộ lọc mặc định để dữ liệu dehydrate khớp trang đầu phía client).
 */
export function groupsUrl(group: string, unreadOnly: boolean, cursor?: string): string {
  const params = new URLSearchParams({ limit: '20' });
  if (group !== 'all') params.set('group', group);
  if (unreadOnly) params.set('unreadOnly', 'true');
  if (cursor) params.set('cursor', cursor);
  return `/api/v1/notifications?${params.toString()}`;
}
