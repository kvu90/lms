import type {
  QuestionCategory, QuestionUsage, QuestionView, RichTextDocument, StimulusView,
} from '@lms/contracts';
import { apiJson } from '#lib/api';
import type {
  AttributionLite,
  BankKindParam,
  BankLite,
  ContributionLite,
  ContributionReviewVars,
  DiscoveryItemLite,
  DossierSpecLite,
  EditorQuestionVersion,
  ExamContributionLite,
  ExamDossierLite,
  MatrixContributionLite,
  MatrixLite,
  PaperSummaryLite,
  PinnedQuestionVersion,
  QuestionCurriculumLinksView,
} from '../types/questions';

/**
 * Tầng gọi API thuần của shell ngân hàng câu hỏi/đề/ma trận thuộc
 * feature questions: chỉ chứa các hàm gọi HTTP, không phụ thuộc
 * React hay React Query. Tầng `queries/` của feature bọc các hàm
 * này thành queryOptions, hook và đột biến. Tách từ module dữ
 * liệu phẳng `src/lib/questions-data.ts` khi tổ chức lại apps/web
 * theo mô hình features/ (issue #500).
 */

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

// --- Danh mục + câu hỏi/ngữ liệu theo danh mục ----------------------

/**
 * Đọc cây danh mục câu hỏi (GET /questions/categories).
 *
 * @returns Danh sách danh mục.
 */
export function fetchQuestionCategories() {
  return apiJson<QuestionCategory[]>('/api/v1/questions/categories');
}

/**
 * Đọc câu hỏi của một danh mục (GET /questions/categories/:id/questions).
 *
 * @param categoryId - Định danh danh mục.
 * @returns Danh sách câu hỏi.
 */
export function fetchCategoryQuestions(categoryId: string) {
  return apiJson<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
}

/**
 * Đọc ngữ liệu của một danh mục (GET /stimuli?categoryId=).
 *
 * @param categoryId - Định danh danh mục.
 * @returns Danh sách ngữ liệu.
 */
export function fetchCategoryStimuli(categoryId: string) {
  return apiJson<StimulusView[]>(`/api/v1/stimuli?categoryId=${categoryId}`);
}

// --- Bank theo loại + nội dung bank ----------------------------------

const BANK_KIND_SUFFIX: Record<BankKindParam, string> = {
  question: '',
  matrix: '?kind=matrix',
  exam: '?kind=exam',
};

/**
 * Đọc danh sách bank của một loại (GET /question-banks, probe):
 * lỗi tải → null, tầng queries hạ cấp thành danh sách rỗng.
 *
 * @param kind - Loại bank.
 * @returns Danh sách bank hoặc null.
 */
export function fetchQuestionBanks(kind: BankKindParam) {
  return probe<BankLite[]>(`/api/v1/question-banks${BANK_KIND_SUFFIX[kind]}`);
}

/** Gộp mọi câu hỏi của bank cá nhân theo từng danh mục của bank (danh mục lỗi thì bỏ qua). */
export async function fetchMyBankQuestions(bank: BankLite): Promise<QuestionView[]> {
  const all: QuestionView[] = [];
  for (const categoryId of bank.categoryIds) {
    const rows = await probe<QuestionView[]>(`/api/v1/questions/categories/${categoryId}/questions`);
    if (rows) all.push(...rows);
  }
  return all;
}

/**
 * Đọc ma trận của một bank (GET /question-banks/:id/matrices, probe).
 *
 * @param bankId - Định danh bank.
 * @returns Danh sách ma trận hoặc null khi lỗi tải.
 */
export function fetchBankMatrices(bankId: string) {
  return probe<MatrixLite[]>(`/api/v1/question-banks/${bankId}/matrices`);
}

/**
 * Đọc hàng chờ đóng góp ma trận của bank (GET /question-banks/:id/matrix-contributions?status=pending, probe).
 *
 * @param bankId - Định danh bank.
 * @returns Danh sách đóng góp hoặc null khi lỗi tải.
 */
export function fetchBankMatrixContributions(bankId: string) {
  return probe<MatrixContributionLite[]>(`/api/v1/question-banks/${bankId}/matrix-contributions?status=pending`);
}

