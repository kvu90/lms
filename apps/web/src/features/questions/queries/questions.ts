import { queryOptions, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { QuestionView, RichTextDocument } from '@lms/contracts';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  attachQuestionOutcome,
  attachQuestionSubject,
  copyExamPaper,
  copyMatrixToMyBank,
  copyQuestionToMyBank,
  createQuestion,
  createQuestionCategory,
  createQuestionUsage,
  createStimulus,
  deleteBankQuestion,
  deleteExamPaper,
  deleteMatrix,
  deleteStimulus,
  deployExamPin,
  detachQuestionOutcome,
  detachQuestionSubject,
  fetchBankDossiers,
  fetchBankExamContributions,
  fetchBankExams,
  fetchBankMatrices,
  fetchBankMatrixContributions,
  fetchBankQuestionContributions,
  fetchCategoryQuestions,
  fetchCategoryStimuli,
  fetchEditorQuestionVersions,
  fetchExamDossierSpec,
  fetchMyBankQuestions,
  fetchMyDossiers,
  fetchPinnedQuestionVersions,
  fetchQuestionAttribution,
  fetchQuestionBanks,
  fetchQuestionCategories,
  fetchQuestionCurriculumLinks,
  fetchQuestionDetail,
  fetchQuestionDiscovery,
  fetchQuestionUsage,
  fetchQuestionVersions,
  fetchStimulusDetail,
  finishQuestionUsage,
  finishUsageAttempt,
  proposeExamDossierContribution,
  proposeExamPaperContribution,
  proposeMatrixContribution,
  proposeQuestionContribution,
  restoreQuestion,
  reviewExamPaperContribution,
  reviewMatrixContribution,
  reviewQuestionContribution,
  setExamPaperStatus,
  setQuestionStatus,
  startQuestionUsage,
  startUsageAttempt,
  submitUsageAttempt,
  updateQuestionContent,
  updateQuestionOutcomeLink,
  updateStimulus,
  withdrawQuestion,
} from '../api/questions';
import type { BankKindParam, BankLite, ContributionReviewVars } from '../types/questions';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang ngân hàng câu hỏi/đề/ma trận (F-01 đợt 1, rà
 * soát #133): mỗi cụm tải trước đây (danh mục + câu hỏi/ngữ liệu
 * theo danh mục, bank theo loại + nội dung bank cá nhân, hàng chờ
 * đóng góp, bộ hồ sơ, khám phá) là một query theo khoá factory;
 * options dùng chung cho hook của trang và clientLoader của các
 * route module bọc trang.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của questions nằm ở `keys.ts` cùng tầng này, riêng các
 * khoá `questionBanks`, `bankMatrices`, `questionVersions`,
 * `questionDiscovery` là khoá dùng chung ở factory tập trung.
 */

// --- Danh mục + câu hỏi/ngữ liệu theo danh mục ----------------------

export function questionCategoriesQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.questionCategories,
    queryFn: () => fetchQuestionCategories(),
  });
}

/** Cây danh mục câu hỏi; chỉ tải khi vai có capability ngân hàng. */
export function useQuestionCategories(enabled: boolean) {
  return useQuery({ ...questionCategoriesQueryOptions(), enabled });
}

export function categoryQuestionsQueryOptions(categoryId: string) {
  return queryOptions({
    queryKey: queryKeys.categoryQuestions(categoryId),
    queryFn: () => fetchCategoryQuestions(categoryId),
  });
}

/** Câu hỏi của danh mục đang chọn. */
export function useCategoryQuestions(categoryId: string, enabled: boolean) {
  return useQuery({ ...categoryQuestionsQueryOptions(categoryId), enabled: enabled && !!categoryId });
}

export function categoryStimuliQueryOptions(categoryId: string) {
  return queryOptions({
    queryKey: queryKeys.categoryStimuli(categoryId),
    queryFn: () => fetchCategoryStimuli(categoryId),
  });
}

/** Ngữ liệu của danh mục đang chọn. */
export function useCategoryStimuli(categoryId: string, enabled: boolean) {
  return useQuery({ ...categoryStimuliQueryOptions(categoryId), enabled: enabled && !!categoryId });
}

// --- Bank theo loại + nội dung bank ----------------------------------

export function questionBanksQueryOptions(kind: BankKindParam) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionBanks(kind),
    queryFn: async () => (await fetchQuestionBanks(kind)) ?? [],
  });
}

/** Danh sách bank của một loại; lỗi tải → rỗng như trước. */
export function useQuestionBanks(kind: BankKindParam) {
  return useQuery(questionBanksQueryOptions(kind));
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
    queryKey: sharedQueryKeys.bankMatrices(bankId),
    queryFn: async () => (await fetchBankMatrices(bankId)) ?? [],
  });
}

