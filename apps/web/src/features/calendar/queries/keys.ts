/**
 * Khoá truy vấn của feature calendar (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  calendarSubscriptions: ['calendar', 'subscriptions'] as const,
  calendarExportToken: ['calendar', 'export-token'] as const,
};