/**
 * Đọc hàng chờ đóng góp câu hỏi của bank (GET /question-banks/:id/contributions?status=pending, probe).
 *
 * @param bankId - Định danh bank.
 * @returns Danh sách đóng góp hoặc null khi lỗi tải.
 */
export function fetchBankQuestionContributions(bankId: string) {
  return probe<ContributionLite[]>(`/api/v1/question-banks/${bankId}/contributions?status=pending`);
}

/**
 * Đọc đề của một bank đề (GET /exams/banks/:id/exams, probe).
 *
 * @param bankId - Định danh bank.
 * @returns Danh sách đề hoặc null khi lỗi tải.
 */
export function fetchBankExams(bankId: string) {
  return probe<PaperSummaryLite[]>(`/api/v1/exams/banks/${bankId}/exams`);
}

/**
 * Đọc hàng chờ đóng góp đề của bank (GET /exams/banks/:id/contributions, probe).
 *
 * @param bankId - Định danh bank.
 * @returns Danh sách đóng góp đề hoặc null khi lỗi tải.
 */
export function fetchBankExamContributions(bankId: string) {
  return probe<ExamContributionLite[]>(`/api/v1/exams/banks/${bankId}/contributions`);
}

/**
 * Đọc hàng chờ bộ hồ sơ của bank (GET /exams/banks/:id/dossiers, probe).
 *
 * @param bankId - Định danh bank.
 * @returns Danh sách bộ hồ sơ hoặc null khi lỗi tải.
 */
export function fetchBankDossiers(bankId: string) {
  return probe<ExamDossierLite[]>(`/api/v1/exams/banks/${bankId}/dossiers`);
}

/**
 * Đọc mọi bộ hồ sơ của chính giáo viên (GET /exams/dossiers/mine, probe).
 *
 * @returns Danh sách bộ hồ sơ hoặc null khi lỗi tải.
 */
export function fetchMyDossiers() {
  return probe<ExamDossierLite[]>('/api/v1/exams/dossiers/mine');
}

// --- Tra cứu một lần --------------------------------------------------

/**
 * Đọc dòng ghi công của một câu copy (GET /questions/:id/attribution).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Dòng ghi công.
 */
export function fetchQuestionAttribution(questionId: string) {
  return apiJson<AttributionLite>(`/api/v1/questions/${questionId}/attribution`);
}

/**
 * Đọc các version của một câu theo hình dạng trang ngân hàng
 * (GET /questions/:id/versions).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Danh sách version (số version + nội dung).
 */
export function fetchQuestionVersions(questionId: string) {
  return apiJson<{ version: number; questionText: RichTextDocument }[]>(`/api/v1/questions/${questionId}/versions`);
}

/**
 * Đọc chi tiết một câu hỏi (GET /questions/:id).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Chi tiết câu hỏi.
 */
export function fetchQuestionDetail(questionId: string) {
  return apiJson<QuestionView>(`/api/v1/questions/${questionId}`);
}

/**
 * Khám phá ngân hàng chung theo chuỗi tham số đã chốt
 * (GET /questions/discovery).
 *
 * @param params - Chuỗi tham số truy vấn.
 * @returns Danh sách dòng khám phá.
 */
export function fetchQuestionDiscovery(params: string) {
  return apiJson<DiscoveryItemLite[]>(`/api/v1/questions/discovery?${params}`);
}

// --- Trình soạn câu hỏi: gắn kết chương trình + lưu nội dung ----------

/**
 * Đọc gắn kết chương trình của một câu hỏi (GET /questions/:id/curriculum-links).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Gắn kết chương trình.
 */