/** Ma trận của một bank (bank cá nhân hoặc bank chung đang chọn). */
export function useBankMatrices(bankId: string | undefined) {
  return useQuery({ ...bankMatricesQueryOptions(bankId ?? ''), enabled: !!bankId });
}

export function bankMatrixContributionsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankMatrixContributions(bankId),
    queryFn: async () => (await fetchBankMatrixContributions(bankId)) ?? [],
  });
}

/** Hàng chờ đóng góp ma trận của bank chung đang chọn. */
export function useBankMatrixContributions(bankId: string) {
  return useQuery({ ...bankMatrixContributionsQueryOptions(bankId), enabled: !!bankId });
}

export function bankQuestionContributionsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankQuestionContributions(bankId),
    queryFn: async () => (await fetchBankQuestionContributions(bankId)) ?? [],
  });
}

/** Hàng chờ đóng góp câu hỏi của bank chung đang chọn ở mục khám phá. */
export function useBankQuestionContributions(bankId: string) {
  return useQuery({ ...bankQuestionContributionsQueryOptions(bankId), enabled: !!bankId });
}

export function bankExamsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankExams(bankId),
    queryFn: async () => (await fetchBankExams(bankId)) ?? [],
  });
}

/** Đề của một bank đề (bank cá nhân hoặc bank hệ thống đang chọn). */
export function useBankExams(bankId: string | undefined) {
  return useQuery({ ...bankExamsQueryOptions(bankId ?? ''), enabled: !!bankId });
}

export function bankExamContributionsQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankExamContributions(bankId),
    queryFn: async () => (await fetchBankExamContributions(bankId)) ?? [],
  });
}

/** Hàng chờ đóng góp đề của bank hệ thống đang chọn (trang tự lọc pending). */
export function useBankExamContributions(bankId: string) {
  return useQuery({ ...bankExamContributionsQueryOptions(bankId), enabled: !!bankId });
}

export function bankDossiersQueryOptions(bankId: string) {
  return queryOptions({
    queryKey: queryKeys.bankDossiers(bankId),
    queryFn: async () => (await fetchBankDossiers(bankId)) ?? [],
  });
}

/** Hàng chờ bộ hồ sơ của bank hệ thống đang chọn (trang tự lọc trạng thái chờ). */
export function useBankDossiers(bankId: string) {
  return useQuery({ ...bankDossiersQueryOptions(bankId), enabled: !!bankId });
}

export function myDossiersQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.myDossiers,
    queryFn: async () => (await fetchMyDossiers()) ?? [],
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
    queryFn: () => fetchQuestionAttribution(questionId),
  });
}

export function questionVersionsQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionVersions(questionId),
    queryFn: () => fetchQuestionVersions(questionId),
  });
}

export function questionDetailQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionDetail(questionId),
    queryFn: () => fetchQuestionDetail(questionId),
  });
}

export function questionDiscoveryQueryOptions(params: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionDiscovery(params),
    queryFn: () => fetchQuestionDiscovery(params),
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
  client.removeQueries({ queryKey: queryKeys.questionBanksRoot });
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

/** Tuỳ chọn truy vấn gắn kết chương trình của một câu hỏi. */
export function questionCurriculumLinksQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: queryKeys.questionCurriculumLinks(questionId),
    queryFn: () => fetchQuestionCurriculumLinks(questionId),
  });
}

/**
 * Tuỳ chọn truy vấn các version của một câu cho trình soạn: dùng
 * chung khoá factory `questionVersions` với trang ngân hàng — hai bề
 * mặt chỉ đọc các trường khác nhau của cùng một đáp ứng.
 */
export function editorQuestionVersionsQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionVersions(questionId),
    queryFn: () => fetchEditorQuestionVersions(questionId),
  });
}

/** Đột biến đưa trạng thái bank của câu về trạng thái đích sau khi lưu nội dung (POST /questions/:id/status, không tạo phiên bản). */
export function useSetQuestionStatus() {
  return useMutation({
    mutationFn: ({ questionId, status }: { questionId: string; status: 'draft' | 'ready' }) =>
      setQuestionStatus(questionId, status),
  });
}

/** Đột biến lưu nội dung câu hỏi đang sửa (PATCH /questions/:id — tạo phiên bản mới phía API). */
export function useUpdateQuestionContent() {
  return useMutation({
    mutationFn: ({ questionId, body }: { questionId: string; body: Record<string, unknown> }) =>
      updateQuestionContent(questionId, body),
  });
}

