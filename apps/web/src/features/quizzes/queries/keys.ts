/**
 * Khoá truy vấn của feature quizzes (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  quizResults: (quizId: string) => ['quizzes', quizId, 'results'] as const,
  examPin: (pinId: string) => ['exam-pins', pinId] as const,
  examPinOverrides: (pinId: string) => ['exam-pins', pinId, 'overrides'] as const,
  examSource: (examId: string) => ['exams', examId] as const,
  courseRosterMembers: (courseId: string) => ['courses', courseId, 'roster-members'] as const,
  examBatches: (pinId: string) => ['exam-batches', pinId] as const,
  examScans: (pinId: string) => ['exam-scans', pinId] as const,
  quizAttempt: (attemptId: string) => ['quiz-attempts', attemptId] as const,
  examPinRegrades: (pinId: string) => ['exam-pins', pinId, 'regrades'] as const,
  examPinMyRegrades: (pinId: string) => ['exam-pins', pinId, 'my-regrades'] as const,
  examPinVersionUpdate: (pinId: string) => ['exam-pins', pinId, 'version-update'] as const,
};