export function fetchQuestionCurriculumLinks(questionId: string) {
  return apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/curriculum-links`);
}

/**
 * Đọc các version của một câu theo hình dạng trình soạn
 * (GET /questions/:id/versions).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Danh sách version kèm options.
 */
export function fetchEditorQuestionVersions(questionId: string) {
  return apiJson<EditorQuestionVersion[]>(`/api/v1/questions/${questionId}/versions`);
}

/**
 * Đưa trạng thái bank của câu về trạng thái đích sau khi lưu nội
 * dung (POST /questions/:id/status, không tạo phiên bản).
 *
 * @param questionId - Định danh câu hỏi.
 * @param status - Trạng thái đích.
 * @returns Đáp ứng của API.
 */
export function setQuestionStatus(questionId: string, status: 'draft' | 'ready') {
  return apiJson(`/api/v1/questions/${questionId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

/**
 * Lưu nội dung câu hỏi đang sửa (PATCH /questions/:id — tạo phiên bản mới phía API).
 *
 * @param questionId - Định danh câu hỏi.
 * @param body - Thân nội dung.
 * @returns Câu hỏi sau khi lưu.
 */
export function updateQuestionContent(questionId: string, body: Record<string, unknown>) {
  return apiJson<QuestionView>(`/api/v1/questions/${questionId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

/**
 * Tạo câu hỏi mới (POST /questions).
 *
 * @param body - Thân nội dung.
 * @returns Câu hỏi vừa tạo.
 */
export function createQuestion(body: Record<string, unknown>) {
  return apiJson<QuestionView>('/api/v1/questions', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Gắn một môn chương trình vào câu hỏi (POST /questions/:id/subjects).
 *
 * @param questionId - Định danh câu hỏi.
 * @param subjectId - Định danh môn.
 * @returns Toàn bộ gắn kết mới.
 */
export function attachQuestionSubject(questionId: string, subjectId: string) {
  return apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/subjects`, {
    method: 'POST',
    body: JSON.stringify({ subjectId }),
  });
}

/**
 * Gỡ một môn khỏi gắn kết của câu hỏi (DELETE /questions/:id/subjects/:subjectId).
 *
 * @param questionId - Định danh câu hỏi.
 * @param subjectId - Định danh môn.
 * @returns Toàn bộ gắn kết mới.
 */
export function detachQuestionSubject(questionId: string, subjectId: string) {
  return apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/subjects/${subjectId}`, {
    method: 'DELETE',
  });
}

/**
 * Gắn một YCCĐ vào câu hỏi kèm mức độ nhận thức (POST /questions/:id/outcomes).
 *
 * @param questionId - Định danh câu hỏi.
 * @param outcomeId - Định danh YCCĐ.
 * @param cognitiveLevel - Mức độ nhận thức.
 * @returns Toàn bộ gắn kết mới.
 */
export function attachQuestionOutcome(questionId: string, outcomeId: string, cognitiveLevel: string) {
  return apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/outcomes`, {
    method: 'POST',
    body: JSON.stringify({ outcomeId, cognitiveLevel }),
  });
}

/**
 * Đổi mức độ nhận thức của một gắn kết YCCĐ (PATCH /questions/:id/outcomes/:outcomeId).
 *
 * @param questionId - Định danh câu hỏi.
 * @param outcomeId - Định danh YCCĐ.
 * @param cognitiveLevel - Mức độ nhận thức mới.
 * @returns Toàn bộ gắn kết mới.
 */
export function updateQuestionOutcomeLink(questionId: string, outcomeId: string, cognitiveLevel: string) {
  return apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/outcomes/${outcomeId}`, {
    method: 'PATCH',
    body: JSON.stringify({ cognitiveLevel }),
  });
}

/**
 * Gỡ một YCCĐ khỏi gắn kết của câu hỏi (DELETE /questions/:id/outcomes/:outcomeId).
 *
 * @param questionId - Định danh câu hỏi.
 * @param outcomeId - Định danh YCCĐ.
 * @returns Toàn bộ gắn kết mới.
 */
export function detachQuestionOutcome(questionId: string, outcomeId: string) {
  return apiJson<QuestionCurriculumLinksView>(`/api/v1/questions/${questionId}/outcomes/${outcomeId}`, {
    method: 'DELETE',
  });
}

// --- Thao tác ghi của trang ngân hàng + trang làm thử -----------------

/**
 * Copy một ma trận chung về ngân hàng ma trận cá nhân (POST /exam-matrices/:id/copy).
 *
 * @param matrixId - Định danh ma trận.
 * @returns Đáp ứng của API.
 */
export function copyMatrixToMyBank(matrixId: string) {
  return apiJson(`/api/v1/exam-matrices/${matrixId}/copy`, { method: 'POST', body: '{}' });
}

/**
 * Xoá một ma trận của mình (DELETE /exam-matrices/:id).
 *
 * @param matrixId - Định danh ma trận.
 * @returns Đáp ứng của API.
 */
export function deleteMatrix(matrixId: string) {
  return apiJson(`/api/v1/exam-matrices/${matrixId}`, { method: 'DELETE' });
}

/**
 * Đề xuất đóng góp một ma trận ready lên bank ma trận chung (POST /exam-matrices/:id/contributions).
 *
 * @param matrixId - Định danh ma trận.
 * @param targetBankId - Định danh bank đích.
 * @returns Đáp ứng của API.
 */
export function proposeMatrixContribution(matrixId: string, targetBankId: string) {
  return apiJson(`/api/v1/exam-matrices/${matrixId}/contributions`, {
    method: 'POST',
    body: JSON.stringify({ targetBankId }),
  });
}

/**
 * Duyệt/từ chối một đóng góp ma trận tại bank đích (POST /question-banks/:bankId/matrix-contributions/:id/approve|reject).
 *
 * @param bankId - Định danh bank đích.
 * @param vars - Đóng góp và quyết định.
 * @returns Đáp ứng của API.
 */
export function reviewMatrixContribution(bankId: string, vars: ContributionReviewVars) {
  return vars.approve
    ? apiJson(`/api/v1/question-banks/${bankId}/matrix-contributions/${vars.contributionId}/approve`, {
        method: 'POST',
        body: '{}',
      })
    : apiJson(`/api/v1/question-banks/${bankId}/matrix-contributions/${vars.contributionId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: vars.reason ?? '' }),
      });
}

