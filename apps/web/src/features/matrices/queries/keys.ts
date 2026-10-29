/**
 * Khoá truy vấn của feature matrices (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  questionBanksByKind: (kind: string) => ['question-banks', kind] as const,
  curriculaBySubject: (subjectId: string) => ['curriculum', 'curricula', subjectId] as const,
  matrixDetail: (matrixId: string) => ['exam-matrices', matrixId] as const,
  matrixAvailability: (matrixId: string) => ['exam-matrices', matrixId, 'availability'] as const,
  matrixSpecification: (matrixId: string) => ['exam-matrices', matrixId, 'specification'] as const,
};
