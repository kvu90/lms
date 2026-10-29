import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  applyExamPinVersionUpdate,
  createExamPinOverride,
  deleteExamPinOverride,
  fetchCourseRoster,
  fetchExamPin,
  fetchExamPinMyRegrades,
  fetchExamPinOverrides,
  fetchExamPinRegrades,
  fetchExamPinVersionUpdate,
  fetchExamSource,
  fetchQuizAttempt,
  fetchRegradeQuestionVersions,
  runExamPinRegrade,
  saveQuizResponse,
  startExamPinAttempt,
  submitQuizAttempt,
  updateExamPinOverride,
  updateExamPinSettings,
} from '../api/quiz';
import type { ExamPinOverrideFields, ExamPinSettingsPayload } from '../types/quiz';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang lần ghim đề (F-01 đợt 1, rà soát #133): lần ghim
 * + nhãn câu của các slot là một query gộp (clientLoader prefetch
 * cùng khoá); ghi đè, thông tin đề nguồn và danh sách thành viên là
 * các query riêng bật theo quyền của người xem như các effect thủ
 * công trước đây. Nhãn câu là TRÍCH ĐOẠN nội dung thân câu — câu hỏi
 * không còn trường tên (quyết 11:28 ngày 26/10/2026).
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của quizzes nằm ở `keys.ts` cùng tầng này, riêng khoá
 * `questionVersions` là khoá dùng chung ở factory tập trung.
 */

/** Tuỳ chọn truy vấn lần ghim + nhãn slot. */
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

/** Tuỳ chọn truy vấn danh sách ghi đè của lần ghim. */
export function examPinOverridesQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPinOverrides(pinId),
    queryFn: () => fetchExamPinOverrides(pinId),
  });
}

/** Danh sách ghi đè của lần ghim; chỉ tải khi người xem có quyền quản ghi đè. */
export function useExamPinOverrides(pinId: string, enabled: boolean) {
  return useQuery({ ...examPinOverridesQueryOptions(pinId), enabled });
}

/** Tuỳ chọn truy vấn thông tin đề nguồn (probe: lỗi → null). */
export function examSourceQueryOptions(examId: string) {
  return queryOptions({
    queryKey: queryKeys.examSource(examId),
    queryFn: () => fetchExamSource(examId),
  });
}

/** Thông tin đề nguồn; chỉ tải khi có examId và người xem có quyền manage. */
export function useExamSource(examId: string | undefined, enabled: boolean) {
  return useQuery({
    ...examSourceQueryOptions(examId ?? ''),
    enabled: enabled && !!examId,
  });
}

/** Tuỳ chọn truy vấn danh sách thành viên khoá cho bộ chọn đích ghi đè (lỗi → rỗng). */
export function courseRosterQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseRosterMembers(courseId),
    queryFn: async () => {
      const res = await fetchCourseRoster(courseId);
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

/** Tuỳ chọn truy vấn view lượt làm (GET /quiz-attempts/:id). */
export function quizAttemptQueryOptions(attemptId: string) {
  return queryOptions({
    queryKey: queryKeys.quizAttempt(attemptId),
    queryFn: () => fetchQuizAttempt(attemptId),
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
      saveQuizResponse(vars),
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
    mutationFn: (attemptId: string) => submitQuizAttempt(attemptId),
    onSuccess: (_data, attemptId) =>
      void client.invalidateQueries({ queryKey: queryKeys.quizAttempt(attemptId) }),
  });
}

/** clientLoader (F-01, #133): nạp trước view lượt làm đúng khoá trang làm bài sẽ đọc. */
export async function quizAttemptPageClientLoader(attemptId: string) {
  await queryClient.prefetchQuery(quizAttemptQueryOptions(attemptId));
  return null;
}

// --- Nhật ký chấm lại, ghi đè, cài đặt và lượt làm của trang lần ghim ----------
//
// Phần còn lại của trang lần ghim (F-01 của rà soát #133): nhật ký
// chấm lại là hai query bật theo quyền; xem trước cập nhật version và
// danh sách version của câu chấm lại là đọc theo yêu cầu (trang gọi
// fetchQuery, giữ nhịp trạng thái tại chỗ); mọi thao tác ghi là đột
// biến làm mới đúng cụm khoá của bề mặt bị ảnh hưởng.

/** Tuỳ chọn truy vấn nhật ký chấm lại của lần ghim (GET /exam-pins/:id/regrades). */
export function examPinRegradesQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPinRegrades(pinId),
    queryFn: () => fetchExamPinRegrades(pinId),
  });
}

