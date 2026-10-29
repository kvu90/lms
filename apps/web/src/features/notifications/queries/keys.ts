/**
 * Khoá truy vấn của feature notifications (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  notificationGroupsRoot: ['notifications', 'groups'] as const,
  notificationGroups: (group: string, unreadOnly: boolean) =>
    ['notifications', 'groups', group, unreadOnly] as const,
  notificationGroupItems: (eventType: string, contextUrl: string, day: string) =>
    ['notifications', 'items', eventType, contextUrl, day] as const,
  messagePreferences: ['messages', 'preferences'] as const,
  messageCourseOverrides: ['messages', 'preferences', 'courses'] as const,
};
