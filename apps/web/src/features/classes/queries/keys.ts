/**
 * Khoá truy vấn của feature classes (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  payment: (paymentId: string) => ['payments', paymentId] as const,
  classRoot: (classId: string) => ['classes', classId] as const,
  classDetail: (classId: string) => ['classes', classId, 'detail'] as const,
  classOverview: (classId: string) => ['classes', classId, 'overview'] as const,
  classPublic: (classId: string) => ['classes', classId, 'public'] as const,
  classRoster: (classId: string) => ['classes', classId, 'roster'] as const,
  classSuspended: (classId: string) => ['classes', classId, 'suspended'] as const,
  classStaff: (classId: string) => ['classes', classId, 'staff'] as const,
  classJoinRequests: (classId: string) => ['classes', classId, 'join-requests'] as const,
};