/** Đột biến tạo câu hỏi mới (POST /questions). */
export function useCreateQuestion() {
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => createQuestion(body),
  });
}

/** Đột biến gắn một môn chương trình vào câu hỏi (POST /questions/:id/subjects) — trả về toàn bộ gắn kết mới. */
export function useAttachQuestionSubject() {
  return useMutation({
    mutationFn: ({ questionId, subjectId }: { questionId: string; subjectId: string }) =>
      attachQuestionSubject(questionId, subjectId),
  });
}

/** Đột biến gỡ một môn khỏi gắn kết của câu hỏi (DELETE /questions/:id/subjects/:subjectId). */
export function useDetachQuestionSubject() {
  return useMutation({
    mutationFn: ({ questionId, subjectId }: { questionId: string; subjectId: string }) =>
      detachQuestionSubject(questionId, subjectId),
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
    }) => attachQuestionOutcome(questionId, outcomeId, cognitiveLevel),
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
    }) => updateQuestionOutcomeLink(questionId, outcomeId, cognitiveLevel),
  });
}

/** Đột biến gỡ một YCCĐ khỏi gắn kết của câu hỏi (DELETE /questions/:id/outcomes/:outcomeId). */
export function useDetachQuestionOutcome() {
  return useMutation({
    mutationFn: ({ questionId, outcomeId }: { questionId: string; outcomeId: string }) =>
      detachQuestionOutcome(questionId, outcomeId),
  });
}

// --- Thao tác ghi của trang ngân hàng + trang làm thử (F-01) --------------------
//
// Các đột biến dưới đây KHÔNG tự làm mới danh sách: trang ngân hàng
// có sẵn các hàm refresh* theo cụm (đích làm mới phụ thuộc bank đang
// chọn của trang) và giữ nguyên quyền quyết định đó sau mỗi thao
// tác, đúng như bản thủ công. Riêng các thao tác của trang làm thử
// (usage) thì làm mới đúng khoá usage — trang nạp lại usage sau mỗi
// thao tác như reload() thủ công của nó.

/** Đột biến copy một ma trận chung về ngân hàng ma trận cá nhân (POST /exam-matrices/:id/copy). */
export function useCopyMatrixToMyBank() {
  return useMutation({
    mutationFn: (matrixId: string) => copyMatrixToMyBank(matrixId),
  });
}

/** Đột biến xoá một ma trận của mình (DELETE /exam-matrices/:id). */
export function useDeleteMatrix() {
  return useMutation({
    mutationFn: (matrixId: string) => deleteMatrix(matrixId),
  });
}

/** Đột biến đề xuất đóng góp một ma trận ready lên bank ma trận chung (POST /exam-matrices/:id/contributions). */
export function useProposeMatrixContribution() {
  return useMutation({
    mutationFn: ({ matrixId, targetBankId }: { matrixId: string; targetBankId: string }) =>
      proposeMatrixContribution(matrixId, targetBankId),
  });
}

/** Đột biến duyệt/từ chối một đóng góp ma trận tại bank đích (POST /question-banks/:bankId/matrix-contributions/:id/approve|reject). */
export function useReviewMatrixContribution() {
  return useMutation({
    mutationFn: ({ bankId, ...vars }: ContributionReviewVars & { bankId: string }) =>
      reviewMatrixContribution(bankId, vars),
  });
}

/**
 * Đột biến nộp BỘ HỒ SƠ của một đề lên bank đích: từ S4/Q4 (issue
 * #228) bộ hồ sơ không còn đường ghi riêng (mọi thao tác ghi trên bề
 * mặt hồ sơ đã đóng) — đây là ĐỀ XUẤT ĐÓNG GÓP kèm bộ hồ sơ đính kèm
 * (`withDossier: true`) trên ĐƯỜNG ĐÓNG GÓP DUY NHẤT của đề
 * (POST /exams/banks/:bankId/contributions, trường định danh theo
 * hợp đồng là `examId`); phía API ghim bộ ba (version đề + version ma
 * trận + bản đặc tả) tại đúng lúc đề xuất.
 */
export function useProposeExamDossierContribution() {
  return useMutation({
    mutationFn: ({ bankId, examId }: { bankId: string; examId: string }) =>
      proposeExamDossierContribution(bankId, examId),
  });
}

/** Tuỳ chọn truy vấn bản đặc tả đã chụp của một bộ hồ sơ (GET /exams/dossiers/:id/specification) — đọc theo yêu cầu qua fetchQuery. */
export function examDossierSpecQueryOptions(dossierId: string) {
  return queryOptions({
    queryKey: queryKeys.examDossierSpec(dossierId),
    queryFn: () => fetchExamDossierSpec(dossierId),
  });
}

