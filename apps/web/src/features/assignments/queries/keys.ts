/**
 * Khoá truy vấn của feature assignments (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  assignmentDetail: (assignmentId: string) => ['assignments', assignmentId] as const,
  assignmentSubmissions: (assignmentId: string) => ['assignments', assignmentId, 'submissions'] as const,
  submissionDetail: (assignmentId: string, userId: string) =>
    ['assignments', assignmentId, 'submissions', userId] as const,
  commentBank: ['assign-comment-bank'] as const,
  currentUser: ['users', 'me'] as const,
};
