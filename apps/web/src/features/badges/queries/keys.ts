/**
 * Khoá truy vấn của feature badges (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  badges: ['badges'] as const,
  badgesAll: ['badges', 'all'] as const,
  badgeIssued: (badgeId: string) => ['badges', badgeId, 'issued'] as const,
};