/**
 * Nộp BỘ HỒ SƠ của một đề lên bank đích qua đường đóng góp duy
 * nhất kèm bộ hồ sơ đính kèm (POST /exams/banks/:bankId/contributions
 * với `withDossier: true`).
 *
 * @param bankId - Định danh bank đích.
 * @param examId - Định danh đề.
 * @returns Đáp ứng của API.
 */
export function proposeExamDossierContribution(bankId: string, examId: string) {
  return apiJson(`/api/v1/exams/banks/${bankId}/contributions`, {
    method: 'POST',
    body: JSON.stringify({ examId, withDossier: true }),
  });
}

/**
 * Đọc bản đặc tả đã chụp của một bộ hồ sơ (GET /exams/dossiers/:id/specification).
 *
 * @param dossierId - Định danh bộ hồ sơ.
 * @returns Bản đặc tả đã chụp.
 */
export function fetchExamDossierSpec(dossierId: string) {
  return apiJson<DossierSpecLite>(`/api/v1/exams/dossiers/${dossierId}/specification`);
}

/**
 * Copy một đề từ ngân hàng hệ thống về ngân hàng đề cá nhân (POST /exams/:id/copy).
 *
 * @param paperId - Định danh đề.
 * @returns Đáp ứng của API.
 */
export function copyExamPaper(paperId: string) {
  return apiJson(`/api/v1/exams/${paperId}/copy`, { method: 'POST', body: '{}' });
}

/**
 * Đặt trạng thái của một đề (POST /exams/:id/status).
 *
 * @param paperId - Định danh đề.
 * @param status - Trạng thái đích.
 * @returns Đáp ứng của API.
 */
export function setExamPaperStatus(paperId: string, status: 'ready' | 'hidden' | 'draft') {
  return apiJson(`/api/v1/exams/${paperId}/status`, {
    method: 'POST',
    body: JSON.stringify({ status }),
  });
}

/**
 * Xoá một đề (DELETE /exams/:id).
 *
 * @param paperId - Định danh đề.
 * @returns Đáp ứng của API.
 */
export function deleteExamPaper(paperId: string) {
  return apiJson(`/api/v1/exams/${paperId}`, { method: 'DELETE' });
}

/**
 * Đề xuất một đề của tôi lên bank đề chung (POST /exams/banks/:bankId/contributions).
 *
 * @param bankId - Định danh bank đích.
 * @param paperId - Định danh đề.
 * @returns Đáp ứng của API.
 */
export function proposeExamPaperContribution(bankId: string, paperId: string) {
  return apiJson(`/api/v1/exams/banks/${bankId}/contributions`, {
    method: 'POST',
    body: JSON.stringify({ examId: paperId }),
  });
}

/**
 * Một mốc duyệt của đóng góp đề tại bank đích (POST /exams/banks/:bankId/contributions/:id/<action>).
 *
 * @param input - Bank đích, đóng góp, động từ và lý do (khi từ chối).
 * @returns Đáp ứng của API.
 */
