import type {
  QuestionSolution,
  QuizAttemptSummary,
  QuizView,
  RichTextDocument,
} from '@lms/contracts';

/**
 * Kiểu dữ liệu của trang lần ghim đề và trang làm bài thuộc
 * feature quizzes. Tách từ module dữ liệu phẳng
 * `src/lib/quiz-data.ts` khi tổ chức lại apps/web theo mô hình
 * features/ (issue #500): kiểu nằm ở tầng types/, lời gọi API
 * thuần ở tầng api/, tuỳ chọn truy vấn và đột biến ở tầng
 * queries/.
 */

/** Hình dạng trả về của GET /exam-pins/:id (trang thông tin theo người xem). */
export interface QuizForUser {
  quiz: QuizView;
  myAttempts: QuizAttemptSummary[];
  myGrade: number | null;
  canAttempt: boolean;
  attemptBlockedReason: string | null;
  inProgressAttemptId: string | null;
  /** Cài đặt hiệu lực của chính người xem sau khi hợp nhất ghi đè (API trả sẵn). */
  effective: {
    timeOpen: string | null;
    timeClose: string | null;
    timeLimitSeconds: number | null;
    attemptsAllowed: number;
    passwordRequired: boolean;
    nextAttemptAt: string | null;
  };
  permissions: { manage: boolean; manageOverrides: boolean; grade: boolean; viewReports: boolean; preview: boolean; attempt: boolean };
}

/** Gói trang lần ghim: dữ liệu lần ghim + nhãn câu của từng slot đã ghim. */
export interface ExamPinPageData {
  view: QuizForUser;
  /** Nhãn câu (trích đoạn nội dung) theo id slot; slot không tra được thì vắng mặt (chỉ để hiển thị). */
  slotNames: Record<string, string>;
}

/** Thông tin ĐỀ nguồn của lần ghim (tên + version hiện hành ở ngân hàng). */
export interface ExamSourceInfo {
  name: string;
  version: number;
  currentVersionId: string;
  status: string;
}

/**
 * Một câu trong lượt làm như GET /quiz-attempts/:id trả về (nội dung
 * của version đã pin).
 *
 * Hai trường phía đáp án do lát P3 cấp theo mô hình giaokhoa:
 * `guidance` là HƯỚNG DẪN (gợi ý cách làm — hiện kèm câu hỏi ngay
 * trong lúc làm theo điểm quyết D-4, không qua cổng xem lại);
 * `solution` là đáp án đúng dạng cấu trúc, API chỉ trả khi cổng
 * `reviewRightAnswer` của lần ghim cho phép tại cửa sổ xem lại —
 * ngoài cửa sổ đó trường này là `null`. Câu hỏi không còn trường
 * tên: `questionExcerpt` là trích đoạn nội dung thân câu.
 */
export interface AttemptQuestion {
  slot: number;
  page: number;
  questionAttemptId: string;
  questionId: string;
  qtype: string;
  questionExcerpt: string;
  questionText: RichTextDocument;
  /** Hướng dẫn (guidance) của version đã pin; null khi câu không có hướng dẫn. */
  guidance: RichTextDocument | null;
  /** Đáp án đúng dạng cấu trúc khi cổng xem lại cho phép; null khi cổng đóng. */
  solution: QuestionSolution | null;
  stimulus: { id: string; content: RichTextDocument } | null;
  answers: { id: string; text: RichTextDocument }[];
  options: Record<string, unknown> | null;
  maxMark: number;
  state: string;
  response: string | null;
  fraction: number | null;
  mark: number | null;
  rightAnswer: string | null;
  /** Phản hồi riêng cho đáp án đã chọn — API chỉ trả khi cổng review của quiz cho xem ở thời điểm xem lại. */
  feedback: RichTextDocument | null;
  /** Lời giải chung của câu — cùng cổng review phía API. */
  generalFeedback: RichTextDocument | null;
  /** Nhận xét của giáo viên khi chấm tay câu này — cùng cổng review phía API. */
  manualComment: string | null;
}

/** Hình dạng trả về của các endpoint lượt làm quiz. */
export interface AttemptView {
  attempt: {
    id: string; quizId: string; userId: string; attemptNumber: number; state: string;
    preview: boolean; timeStart: string; timeFinish: string | null;
    sumGrades: number | null; grade: number | null;
  };
  quiz: QuizView;
  questions: AttemptQuestion[];
  totalMax: number;
  pendingManualCount: number;
  closedDueToTimeLimit: boolean;
  /** Nhận xét tổng quát theo dải điểm của cả bài — API chỉ trả khi cổng review cho xem. */
  overallFeedback: string | null;
}

/** Một version của câu hỏi theo hình dạng panel chấm lại cần (id + số version + trạng thái). */
export interface RegradeQuestionVersion {
  id: string;
  version: number;
  status: string;
}

/** Thân lưu cài đặt tổ chức của lần ghim (PATCH /exam-pins/:id). */
export interface ExamPinSettingsPayload {
  name: string;
  intro: string;
  timeOpen: string | null;
  timeClose: string | null;
  timeLimitSeconds: number | null;
  attemptsAllowed: number;
  gradeMethod: string;
  grade: number;
  shuffleAnswers: boolean;
  versionMode: 'pinned' | 'float_latest_ready';
}

/** Các trường ghi đè dùng chung cho tạo mới và sửa (đích chỉ có ở tạo mới). */
export interface ExamPinOverrideFields {
  timeOpen: string | null;
  timeClose: string | null;
  timeLimitSeconds: number | null;
  attempts: number | null;
  password?: string;
  reason?: string;
}