/** Đột biến copy một đề từ ngân hàng hệ thống về ngân hàng đề cá nhân (POST /exams/:id/copy). */
export function useCopyExamPaper() {
  return useMutation({
    mutationFn: (paperId: string) => copyExamPaper(paperId),
  });
}

/** Đột biến đặt trạng thái của một đề (POST /exams/:id/status). */
export function useSetExamPaperStatus() {
  return useMutation({
    mutationFn: ({ paperId, status }: { paperId: string; status: 'ready' | 'hidden' | 'draft' }) =>
      setExamPaperStatus(paperId, status),
  });
}

/** Đột biến xoá một đề (DELETE /exams/:id). */
export function useDeleteExamPaper() {
  return useMutation({
    mutationFn: (paperId: string) => deleteExamPaper(paperId),
  });
}

/** Đột biến đề xuất một đề của tôi lên bank đề chung (POST /exams/banks/:bankId/contributions, khuôn QB-4; trường định danh theo hợp đồng là `examId`). */
export function useProposeExamPaperContribution() {
  return useMutation({
    mutationFn: ({ bankId, paperId }: { bankId: string; paperId: string }) =>
      proposeExamPaperContribution(bankId, paperId),
  });
}

/**
 * Đột biến một mốc duyệt của đóng góp đề tại bank đích
 * (POST /exams/banks/:bankId/contributions/:id/<action>): chỉ còn
 * hai động từ `approve`/`reject` (issue #345, giai đoạn 2) — cấp
 * duyệt do phía server phân biệt bằng trạng thái đóng góp và quyền
 * của người gọi (đóng góp `pending` → cấp 1, đóng góp
 * `pending_board` do ban giám hiệu gọi → cấp 2; trạng thái này chỉ
 * đóng góp kèm bộ hồ sơ mới lên được, theo Q4 của issue #228);
 * từ chối ở cả hai cấp đều kèm lý do.
 */
export function useReviewExamPaperContribution() {
  return useMutation({
    mutationFn: (input: {
      bankId: string;
      contributionId: string;
      action: 'approve' | 'reject';
      reason?: string;
    }) => reviewExamPaperContribution(input),
  });
}

/** Đột biến ghim một đề vào một khoá (POST /courses/:courseId/exam-pins) — trả về id lần ghim để điều hướng. */
export function useDeployExamPin() {
  return useMutation({
    mutationFn: ({ courseId, body }: { courseId: string; body: Record<string, unknown> }) =>
      deployExamPin(courseId, body),
  });
}

/** Đột biến copy một câu về ngân hàng cá nhân (POST /questions/:id/copy). */
export function useCopyQuestionToMyBank() {
  return useMutation({
    mutationFn: (questionId: string) => copyQuestionToMyBank(questionId),
  });
}

/** Đột biến đề xuất đóng góp một câu lên một bank chung (POST /question-banks/:bankId/contributions). */
export function useProposeQuestionContribution() {
  return useMutation({
    mutationFn: ({ bankId, questionId }: { bankId: string; questionId: string }) =>
      proposeQuestionContribution(bankId, questionId),
  });
}

/** Đột biến duyệt/từ chối một đóng góp câu hỏi tại bank đích (POST /question-banks/:bankId/contributions/:id/approve|reject). */
export function useReviewQuestionContribution() {
  return useMutation({
    mutationFn: ({ bankId, ...vars }: ContributionReviewVars & { bankId: string }) =>
      reviewQuestionContribution(bankId, vars),
  });
}

/** Đột biến xoá vật lý một câu (DELETE /questions/:id) — API chặn khi câu đã được dùng. */
export function useDeleteBankQuestion() {
  return useMutation({
    mutationFn: (questionId: string) => deleteBankQuestion(questionId),
  });
}

/** Đột biến hoàn rút một câu về bank của nó (POST /questions/:id/restore). */
export function useRestoreQuestion() {
  return useMutation({
    mutationFn: (questionId: string) => restoreQuestion(questionId),
  });
}

/** Đột biến rút một câu khỏi bank của nó, kèm lý do bắt buộc (POST /questions/:id/withdraw). */
export function useWithdrawQuestion() {
  return useMutation({
    mutationFn: ({ questionId, reason }: { questionId: string; reason: string }) =>
      withdrawQuestion(questionId, reason),
  });
}

/** Đột biến sửa nội dung một ngữ liệu (PATCH /stimuli/:id) — thân `content` gửi nguyên như trang soạn (chuỗi thuần hoặc tài liệu rich-text). */
export function useUpdateStimulus() {
  return useMutation({
    mutationFn: ({ stimulusId, content }: { stimulusId: string; content: RichTextDocument | string }) =>
      updateStimulus(stimulusId, content),
  });
}

