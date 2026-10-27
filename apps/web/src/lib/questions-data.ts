import { queryOptions, useMutation, useQuery, type QueryClient } from '@tanstack/react-query';
import type { QuestionCategory, QuestionView, RichTextDocument, StimulusView } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';
import { queryClient } from './query-client';

/**
 * Tầng dữ liệu trang ngân hàng câu hỏi/đề/ma trận (F-01 đợt 1, rà
 * soát #133): mỗi cụm tải trước đây (danh mục + câu hỏi/ngữ liệu
 * theo danh mục, bank theo loại + nội dung bank cá nhân, hàng chờ
 * đóng góp, bộ hồ sơ, khám phá) là một query theo khoá factory;
 * options dùng chung cho hook của trang và clientLoader của các
 * route module bọc trang.
 */

/** Bank như API lớp bank trả về (feat Ngân hàng câu hỏi chung, issue #70; bankKind + capabilities.matrix* là của MB-1, issue #111). */
export interface BankLite {
  id: string;
  name: string;
  scope: string;
  bankKind: string;
  defaultCategoryId: string | null;
  categoryIds: string[];
  capabilities: {
    use: boolean; add: boolean; moderate: boolean; copy: boolean;
    matrixView?: boolean; matrixManage?: boolean; matrixCopy?: boolean; matrixShare?: boolean; matrixModerate?: boolean;
  };
}

/** Một ma trận trong ngân hàng ma trận (MB-1) — hình dạng ExamMatrixView của API. */
export interface MatrixLite {
  id: string;
  name: string;
  subjectId: string;
  curriculumId: string;
  bankId: string | null;
  status: string;
  isTemplate: boolean;
  derivedFromMatrixId: string | null;
  version: number;
  presetKind: string;
  cells: { id: string }[];
}

/** Một đề xuất đóng góp ma trận trong hàng chờ duyệt (MB-1). */
export interface MatrixContributionLite {
  id: string;
  matrixId: string;
  matrixName: string | null;
  proposerName: string | null;
  status: string;
  note: string;
  rejectReason: string | null;
}

/** Dòng ghi công của một câu copy (GET /questions/:id/attribution). */
export interface AttributionLite {
  originalAuthorName: string | null;
  sourceBankName: string | null;
}

/** Một dòng tóm tắt đề trong ngân hàng đề (GET /exam-papers/banks/:bankId/papers). */
export interface PaperSummaryLite {
  id: string;
  bankId: string;
  kind: string;
  status: string;
  name: string;
  examKind: string | null;
  slotCount: number;
  latestVersion: number;
  createdBy: string;
  copyCount: number;
  capabilities: { edit: boolean; copy: boolean; deploy: boolean; moderate: boolean };
}

/** Một đề xuất đóng góp ĐỀ trong hàng chờ của một bank đề (EB-1). */
export interface ExamContributionLite {
  id: string;
  paperId: string;
  paperName: string | null;
  status: string;
  proposerId: string;
}

/** Một mốc duyệt trong vết của bộ hồ sơ (EB-3). */
export interface ExamDossierReviewLite {
  level: number;
  reviewerName: string | null;
  decision: string;
  reason: string | null;
}

/** Một BỘ HỒ SƠ đề (EB-3): ma trận + đề + đặc tả ghim tại lúc nộp, duyệt theo bộ (có thể hai cấp). */
export interface ExamDossierLite {
  id: string;
  paperId: string;
  paperName: string | null;
  targetBankId: string;
  proposerName: string | null;
  note: string;
  status: string;
  paperVersionNumber: number | null;
  matrixName: string | null;
  matrixVersion: number | null;
  boardApprovalRequired: boolean;
  resultPaperId: string | null;
  reviews: ExamDossierReviewLite[];
}

/** Bản đặc tả đã chụp trong bộ hồ sơ — chỉ phần cần để hiển thị tóm tắt trong hàng chờ (EB-3). */
export interface DossierSpecLite {
  totals: { totalQuestions: number; totalScore: number };
  topics: {
    nodes: {
      outcomes: {
        cells: { cognitiveLevel: string; questionCount: number; cellScore: number; slotNumbers: number[] | null }[];
      }[];
    }[];
  }[];
}

/**
 * Một dòng của trang khám phá ngân hàng chung (GET /questions/discovery).
 * Nhãn của câu là `excerpt` — trích đoạn nội dung do API tính sẵn (câu
 * hỏi không còn trường tên, quyết 11:28 ngày 26/10/2026).
 */
export interface DiscoveryItemLite {
  questionId: string;
  excerpt: string;
  qtype: string;
  status: string;
  bankId: string;
  bankName: string;
  bankScope: string;
  authorName: string | null;
  originalAuthorName: string | null;
  useCount: number;
  copyCount: number;
}

