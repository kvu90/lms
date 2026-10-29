import { apiJson } from '#lib/api';
import type { QuizResults } from '../types/quiz-results';

/**
 * Tầng gọi API thuần của trang kết quả quiz thuộc feature
 * quizzes: chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay
 * React Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/quiz-results-data.ts` khi tổ chức lại apps/web theo
 * mô hình features/ (issue #500).
 */

/**
 * Đọc kết quả quiz (GET /exam-pins/:id/results).
 *
 * @param quizId - Định danh lần ghim.
 * @returns Gói kết quả quiz.
 */
export function fetchQuizResults(quizId: string) {
  return apiJson<QuizResults>(`/api/v1/exam-pins/${quizId}/results`);
}

/**
 * Chấm tay một câu essay trong hàng đợi (POST
 * /quiz-attempts/:id/questions/:questionAttemptId/grade).
 *
 * @param vars - Lần ghim, lượt làm, câu, điểm và nhận xét (khi có).
 * @returns Đáp ứng của API.
 */
export function gradeQuizQuestion(vars: {
  quizId: string;
  quizAttemptId: string;
  questionAttemptId: string;
  mark: number;
  comment?: string;
}) {
  return apiJson(`/api/v1/quiz-attempts/${vars.quizAttemptId}/questions/${vars.questionAttemptId}/grade`, {
    method: 'POST',
    body: JSON.stringify({
      mark: vars.mark,
      ...(vars.comment ? { comment: vars.comment } : {}),
    }),
  });
}
