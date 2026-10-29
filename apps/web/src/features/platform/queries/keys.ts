/**
 * Khoá truy vấn của feature platform (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  myInsights: ['analytics', 'insights', 'me'] as const,
  privacyRequests: ['privacy', 'requests'] as const,
  backupJobs: ['backup', 'jobs'] as const,
  backupSteps: (jobId: string) => ['backup', 'jobs', jobId, 'steps'] as const,
  webserviceServices: ['webservice', 'services'] as const,
  webserviceTokens: ['webservice', 'tokens'] as const,
  platformReports: ['reports'] as const,
  reportRun: (reportId: string) => ['reports', reportId, 'run'] as const,
};