/** Một đề xuất đóng góp trong hàng chờ duyệt (QB-4). */
export interface ContributionLite {
  id: string;
  questionId: string;
  questionName: string | null;
  proposerName: string | null;
  status: string;
  mode: string;
  note: string;
  nearDuplicateOf: string | null;
}

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

// --- Danh mục + câu hỏi/ngữ liệu theo danh mục ----------------------

export function questionCategoriesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.questionCategories,
    queryFn: () => apiJson<QuestionCategory[]>('/api/v1/questions/categories'),
  });
}

/** Cây danh mục câu hỏi; chỉ tải khi vai có capability ngân hàng. */
export function useQuestionCategories(enabled: boolean) {
  return useQuery({ ...questionCategoriesQueryOptions(), enabled });
}

export function categoryQuestionsQueryOptions(categoryId: string) {
  return queryOptions({
    queryKey: queryKeys.categoryQuestions(categoryId),
    queryFn: () => apiJson<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`),
  });
}

/** Câu hỏi của danh mục đang chọn. */
export function useCategoryQuestions(categoryId: string, enabled: boolean) {
  return useQuery({ ...categoryQuestionsQueryOptions(categoryId), enabled: enabled && !!categoryId });
}

export function categoryStimuliQueryOptions(categoryId: string) {
  return queryOptions({
    queryKey: queryKeys.categoryStimuli(categoryId),
    queryFn: () => apiJson<StimulusView[]>(`/api/v1/stimuli?categoryId=${categoryId}`),
  });
}

/** Ngữ liệu của danh mục đang chọn. */
export function useCategoryStimuli(categoryId: string, enabled: boolean) {
  return useQuery({ ...categoryStimuliQueryOptions(categoryId), enabled: enabled && !!categoryId });
}

// --- Bank theo loại + nội dung bank ----------------------------------

/** Loại bank theo tham số API: câu hỏi (không tham số), ma trận, đề. */
export type BankKindParam = 'question' | 'matrix' | 'exam';

const BANK_KIND_SUFFIX: Record<BankKindParam, string> = {
  question: '',
  matrix: '?kind=matrix',
  exam: '?kind=exam',
};

export function questionBanksQueryOptions(kind: BankKindParam) {
  return queryOptions({
    queryKey: queryKeys.questionBanks(kind),
    queryFn: async () => (await probe<BankLite[]>(`/api/v1/question-banks${BANK_KIND_SUFFIX[kind]}`)) ?? [],
  });
}

/** Danh sách bank của một loại; lỗi tải → rỗng như trước. */
export function useQuestionBanks(kind: BankKindParam) {
  return useQuery(questionBanksQueryOptions(kind));
}

/** Gộp mọi câu hỏi của bank cá nhân theo từng danh mục của bank (danh mục lỗi thì bỏ qua). */
async function fetchMyBankQuestions(bank: BankLite): Promise<QuestionView[]> {
  const all: QuestionView[] = [];
  for (const categoryId of bank.categoryIds) {
    const rows = await probe<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
    if (rows) all.push(...rows);
  }
  return all;
}

/** Mọi câu hỏi trong bank cá nhân (khu "của tôi"); chưa có bank cá nhân thì query tắt. */
export function useMyBankQuestions(bank: BankLite | undefined) {
  return useQuery({
    queryKey: bank
      ? [...queryKeys.myBankQuestions(bank.id), bank.categoryIds.join(',')]
      : ['question-banks', 'none', 'all-questions'],
    queryFn: () => (bank ? fetchMyBankQuestions(bank) : Promise.resolve([] as QuestionView[])),
    enabled: !!bank,
  });
}

export function bankMatricesQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankMatrices(bankId),
    queryFn: async () => (await probe<MatrixLite[]>(`/api/v1/question-banks/${bankId}/matrices`)) ?? [],
  });
}

/** Ma trận của một bank (bank cá nhân hoặc bank chung đang chọn). */
export function useBankMatrices(bankId: string | undefined) {
  return useQuery({ ...bankMatricesQueryOptions(bankId ?? ''), enabled: !!bankId });
}

export function bankMatrixContributionsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankMatrixContributions(bankId),
    queryFn: async () =>
      (await probe<MatrixContributionLite[]>(`/api/v1/question-banks/${bankId}/matrix-contributions?status=pending`)) ?? [],
  });
}

/** Hàng chờ đóng góp ma trận của bank chung đang chọn. */
export function useBankMatrixContributions(bankId: string) {
  return useQuery({ ...bankMatrixContributionsQueryOptions(bankId), enabled: !!bankId });
}

export function bankQuestionContributionsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankQuestionContributions(bankId),
    queryFn: async () =>
      (await probe<ContributionLite[]>(`/api/v1/question-banks/${bankId}/contributions?status=pending`)) ?? [],
  });
}

/** Hàng chờ đóng góp câu hỏi của bank chung đang chọn ở mục khám phá. */
export function useBankQuestionContributions(bankId: string) {
  return useQuery({ ...bankQuestionContributionsQueryOptions(bankId), enabled: !!bankId });
}

export function bankExamsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankExams(bankId),
    queryFn: async () => (await probe<PaperSummaryLite[]>(`/api/v1/exams/banks/${bankId}/exams`)) ?? [],
  });
}

/** Đề của một bank đề (bank cá nhân hoặc bank hệ thống đang chọn). */
export function useBankExams(bankId: string | undefined) {
  return useQuery({ ...bankExamsQueryOptions(bankId ?? ''), enabled: !!bankId });
}

export function bankExamContributionsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankExamContributions(bankId),
    queryFn: async () => (await probe<ExamContributionLite[]>(`/api/v1/exams/banks/${bankId}/contributions`)) ?? [],
  });
}

/** Hàng chờ đóng góp đề của bank hệ thống đang chọn (trang tự lọc pending). */
export function useBankExamContributions(bankId: string) {
  return useQuery({ ...bankExamContributionsQueryOptions(bankId), enabled: !!bankId });
}

export function bankDossiersQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankDossiers(bankId),
    queryFn: async () => (await probe<ExamDossierLite[]>(`/api/v1/exams/banks/${bankId}/dossiers`)) ?? [],
  });
}

/** Hàng chờ bộ hồ sơ của bank hệ thống đang chọn (trang tự lọc trạng thái chờ). */
export function useBankDossiers(bankId: string) {
  return useQuery({ ...bankDossiersQueryOptions(bankId), enabled: !!bankId });
}

export function myDossiersQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.myDossiers,
    queryFn: async () => (await probe<ExamDossierLite[]>('/api/v1/exams/dossiers/mine')) ?? [],
  });
}

/** Mọi bộ hồ sơ của chính giáo viên. */
export function useMyDossiers() {
  return useQuery(myDossiersQueryOptions());
}

// --- Tra cứu một lần (vẫn qua cache TanStack theo khoá factory) -----

export function questionAttributionQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionAttribution(questionId),
    queryFn: () => apiJson<AttributionLite>(`/api/v1/questions/${questionId}/attribution`),
  });
}

export function questionVersionsQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionVersions(questionId),
    queryFn: () =>
      apiJson<{ version: number; questionText: RichTextDocument }[]>(`/api/v1/questions/${questionId}/versions`),
  });
}

export function questionDetailQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionDetail(questionId),
    queryFn: () => apiJson<QuestionView>(`/api/v1/questions/${questionId}`),
  });
}

export function questionDiscoveryQueryOptions(params: string) {
  return queryOptions({
    queryKey: queryKeys.questionDiscovery(params),
    queryFn: () => apiJson<DiscoveryItemLite[]>(`/api/v1/questions/discovery?${params}`),
  });
}

/**
 * Xoá cache các danh sách ngân hàng (danh mục + câu hỏi theo danh
 * mục + bank ba loại) — dùng ở điểm LƯU của màn soạn riêng/tạo
 * danh mục ngay trước khi quay về trang danh sách: danh sách mở
 * lại là nạp tươi (đúng hành vi trước khi hợp nhất TanStack, khi
 * trang danh sách luôn tải lại lúc mở), tránh hiện bản cũ trong
 * lúc refetch nền chạy.
 */
export function clearQuestionBankListCache(client: QueryClient) {
  client.removeQueries({ queryKey: queryKeys.questionCategories });
  client.removeQueries({ queryKey: ['question-banks'] });
}

/**
 * clientLoader dùng chung cho các route module bọc trang ngân
 * hàng (F-01 đợt 1 + bổ sung clientLoader, rà soát #133): prefetch
 * cụm tải lúc mở trang (danh mục + bank ba loại) vào QueryClient
 * singleton. prefetchQuery không ném lỗi.
 */
export async function questionsPageClientLoader() {
  await Promise.all([
    queryClient.prefetchQuery(questionCategoriesQueryOptions()),
    queryClient.prefetchQuery(questionBanksQueryOptions('question')),
    queryClient.prefetchQuery(questionBanksQueryOptions('matrix')),
    queryClient.prefetchQuery(questionBanksQueryOptions('exam')),
  ]);
  return null;
}

// --- Trình soạn câu hỏi: gắn kết chương trình + lưu nội dung (F-01) ------------
//
// Trình soạn là màn điều phối nhiều bước (chọn danh mục → ngữ liệu →
// câu đang sửa → options đầy đủ → gắn kết chương trình): các lượt đọc
// của nó đi qua fetchQuery với các tuỳ chọn dưới đây (vẫn qua bộ nhớ
// đệm + dedupe của TanStack, giữ nguyên nhịp trạng thái tại chỗ của
// màn); thao tác ghi là đột biến, kết quả gắn kết trả thẳng về cho
// màn giữ trong state như bản thủ công.

/** Gắn kết chương trình của một câu hỏi — hình dạng của GET /questions/:id/curriculum-links. */
export interface QuestionCurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}

/** Tuỳ chọn truy vấn gắn kết chương trình của một câu hỏi. */
export function questionCurriculumLinksQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionCurriculumLinks(questionId),
    queryFn: () =>
      apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/curriculum-links`),
  });
}