/** Hook đọc nhật ký chấm lại — chỉ bật khi người xem có quyền chấm. */
export function useExamPinRegrades(pinId: string, enabled: boolean) {
  return useQuery({ ...examPinRegradesQueryOptions(pinId), enabled });
}

/** Tuỳ chọn truy vấn lịch sử chấm lại của chính người xem (GET /exam-pins/:id/my-regrades). */
export function examPinMyRegradesQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPinMyRegrades(pinId),
    queryFn: () => fetchExamPinMyRegrades(pinId),
  });
}

/** Hook đọc lịch sử chấm lại của chính người xem (API tự gác cổng công bố: chưa công bố thì rỗng). */
export function useExamPinMyRegrades(pinId: string) {
  return useQuery({ ...examPinMyRegradesQueryOptions(pinId), enabled: pinId !== '' });
}

/** Tuỳ chọn truy vấn xem trước cập nhật version (GET /exam-pins/:id/version-update) — đọc theo yêu cầu qua fetchQuery. */
export function examPinVersionUpdateQueryOptions(pinId: string) {
  return queryOptions({
    queryKey: queryKeys.examPinVersionUpdate(pinId),
    queryFn: () => fetchExamPinVersionUpdate(pinId),
  });
}

/**
 * Tuỳ chọn truy vấn các version của một câu cho panel chấm lại: dùng
 * chung khoá factory `questionVersions` với trang ngân hàng câu hỏi —
 * hai bề mặt chỉ đọc các trường khác nhau của cùng một đáp ứng.
 */
export function regradeQuestionVersionsQueryOptions(questionId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.questionVersions(questionId),
    queryFn: () => fetchRegradeQuestionVersions(questionId),
  });
}

/** Đột biến lưu cài đặt lần ghim — thành công thì làm mới view lần ghim. */
export function useUpdateExamPinSettings(pinId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: ExamPinSettingsPayload) => updateExamPinSettings(pinId, payload),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.examPin(pinId) }),
  });
}

/** Đột biến áp cập nhật version lên đúng exam version đã xem trước (POST /exam-pins/:id/version-update). */
export function useApplyExamPinVersionUpdate(pinId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (toExamVersionId: string) => applyExamPinVersionUpdate(pinId, toExamVersionId),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.examPin(pinId) }),
  });
}

/** Đột biến tạo ghi đè cho một đích (POST /exam-pins/:id/overrides). */
export function useCreateExamPinOverride(pinId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ExamPinOverrideFields & { userId?: string; groupId?: string }) =>
      createExamPinOverride(pinId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.examPinOverrides(pinId) }),
  });
}

/** Đột biến sửa một ghi đè (PATCH /exam-pin-overrides/:id). */
export function useUpdateExamPinOverride(pinId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ overrideId, fields }: { overrideId: string; fields: ExamPinOverrideFields }) =>
      updateExamPinOverride(overrideId, fields),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.examPinOverrides(pinId) }),
  });
}

/** Đột biến xoá một ghi đè (DELETE /exam-pin-overrides/:id). */
export function useDeleteExamPinOverride(pinId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (overrideId: string) => deleteExamPinOverride(overrideId),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.examPinOverrides(pinId) }),
  });
}

/**
 * Đột biến chạy chấm lại theo đáp án (POST /exam-pins/:id/regrades):
 * dryRun=true chỉ xem trước điểm đổi; áp thật thì trang tự nạp lại
 * nhật ký + view lần ghim sau khi đột biến xong.
 */
export function useRunExamPinRegrade(pinId: string) {
  return useMutation({
    mutationFn: (vars: { questionId: string; toVersionId: string; dryRun: boolean }) =>
      runExamPinRegrade(pinId, vars),
  });
}

/** Đột biến bắt đầu một lượt làm (POST /exam-pins/:id/attempts) — trả về id lượt để điều hướng sang trang làm bài. */
export function useStartExamPinAttempt(pinId: string) {
  return useMutation({
    mutationFn: (preview: boolean) => startExamPinAttempt(pinId, preview),
  });
}
