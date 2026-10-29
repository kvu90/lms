import type { QuizAttemptSummary, QuizView } from '@lms/contracts';

/**
 * Kiểu dữ liệu của trang kết quả quiz thuộc feature quizzes. Tách
 * từ module dữ liệu phẳng `src/lib/quiz-results-data.ts` khi tổ
 * chức lại apps/web theo mô hình features/ (issue #500): kiểu nằm
 * ở tầng types/, lời gọi API thuần ở tầng api/, tuỳ chọn truy vấn
 * và đột biến ở tầng queries/.
 */

/** Một câu essay đang chờ chấm tay (hàng đợi của giáo viên). */
export interface NeedsGradingItem {
  quizAttemptId: string;
  userId: string;
  attemptNumber: number;
  questionAttemptId: string;
  slot: number;
  questionId: string;
  maxMark: number;
  response: string | null;
}

/** Một học sinh làm chưa trọn vẹn một câu trong thống kê câu sai. */
export interface QuestionWrongStudent {
  userId: string;
  displayName: string;
  quizAttemptId: string;
  attemptNumber: number;
  fraction: number;
  mark: number;
}

/**
 * Thống kê một slot trong đề (API gộp theo vị trí câu, chỉ tính lượt
 * đã nộp): câu sai nhiều nhất được API xếp lên đầu. questionName null
 * khi slot rút câu ngẫu nhiên (mỗi lượt một câu khác nhau).
 */
export interface QuestionStat {
  slot: number;
  questionId: string | null;
  questionName: string | null;
  maxMark: number;
  attemptsCount: number;
  gradedCount: number;
  pendingCount: number;
  wrongCount: number;
  fullyWrongCount: number;
  wrongStudents: QuestionWrongStudent[];
}

/** Hình dạng trả về của GET /exam-pins/:id/results. */
export interface QuizResults {
  quiz: QuizView;
  attempts: QuizAttemptSummary[];
  gradesByUser: { userId: string; grade: number | null }[];
  needsGrading: NeedsGradingItem[];
  questionStats: QuestionStat[];
}
