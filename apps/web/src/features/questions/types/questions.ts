import type { RichTextDocument } from '@lms/contracts';

/**
 * Kiểu dữ liệu của shell ngân hàng câu hỏi/đề/ma trận thuộc
 * feature questions. Tách từ module dữ liệu phẳng
 * `src/lib/questions-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500): kiểu nằm ở tầng types/, lời gọi
 * API thuần ở tầng api/, tuỳ chọn truy vấn và đột biến ở tầng
 * queries/. Nhóm kiểu về đề/hồ sơ đề và đóng góp ma trận ở lại
 * trong feature này theo đúng đặc tả issue #500 (shell ngân hàng
 * là một đơn vị gắn kết, render cả ba khu vực).
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

/**
 * Một đề xuất đóng góp ĐỀ trong hàng chờ của một bank đề — ĐƯỜNG
 * ĐÓNG GÓP DUY NHẤT của đề (EB-1, nâng lên khuôn QB-4 đầy đủ ở
 * S4/Q4 của issue #228): `mode` phân biệt đóng góp mới/cập nhật đề
 * đích; bộ cột `dossier*` là BỘ HỒ SƠ đính kèm đã ghim tại lúc đề
 * xuất (chỉ có ở đóng góp chính thức có đính kèm); `sourceDossierId`
 * neo về bộ hồ sơ gốc với các đóng góp được chuyển đổi từ hồ sơ treo
 * khi cắt đường hồ sơ — hàng chờ hồ sơ dùng neo này để đi thao tác
 * duyệt trên chính đóng góp. Hình dạng khớp view API trả về
 * (ExamContributionView: hàng đóng góp + paperName + reviews).
 */
export interface ExamContributionLite {
  id: string;
  examId: string;
  paperName: string | null;
  status: string;
  proposerId: string;
  mode: string;
  targetExamId: string | null;
  sourceDossierId: string | null;
  dossierExamVersionNumber: number | null;
  dossierMatrixVersion: number | null;
  dossierSpecSnapshot: DossierSpecLite | null;
}

/** Một mốc duyệt trong vết của bộ hồ sơ (EB-3). */
export interface ExamDossierReviewLite {
  level: number;
  reviewerName: string | null;
  decision: string;
  reason: string | null;
}

/** Một BỘ HỒ SƠ đề (EB-3): ma trận + đề + đặc tả ghim tại lúc nộp, duyệt theo bộ (có thể hai cấp). Trường định danh/tên khớp view API (`examId`/`examName` của ExamDossierView). */
export interface ExamDossierLite {
  id: string;
  examId: string;
  examName: string | null;
  targetBankId: string;
  proposerName: string | null;
  note: string;
  status: string;
  examVersionNumber: number | null;
  matrixName: string | null;
  matrixVersion: number | null;
  boardApprovalRequired: boolean;
  resultExamId: string | null;
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

/** Loại bank theo tham số API: câu hỏi (không tham số), ma trận, đề. */
export type BankKindParam = 'question' | 'matrix' | 'exam';

/** Gắn kết chương trình của một câu hỏi — hình dạng của GET /questions/:id/curriculum-links. */
export interface QuestionCurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}

/** Một version của câu hỏi theo hình dạng trình soạn cần để khôi phục options đầy đủ. */
export interface EditorQuestionVersion {
  id: string;
  version: number;
  options?: Record<string, unknown> | null;
}

/** Quyết định duyệt một đóng góp: duyệt (approve) hoặc từ chối kèm lý do bắt buộc. */
export interface ContributionReviewVars {
  contributionId: string;
  approve: boolean;
  reason?: string;
}

/** Một phiên bản câu hỏi như endpoint versions trả về (có stimulusId để tra ngữ liệu đã gắn). */
export interface PinnedQuestionVersion {
  id: string;
  version: number;
  questionText: RichTextDocument;
  stimulusId: string | null;
}
