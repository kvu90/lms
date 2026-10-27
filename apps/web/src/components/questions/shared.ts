/**
 * Hằng số, kiểu dữ liệu và hàm thuần DÙNG CHUNG của cụm ngân hàng câu hỏi:
 * nhãn loại câu hỏi/mức nhận thức, hàm bóc văn bản thuần từ tài liệu rich
 * text, trích đoạn câu hỏi, kiểm tra đủ lựa chọn theo loại câu và khoá i18n
 * cho trạng thái ma trận/hồ sơ. Các panel của trang ngân hàng câu hỏi
 * (components/questions/*) và hai màn riêng (tạo danh mục, lượt dùng) cùng
 * nhập từ đây để giữ đúng một hành vi; bề mặt xuất khẩu của trang cũ được
 * giữ nguyên bằng cách trang questions.tsx xuất khẩu lại từ module này.
 */
import { extractRichTextPlainText, type QuestionView, type RichTextDocument } from '@lms/contracts';

import { ApiError } from '#lib/api';

/**
 * Thông báo lỗi kèm lý do thật từ API (ProblemDetails.detail) — trước
 * đây các catch nuốt lỗi gốc và chỉ hiện câu chung chung, giáo viên
 * không biết sai ở đâu (issue #55 mục 3). Export để màn editor riêng
 * (question-editor.tsx) dùng chung đúng hành vi này.
 */
export function withApiReason(fallback: string, err: unknown): string {
  if (err instanceof ApiError) {
    const reason = err.problem.detail ?? err.problem.title;
    if (reason) return `${fallback} ${reason}`;
  }
  return fallback;
}

/** Một lựa chọn ngữ cảnh cho form danh mục mới. */
export interface ContextOption {
  id: string;
  level: number;
  label: string;
}

export const QTYPES = ['multichoice', 'truefalse', 'shortanswer', 'essay'] as const;
export type Qtype = (typeof QTYPES)[number];

export const QTYPE_LABEL_KEYS: Record<Qtype, string> = {
  multichoice: 'qtypeMultichoice',
  truefalse: 'qtypeTruefalse',
  shortanswer: 'qtypeShortanswer',
  essay: 'qtypeEssay',
};

/** Mức độ nhận thức trên dòng nối câu hỏi × YCCĐ (issue #20 Chặng 2, mục A.2). */
export const COGNITIVE_LEVELS = ['biet', 'hieu', 'van_dung', 'van_dung_cao'] as const;
export const LEVEL_LABEL_KEYS: Record<(typeof COGNITIVE_LEVELS)[number], string> = {
  biet: 'levelBiet',
  hieu: 'levelHieu',
  van_dung: 'levelVanDung',
  van_dung_cao: 'levelVanDungCao',
};

/** Gắn kết chương trình của một câu hỏi — hình dạng của GET /questions/:id/curriculum-links. */
export interface CurriculumLinksView {
  questionId: string;
  subjectIds: string[];
  outcomes: { outcomeId: string; cognitiveLevel: string }[];
}

/** Một node trong cây chương trình trả về bởi GET /curriculum/curricula/:id/tree. */
export interface CurriculumTreeNode {
  id: string;
  title: string;
  outcomes: { id: string; content: string }[];
  children: CurriculumTreeNode[];
}










/** Khoá học cho hộp thoại triển khai đề vào quiz. */
interface CourseLite {
  id: string;
  fullName: string;
}

/** Nhóm của khoá cho hộp thoại ghim đề (GET /courses/:id/groups). */
interface CourseGroupLite {
  id: string;
  name: string;
}

export function plainText(doc: RichTextDocument | null | undefined): string {
  return doc ? extractRichTextPlainText(doc) : '';
}

/**
 * Nhãn hiển thị của một câu hỏi = TRÍCH ĐOẠN nội dung thân câu của
 * phiên bản mới nhất (tối đa 120 ký tự). Câu hỏi không còn trường tên
 * (quyết 11:28 ngày 26/10/2026) nên mọi bề mặt cần nhãn — danh sách,
 * hộp xác nhận xoá, bộ chọn, panel xem trước — đều dùng trích đoạn
 * này thay cho tên.
 *
 * @param view - View câu hỏi như API trả về.
 * @returns Chuỗi thuần trích từ thân câu.
 */
export function questionExcerpt(view: QuestionView): string {
  return plainText(view.latestVersion.questionText).slice(0, 120);
}

export type OptionsRecord = Record<string, unknown>;

/**
 * Các trường options phải còn nguyên khi sửa; thiếu trường nào thì form
 * sẽ tìm thêm ở endpoint versions. Multichoice chỉ còn các trường của
 * mô hình mới — `single`, `showNumCorrect` và `partiallyCorrectFeedback`
 * đã bỏ hẳn cùng tỉ trọng đáp án (quyết 12:04 + điểm quyết D-5 ngày
 * 26/10/2026).
 */
const OPTION_KEYS_BY_QTYPE: Record<Qtype, string[]> = {
  multichoice: [
    'shuffleAnswers',
    'answerNumbering',
    'showStandardInstruction',
    'correctFeedback',
    'incorrectFeedback',
  ],
  truefalse: ['showStandardInstruction'],
  shortanswer: ['useCase'],
  essay: [
    'responseFormat',
    'responseRequired',
    'responseFieldLines',
    'minWordLimit',
    'maxWordLimit',
    'graderInfo',
    'responseTemplate',
  ],
};

export function hasAllOptions(qtype: Qtype, options: OptionsRecord | null | undefined): boolean {
  if (!options) return false;
  return OPTION_KEYS_BY_QTYPE[qtype].every(
    (key) => Object.prototype.hasOwnProperty.call(options, key) && options[key] !== undefined,
  );
}

/**
 * Khu vực ngân hàng mà trang này đang phục vụ (chuẩn đường dẫn, issue
 * #221 — lát R1): mỗi khu vực có PATH RIÊNG, trang suy ra khu vực từ
 * route (prop do route module truyền vào), KHÔNG còn đọc ?bank=/
 * ?section= từ URL như trước. URL cũ dạng ?bank=... được lớp tương
 * thích ở route module questions chuyển hướng (replace) sang path mới.
 */
export type BankArea =
  | 'my-questions'
  | 'stimuli'
  | 'my-exams'
  | 'my-matrices'
  | 'system-questions'
  | 'system-exams'
  | 'system-matrices';

/** Khoá i18n cho trạng thái ma trận dùng chung: pending/approved/rejected ghép từ tên trạng thái. */
export function matrixStatusKey(status: string): string {
  return `matrixStatus${status[0]!.toUpperCase()}${status.slice(1)}`;
}

/** Khoá i18n cho trạng thái chờ duyệt (EB-3): từ vựng trạng thái của hồ sơ và của đóng góp đề là một (pending/pending_board/approved/rejected) nên dùng chung — pending_board là khoá ghép riêng. */
export function dossierStatusKey(status: string): string {
  return status === 'pending_board'
    ? 'dossierStatusPendingBoard'
    : `dossierStatus${status[0]!.toUpperCase()}${status.slice(1)}`;
}