/** Đột biến tạo ngữ liệu mới trong danh mục (POST /stimuli) — thân `content` gửi nguyên như trang soạn. */
export function useCreateStimulus() {
  return useMutation({
    mutationFn: ({ categoryId, content }: { categoryId: string; content: RichTextDocument | string }) =>
      createStimulus(categoryId, content),
  });
}

/** Đột biến xoá một ngữ liệu (DELETE /stimuli/:id). */
export function useDeleteStimulus() {
  return useMutation({
    mutationFn: (stimulusId: string) => deleteStimulus(stimulusId),
  });
}

/** Đột biến tạo danh mục câu hỏi (POST /questions/categories) ở màn tạo riêng. */
export function useCreateQuestionCategory() {
  return useMutation({
    mutationFn: (body: { name: string; contextId: string }) => createQuestionCategory(body),
  });
}

/** Đột biến tạo lượt làm bài từ các câu đã chọn (POST /question-usages) — trả về usage để điều hướng sang trang làm thử. */
export function useCreateQuestionUsage() {
  return useMutation({
    mutationFn: (body: { component: string; slots: { questionId: string }[] }) => createQuestionUsage(body),
  });
}

// --- Trang làm thử câu hỏi (usage) ----------------------------------------------

/** Tuỳ chọn truy vấn một lượt dùng câu hỏi (GET /question-usages/:id). */
export function questionUsageQueryOptions(usageId: string) {
  return queryOptions({
    queryKey: queryKeys.questionUsage(usageId),
    queryFn: () => fetchQuestionUsage(usageId),
  });
}

/** Hook đọc usage cho trang làm thử; chỉ bật khi đã qua cổng vai của trang. */
export function useQuestionUsage(usageId: string, enabled: boolean) {
  return useQuery({ ...questionUsageQueryOptions(usageId), enabled });
}

/**
 * Tuỳ chọn truy vấn các version của một câu cho trang làm thử: dùng
 * chung khoá factory `questionVersions` — bề mặt này đọc thêm id và
 * stimulusId của cùng một đáp ứng.
 */
export function pinnedQuestionVersionsQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionVersions(questionId),
    queryFn: () => fetchPinnedQuestionVersions(questionId),
  });
}

/** Tuỳ chọn truy vấn một ngữ liệu theo id (GET /stimuli/:id) — nội dung gắn với phiên bản đã ghim. */
export function stimulusDetailQueryOptions(stimulusId: string) {
  return queryOptions({
    queryKey: queryKeys.stimulusDetail(stimulusId),
    queryFn: () => fetchStimulusDetail(stimulusId),
  });
}

/** Dựng một đột biến thao tác usage: thành công thì làm mới đúng khoá usage (trang nạp lại state/fraction mới nhất). */
function useUsageAction<TVars>(mutationFn: (vars: TVars) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_data, vars) => {
      const usageId = (vars as { usageId: string }).usageId;
      void client.invalidateQueries({ queryKey: queryKeys.questionUsage(usageId) });
    },
  });
}

/** Đột biến bắt đầu một usage (POST /question-usages/:id/start). */
export function useStartQuestionUsage() {
  return useUsageAction((vars: { usageId: string }) => startQuestionUsage(vars.usageId));
}

/** Đột biến kết thúc một usage (POST /question-usages/:id/finish) — điểm của mọi attempt được chốt. */
export function useFinishQuestionUsage() {
  return useUsageAction((vars: { usageId: string }) => finishQuestionUsage(vars.usageId));
}

/** Đột biến bắt đầu một attempt trong usage (POST /question-usages/:id/attempts/:attemptId/start). */
export function useStartUsageAttempt() {
  return useUsageAction((vars: { usageId: string; attemptId: string }) =>
    startUsageAttempt(vars.usageId, vars.attemptId),
  );
}

/** Đột biến nộp đáp án của một attempt (POST .../attempts/:attemptId/submit) — deferredfeedback: chỉ ghi step, chưa chốt điểm. */
export function useSubmitUsageAttempt() {
  return useUsageAction((vars: { usageId: string; attemptId: string; response: string | null }) =>
    submitUsageAttempt(vars.usageId, vars.attemptId, vars.response),
  );
}

/** Đột biến kết thúc một attempt (POST .../attempts/:attemptId/finish) — fraction của attempt được chốt. */
export function useFinishUsageAttempt() {
  return useUsageAction((vars: { usageId: string; attemptId: string }) =>
    finishUsageAttempt(vars.usageId, vars.attemptId),
  );
}
