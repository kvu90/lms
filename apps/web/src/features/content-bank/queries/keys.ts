/**
 * Khoá truy vấn của feature content-bank (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  contentBankSpaces: ['content-bank', 'spaces'] as const,
  contentBankItems: ['content-bank', 'items'] as const,
  contentBankItem: (itemId: string) => ['content-bank', 'items', itemId] as const,
  contentBankItemFileUrl: (itemId: string) => ['content-bank', 'items', itemId, 'file-url'] as const,
  contentBankSubjects: ['content-bank', 'subjects'] as const,
  contentBankQuestionCategories: ['content-bank', 'question-categories'] as const,
  contentBankCurriculumNodes: (subjectId: string, grade: number) =>
    ['content-bank', 'curriculum-nodes', subjectId, grade] as const,
};