export function reviewExamPaperContribution(input: {
  bankId: string;
  contributionId: string;
  action: 'approve' | 'reject';
  reason?: string;
}) {
  return input.action === 'approve'
    ? apiJson(`/api/v1/exams/banks/${input.bankId}/contributions/${input.contributionId}/${input.action}`, {
        method: 'POST',
        body: '{}',
      })
    : apiJson(`/api/v1/exams/banks/${input.bankId}/contributions/${input.contributionId}/${input.action}`, {
        method: 'POST',
        body: JSON.stringify({ reason: input.reason ?? '' }),
      });
}

/**
 * Ghim một đề vào một khoá (POST /courses/:courseId/exam-pins).
 *
 * @param courseId - Định danh khoá.
 * @param body - Thân ghim.
 * @returns Id lần ghim để điều hướng.
 */
export function deployExamPin(courseId: string, body: Record<string, unknown>) {
  return apiJson<{ id: string }>(`/api/v1/courses/${courseId}/exam-pins`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Copy một câu về ngân hàng cá nhân (POST /questions/:id/copy).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Đáp ứng của API.
 */
export function copyQuestionToMyBank(questionId: string) {
  return apiJson(`/api/v1/questions/${questionId}/copy`, { method: 'POST', body: '{}' });
}

/**
 * Đề xuất đóng góp một câu lên một bank chung (POST /question-banks/:bankId/contributions).
 *
 * @param bankId - Định danh bank đích.
 * @param questionId - Định danh câu hỏi.
 * @returns Đáp ứng của API.
 */
export function proposeQuestionContribution(bankId: string, questionId: string) {
  return apiJson(`/api/v1/question-banks/${bankId}/contributions`, {
    method: 'POST',
    body: JSON.stringify({ questionId }),
  });
}

/**
 * Duyệt/từ chối một đóng góp câu hỏi tại bank đích (POST /question-banks/:bankId/contributions/:id/approve|reject).
 *
 * @param bankId - Định danh bank đích.
 * @param vars - Đóng góp và quyết định.
 * @returns Đáp ứng của API.
 */
export function reviewQuestionContribution(bankId: string, vars: ContributionReviewVars) {
  return vars.approve
    ? apiJson(`/api/v1/question-banks/${bankId}/contributions/${vars.contributionId}/approve`, {
        method: 'POST',
        body: '{}',
      })
    : apiJson(`/api/v1/question-banks/${bankId}/contributions/${vars.contributionId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason: vars.reason ?? '' }),
      });
}

/**
 * Xoá vật lý một câu (DELETE /questions/:id) — API chặn khi câu đã được dùng.
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Đáp ứng của API.
 */
export function deleteBankQuestion(questionId: string) {
  return apiJson(`/api/v1/questions/${questionId}`, { method: 'DELETE' });
}

/**
 * Hoàn rút một câu về bank của nó (POST /questions/:id/restore).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Đáp ứng của API.
 */
export function restoreQuestion(questionId: string) {
  return apiJson(`/api/v1/questions/${questionId}/restore`, { method: 'POST', body: '{}' });
}

/**
 * Rút một câu khỏi bank của nó, kèm lý do bắt buộc (POST /questions/:id/withdraw).
 *
 * @param questionId - Định danh câu hỏi.
 * @param reason - Lý do rút.
 * @returns Đáp ứng của API.
 */
export function withdrawQuestion(questionId: string, reason: string) {
  return apiJson(`/api/v1/questions/${questionId}/withdraw`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

/**
 * Sửa nội dung một ngữ liệu (PATCH /stimuli/:id).
 *
 * @param stimulusId - Định danh ngữ liệu.
 * @param content - Nội dung mới (chuỗi thuần hoặc tài liệu rich-text).
 * @returns Đáp ứng của API.
 */
export function updateStimulus(stimulusId: string, content: RichTextDocument | string) {
  return apiJson(`/api/v1/stimuli/${stimulusId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

/**
 * Tạo ngữ liệu mới trong danh mục (POST /stimuli).
 *
 * @param categoryId - Định danh danh mục.
 * @param content - Nội dung ngữ liệu.
 * @returns Đáp ứng của API.
 */
export function createStimulus(categoryId: string, content: RichTextDocument | string) {
  return apiJson('/api/v1/stimuli', { method: 'POST', body: JSON.stringify({ categoryId, content }) });
}

/**
 * Xoá một ngữ liệu (DELETE /stimuli/:id).
 *
 * @param stimulusId - Định danh ngữ liệu.
 * @returns Đáp ứng của API.
 */
export function deleteStimulus(stimulusId: string) {
  return apiJson(`/api/v1/stimuli/${stimulusId}`, { method: 'DELETE' });
}

/**
 * Tạo danh mục câu hỏi (POST /questions/categories) ở màn tạo riêng.
 *
 * @param body - Tên và context của danh mục.
 * @returns Đáp ứng của API.
 */
export function createQuestionCategory(body: { name: string; contextId: string }) {
  return apiJson('/api/v1/questions/categories', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Tạo lượt làm bài từ các câu đã chọn (POST /question-usages).
 *
 * @param body - Component và các slot câu.
 * @returns Usage để điều hướng sang trang làm thử.
 */
export function createQuestionUsage(body: { component: string; slots: { questionId: string }[] }) {
  return apiJson<QuestionUsage>('/api/v1/question-usages', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// --- Trang làm thử câu hỏi (usage) ------------------------------------

/**
 * Đọc một lượt dùng câu hỏi (GET /question-usages/:id).
 *
 * @param usageId - Định danh usage.
 * @returns Chi tiết usage.
 */
export function fetchQuestionUsage(usageId: string) {
  return apiJson<QuestionUsage>(`/api/v1/question-usages/${usageId}`);
}

/**
 * Đọc các version của một câu theo hình dạng trang làm thử
 * (GET /questions/:id/versions).
 *
 * @param questionId - Định danh câu hỏi.
 * @returns Danh sách version kèm stimulusId.
 */
export function fetchPinnedQuestionVersions(questionId: string) {
  return apiJson<PinnedQuestionVersion[]>(`/api/v1/questions/${questionId}/versions`);
}

/**
 * Đọc một ngữ liệu theo id (GET /stimuli/:id).
 *
 * @param stimulusId - Định danh ngữ liệu.
 * @returns Chi tiết ngữ liệu.
 */
export function fetchStimulusDetail(stimulusId: string) {
  return apiJson<StimulusView>(`/api/v1/stimuli/${stimulusId}`);
}

/**
 * Bắt đầu một usage (POST /question-usages/:id/start).
 *
 * @param usageId - Định danh usage.
 * @returns Đáp ứng của API.
 */
export function startQuestionUsage(usageId: string) {
  return apiJson(`/api/v1/question-usages/${usageId}/start`, { method: 'POST', body: '{}' });
}

/**
 * Kết thúc một usage (POST /question-usages/:id/finish) — điểm của mọi attempt được chốt.
 *
 * @param usageId - Định danh usage.
 * @returns Đáp ứng của API.
 */
export function finishQuestionUsage(usageId: string) {
  return apiJson(`/api/v1/question-usages/${usageId}/finish`, { method: 'POST', body: '{}' });
}

/**
 * Bắt đầu một attempt trong usage (POST /question-usages/:id/attempts/:attemptId/start).
 *
 * @param usageId - Định danh usage.
 * @param attemptId - Định danh attempt.
 * @returns Đáp ứng của API.
 */
export function startUsageAttempt(usageId: string, attemptId: string) {
  return apiJson(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Nộp đáp án của một attempt (POST .../attempts/:attemptId/submit) — deferredfeedback: chỉ ghi step, chưa chốt điểm.
 *
 * @param usageId - Định danh usage.
 * @param attemptId - Định danh attempt.
 * @param response - Đáp án.
 * @returns Đáp ứng của API.
 */
export function submitUsageAttempt(usageId: string, attemptId: string, response: string | null) {
  return apiJson(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

/**
 * Kết thúc một attempt (POST .../attempts/:attemptId/finish) — fraction của attempt được chốt.
 *
 * @param usageId - Định danh usage.
 * @param attemptId - Định danh attempt.
 * @returns Đáp ứng của API.
 */
export function finishUsageAttempt(usageId: string, attemptId: string) {
  return apiJson(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/finish`, {
    method: 'POST',
    body: '{}',
  });
}
