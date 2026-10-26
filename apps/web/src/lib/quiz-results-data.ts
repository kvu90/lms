import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QuizAttemptSummary, QuizView } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

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

/**
 * Tầng dữ liệu trang kết quả quiz (F-01 đợt 1, rà soát #133): options
 * dùng chung cho hook của trang và clientLoader của route module.
 */
export function quizResultsQueryOptions(quizId: string) {
  return queryOptions({
    queryKey: queryKeys.quizResults(quizId),
    queryFn: () => apiJson<QuizResults>(`/api/v1/exam-pins/${quizId}/results`),
  });
}

/** Đọc kết quả quiz; `quizId` trống thì query tắt. */
export function useQuizResults(quizId: string | undefined) {
  return useQuery({
    ...quizResultsQueryOptions(quizId ?? ''),
    enabled: !!quizId,
  });
}

/**
 * Mutation chấm tay một câu essay trong hàng đợi: điểm bài được API
 * tính lại sau mỗi lần chấm nên thành công thì invalidate query kết
 * quả của quiz đó để trang tự tải bản mới (thay reload thủ công).
 */
export function useGradeQuizQuestion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      quizId: string;
      quizAttemptId: string;
      questionAttemptId: string;
      mark: number;
      comment?: string;
    }) =>
      apiJson(`/api/v1/quiz-attempts/${vars.quizAttemptId}/questions/${vars.questionAttemptId}/grade`, {
        method: 'POST',
        body: JSON.stringify({
          mark: vars.mark,
          ...(vars.comment ? { comment: vars.comment } : {}),
        }),
      }),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.quizResults(vars.quizId) }),
  });
}