/** Một version của câu hỏi theo hình dạng trình soạn cần để khôi phục options đầy đủ. */
export interface EditorQuestionVersion {
  id: string;
  version: number;
  options?: Record<string, unknown> | null;
}

/**
 * Tuỳ chọn truy vấn các version của một câu cho trình soạn: dùng
 * chung khoá factory `questionVersions` với trang ngân hàng — hai bề
 * mặt chỉ đọc các trường khác nhau của cùng một đáp ứng.
 */
export function editorQuestionVersionsQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionVersions(questionId),
    queryFn: () => apiJson<EditorQuestionVersion[]>(`/api/v1/questions/${questionId}/versions`),
  });
}

/** Đột biến đưa trạng thái bank của câu về trạng thái đích sau khi lưu nội dung (POST /questions/:id/status, không tạo phiên bản). */
export function useSetQuestionStatus() {
  return useMutation({
    mutationFn: ({ questionId, status }: { questionId: string; status: 'draft' | 'ready' }) =>
      apiJson(`/api/v1/questions/${questionId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      }),
  });
}

/** Đột biến lưu nội dung câu hỏi đang sửa (PATCH /questions/:id — tạo phiên bản mới phía API). */
export function useUpdateQuestionContent() {
  return useMutation({
    mutationFn: ({ questionId, body }: { questionId: string; body: Record<string, unknown> }) =>
      apiJson<QuestionView>(`/api/v1/questions/${questionId}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
  });
}

/** Đột biến tạo câu hỏi mới (POST /questions). */
export function useCreateQuestion() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiJson<QuestionView>('/api/v1/questions', { method: 'POST', body: JSON.stringify(body) }),
  });
}

