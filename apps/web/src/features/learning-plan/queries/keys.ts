/**
 * Khoá truy vấn của feature learning-plan (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  userLearningPlans: (userId: string) => ['competencies', 'plans', 'user', userId] as const,
  learningPlanDetail: (planId: string) => ['competencies', 'plans', planId] as const,
  competencyFrameworks: ['competencies', 'frameworks'] as const,
  competencyTemplates: ['competencies', 'templates'] as const,
  frameworkCompetencies: (frameworkId: string) =>
    ['competencies', 'frameworks', frameworkId, 'competencies'] as const,
  frameworkExport: (frameworkId: string) => ['competencies', 'frameworks', frameworkId, 'export'] as const,
  userCompetencies: (userId: string) => ['competencies', 'usercomp', 'user', userId] as const,
  userOptions: ['users', 'options'] as const,
};
