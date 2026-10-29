/**
 * Khoá truy vấn của feature courses (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  coursePage: (courseId: string) => ['courses', courseId, 'page'] as const,
  myPayments: ['payments', 'me'] as const,
  courseMyProgress: (courseId: string) => ['courses', courseId, 'progress', 'me'] as const,
  courseTemplates: ['courses', 'templates'] as const,
  courseGroupings: (courseId: string) => ['courses', courseId, 'groupings'] as const,
  courseGroupingGroups: (courseId: string, groupingId: string) =>
    ['courses', courseId, 'groupings', groupingId, 'groups'] as const,
  courseGroupMembers: (courseId: string, groupId: string) =>
    ['courses', courseId, 'groups', groupId, 'members'] as const,
  cohorts: ['cohorts'] as const,
  cohortMembers: (cohortId: string) => ['cohorts', cohortId, 'members'] as const,
  courseEnrolInstances: (courseId: string) => ['courses', courseId, 'enrol-instances'] as const,
  courseEnrolments: (courseId: string) => ['courses', courseId, 'enrolments'] as const,
  courseCompletions: (courseId: string) => ['courses', courseId, 'completion'] as const,
};
