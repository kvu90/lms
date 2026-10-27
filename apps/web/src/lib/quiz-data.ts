import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CourseRosterMember,
  QuestionSolution,
  QuestionView,
  QuizAttemptSummary,
  ExamPinOverrideView as QuizOverrideView,
  QuizView,
  RichTextDocument,
} from '@lms/contracts';
import { extractRichTextPlainText } from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu trang lần ghim đề (F-01 đợt 1, rà soát #133): lần ghim
 * + nhãn câu của các slot là một query gộp (clientLoader prefetch
 * cùng khoá); ghi đè, thông tin đề nguồn và danh sách thành viên là
 * các query riêng bật theo quyền của người xem như các effect thủ
 * công trước đây. Nhãn câu là TRÍCH ĐOẠN nội dung thân câu — câu hỏi
 * không còn trường tên (quyết 11:28 ngày 26/10/2026).
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

/** Tải một endpoint độc lập: lỗi thì trả null (giữ nhịp probe thủ công trước đây). */
async function probe<T>(path: string): Promise<T | null> {
  try {
    return await apiJson<T>(path);
  } catch {
    return null;
  }
}

async function fetchExamPin(pinId: string): Promise<ExamPinPageData> {
  const view = await apiJson<QuizForUser>(`/api/v1/exam-pins/${pinId}`);
  // Tra nhãn cho slot cố định/slot ngẫu nhiên để bảng dựng đề đọc
  // được: nhãn là trích đoạn nội dung thân câu của phiên bản mới nhất.
  const slotNames: Record<string, string> = {};
  await Promise.all(
    view.quiz.slots.map(async (s) => {
      try {
        if (s.questionId) {
          const q = await apiJson<QuestionView>(`/api/v1/questions/${s.questionId}`);
          slotNames[s.id] = extractRichTextPlainText(q.latestVersion.questionText).slice(0, 120);
        }
      } catch { /* nhãn chỉ để hiển thị */ }
    }),
  );
  return { view, slotNames };
}

export function examPinQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPin(pinId),
    queryFn: () => fetchExamPin(pinId),
  });
}

/** Đọc lần ghim + nhãn slot; lỗi tải nổi lên query (trang hiện lỗi + nút thử lại như trước). */
export function useExamPin(pinId: string) {
  return useQuery(examPinQueryOptions(pinId));
}

export function examPinOverridesQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPinOverrides(pinId),
    queryFn: () => apiJson<QuizOverrideView[]>(`/api/v1/exam-pins/${pinId}/overrides`),
  });
}

/** Danh sách ghi đè của lần ghim; chỉ tải khi người xem có quyền quản ghi đè. */
export function useExamPinOverrides(pinId: string, enabled: boolean) {
  return useQuery({ ...examPinOverridesQueryOptions(pinId), enabled });
}

export function examSourceQueryOptions(examId: string) {
  return queryOptions({
    queryKey: queryKeys.examSource(examId),
    queryFn: async (): Promise<ExamSourceInfo | null> => {
      const view = await probe<{ version: { id: string; version: number; name: string }; paper: { status: string } }>(
        `/api/v1/exams/${examId}`,
      );
      return view
        ? {
            name: view.version.name,
            version: view.version.version,
            currentVersionId: view.version.id,
            status: view.paper.status,
          }
        : null;
    },
  });
}

/** Thông tin đề nguồn; chỉ tải khi có examId và người xem có quyền manage. */
export function useExamSource(examId: string | undefined, enabled: boolean) {
  return useQuery({
    ...examSourceQueryOptions(examId ?? ''),
    enabled: enabled && !!examId,
  });
}

export function courseRosterQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseRosterMembers(courseId),
    queryFn: async () => {
      const res = await probe<{ members: CourseRosterMember[] }>(
        `/api/v1/messages/courses/${courseId}/members?limit=100`,
      );
      return res?.members ?? [];
    },
  });
}

/** Danh sách thành viên khoá cho bộ chọn đích ghi đè; chỉ tải khi có quyền quản ghi đè. */
export function useCourseRoster(courseId: string, enabled: boolean) {
  return useQuery({ ...courseRosterQueryOptions(courseId), enabled });
}

// ---------------------------------------------------------------------
// Lượt làm quiz (trang làm bài + xem lại): view lượt làm là query
// chính; lưu từng câu và nộp bài là đột biến làm mới đúng view đó —
// thay cho vòng reload thủ công sau mỗi thao tác trước đây (F-01 của
// rà soát #133).
// ---------------------------------------------------------------------

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

/** Tuỳ chọn truy vấn view lượt làm (GET /quiz-attempts/:id). */
export function quizAttemptQueryOptions(attemptId: string) {
  return queryOptions({
    queryKey: queryKeys.quizAttempt(attemptId),
    queryFn: () => apiJson<AttemptView>(`/api/v1/quiz-attempts/${attemptId}`),
  });
}

/** Hook đọc view lượt làm cho trang làm bài/xem lại. */
export function useQuizAttempt(attemptId: string | undefined) {
  return useQuery({
    ...quizAttemptQueryOptions(attemptId ?? ''),
    enabled: attemptId !== undefined,
  });
}

/**
 * Đột biến lưu đáp án một câu qua question engine (POST
 * /quiz-attempts/:id/responses) — thành công thì làm mới view lượt
 * làm để trạng thái câu (đã lưu/điểm tạm) hiện ngay như lần reload
 * thủ công sau mỗi lần lưu trước đây.
 */
export function useSaveQuizResponse() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { attemptId: string; questionAttemptId: string; response: string | null }) =>
      apiJson(`/api/v1/quiz-attempts/${vars.attemptId}/responses`, {
        method: 'POST',
        body: JSON.stringify({ questionAttemptId: vars.questionAttemptId, response: vars.response }),
      }),
    onSuccess: (_data, vars) =>
      void client.invalidateQueries({ queryKey: queryKeys.quizAttempt(vars.attemptId) }),
  });
}

/**
 * Đột biến nộp bài (POST /quiz-attempts/:id/submit) để chốt điểm —
 * thành công thì làm mới view lượt làm, trang chuyển sang màn xem lại
 * theo trạng thái mới của lượt.
 */
export function useSubmitQuizAttempt() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (attemptId: string) =>
      apiJson(`/api/v1/quiz-attempts/${attemptId}/submit`, { method: 'POST', body: '{}' }),
    onSuccess: (_data, attemptId) =>
      void client.invalidateQueries({ queryKey: queryKeys.quizAttempt(attemptId) }),
  });
}

/** clientLoader (F-01, #133): nạp trước view lượt làm đúng khoá trang làm bài sẽ đọc. */
export async function quizAttemptPageClientLoader(attemptId: string) {
  await queryClient.prefetchQuery(quizAttemptQueryOptions(attemptId));
  return null;
}
