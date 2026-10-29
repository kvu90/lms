import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchQuizResults, gradeQuizQuestion } from '../api/quiz-results';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang kết quả quiz (F-01 đợt 1, rà soát #133): options
 * dùng chung cho hook của trang và clientLoader của route module.
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của quizzes nằm ở `keys.ts` cùng tầng này.
 */

/** Tuỳ chọn truy vấn kết quả quiz. */
export function quizResultsQueryOptions(quizId: string) {
  return queryOptions({
    queryKey: queryKeys.quizResults(quizId),
    queryFn: () => fetchQuizResults(quizId),
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
    }) => gradeQuizQuestion(vars),
    onSuccess: (_data, vars) =>
      queryClient.invalidateQueries({ queryKey: queryKeys.quizResults(vars.quizId) }),
  });
}