/** Đột biến gắn một môn chương trình vào câu hỏi (POST /questions/:id/subjects) — trả về toàn bộ gắn kết mới. */
export function useAttachQuestionSubject() {
  return useMutation({
    mutationFn: ({ questionId, subjectId }: { questionId: string; subjectId: string }) =>
      apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/subjects`, {
        method: 'POST',
        body: JSON.stringify({ subjectId }),
      }),
  });
}

/** Đột biến gỡ một môn khỏi gắn kết của câu hỏi (DELETE /questions/:id/subjects/:subjectId). */
export function useDetachQuestionSubject() {
  return useMutation({
    mutationFn: ({ questionId, subjectId }: { questionId: string; subjectId: string }) =>
      apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/subjects/${subjectId}`, {
        method: 'DELETE',
      }),
  });
}

/** Đột biến gắn một YCCĐ vào câu hỏi kèm mức độ nhận thức (POST /questions/:id/outcomes). */
export function useAttachQuestionOutcome() {
  return useMutation({
    mutationFn: ({
      questionId,
      outcomeId,
      cognitiveLevel,
    }: {
      questionId: string;
      outcomeId: string;
      cognitiveLevel: string;
    }) =>
      apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/outcomes`, {
        method: 'POST',
        body: JSON.stringify({ outcomeId, cognitiveLevel }),
      }),
  });
}

/** Đột biến đổi mức độ nhận thức của một gắn kết YCCĐ (PATCH /questions/:id/outcomes/:outcomeId). */
export function useUpdateQuestionOutcomeLink() {
  return useMutation({
    mutationFn: ({
      questionId,
      outcomeId,
      cognitiveLevel,
    }: {
      questionId: string;
      outcomeId: string;
      cognitiveLevel: string;
    }) =>
      apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/outcomes/${outcomeId}`, {
        method: 'PATCH',
        body: JSON.stringify({ cognitiveLevel }),
      }),
  });
}

/** Đột biến gỡ một YCCĐ khỏi gắn kết của câu hỏi (DELETE /questions/:id/outcomes/:outcomeId). */
export function useDetachQuestionOutcome() {
  return useMutation({
    mutationFn: ({ questionId, outcomeId }: { questionId: string; outcomeId: string }) =>
      apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/outcomes/${outcomeId}`, {
        method: 'DELETE',
      }),
  });
}
