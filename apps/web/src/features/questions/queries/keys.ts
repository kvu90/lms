/**
 * Khoá truy vấn của feature questions (query key factory theo khuyến
 * nghị của tài liệu TanStack Query), tách khỏi factory tập trung khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): mỗi feature giữ
 * khoá của mình ở tầng queries/; khoá dùng chung nhiều feature ở lại
 * src/lib/query-keys.ts. Cấu trúc phân cấp: thực thể → định danh → tham số.
 */
export const queryKeys = {
  questionCategories: ['questions', 'categories'] as const,
  categoryQuestions: (categoryId: string) => ['questions', 'categories', categoryId, 'questions'] as const,
  categoryStimuli: (categoryId: string) => ['stimuli', 'by-category', categoryId] as const,
  questionAttribution: (questionId: string) => ['questions', questionId, 'attribution'] as const,
  questionDetail: (questionId: string) => ['questions', questionId, 'detail'] as const,
  questionBanksRoot: ['question-banks'] as const,
  myBankQuestions: (bankId: string) => ['question-banks', bankId, 'all-questions'] as const,
  bankMatrixContributions: (bankId: string) => ['question-banks', bankId, 'matrix-contributions'] as const,
  bankQuestionContributions: (bankId: string) => ['question-banks', bankId, 'contributions'] as const,
  bankExams: (bankId: string) => ['exam-banks', bankId, 'exams'] as const,
  bankExamContributions: (bankId: string) => ['exam-banks', bankId, 'contributions'] as const,
  bankDossiers: (bankId: string) => ['exam-banks', bankId, 'dossiers'] as const,
  myDossiers: ['exams', 'dossiers', 'mine'] as const,
  questionCurriculumLinks: (questionId: string) => ['questions', questionId, 'curriculum-links'] as const,
  examDossierSpec: (dossierId: string) => ['exams', 'dossiers', dossierId, 'specification'] as const,
  questionUsage: (usageId: string) => ['question-usages', usageId] as const,
  stimulusDetail: (stimulusId: string) => ['stimuli', stimulusId] as const,
};
