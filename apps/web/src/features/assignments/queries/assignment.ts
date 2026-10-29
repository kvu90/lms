import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TeacherCommentBankEntryView } from '@lms/contracts';
import {
  addSubmissionAnnotation,
  createCommentBankEntry,
  deleteAssignment,
  deleteSubmissionAnnotation,
  deleteSubmissionFile,
  fetchAssignment,
  fetchAssignmentSubmissions,
  fetchCommentBank,
  fetchCurrentUser,
  fetchSubmissionDetail,
  gradeSubmission,
  postFeedbackMessage,
  releaseSubmission,
  releaseSubmissionsBatch,
  reopenSubmission,
  saveAssignmentRubric,
  submitSubmission,
  updateAssignment,
  uploadSubmissionFile,
} from '../api/assignment';
import type { AssignmentWriteBody } from '../types/assignment';
import { queryKeys } from './keys';

/**
 * Tầng dữ liệu trang Bài tập (F-01 đợt 1, rà soát #133): chi tiết bài
 * tập theo đúng quyền người xem (API đã phân giải cờ canSubmit/
 * canGrade/canManage trong cùng đáp ứng). Options dùng chung cho hook
 * của trang và clientLoader của route module (prefetch cùng khoá).
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn
 * riêng của assignments nằm ở `keys.ts` cùng tầng này.
 */

/**
 * Tuỳ chọn truy vấn chi tiết bài tập.
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Tuỳ chọn truy vấn chi tiết bài tập.
 */
export function assignmentQueryOptions(assignmentId: string) {
  return queryOptions({
    queryKey: queryKeys.assignmentDetail(assignmentId),
    queryFn: () => fetchAssignment(assignmentId),
  });
}

/** Đọc chi tiết bài tập; `assignmentId` trống thì query tắt. */
export function useAssignment(assignmentId: string | undefined) {
  return useQuery({
    ...assignmentQueryOptions(assignmentId ?? ''),
    enabled: !!assignmentId,
  });
}

/**
 * Các panel của trang Bài tập (F-01 của rà soát #133 — phần còn lại;
 * chuyển sang cache TanStack ở CN-13, issue #493).
 *
 * Luồng nghiệp vụ: trang cha (pages/assignment) sở hữu dữ liệu bài
 * tập qua useAssignment; mỗi panel con đọc phần của nó (danh sách
 * bài nộp, chi tiết một bài nộp, ngân hàng nhận xét) TRỰC TIẾP từ
 * cache TanStack Query qua các options dưới đây — cache là nguồn sự
 * thật duy nhất, panel không giữ bản chép dữ kiện máy chủ trong
 * state. Mọi đột biến, khi thành công, tự làm mới đúng phần cache bị
 * ảnh hưởng: invalidateQueries theo khoá nhà máy cho các thay đổi mà
 * đáp ứng không chứa trọn trạng thái mới (chấm điểm, trả bài, thả/xoá
 * dấu chấm, nộp/mở lại bài, sửa cài đặt/rubric, xoá bài), và
 * setQueryData khi đáp ứng mang theo đúng dữ kiện mới (thêm câu vào
 * ngân hàng nhận xét — đáp ứng là mục vừa tạo, danh sách mới là danh
 * sách cũ cộng mục đó). Panel chỉ còn giữ state biểu mẫu và gọi các
 * prop báo UI (không phải nạp lại dữ kiện) khi cần.
 */

/** Danh sách bài nộp của lớp cho một bài tập (GET /assignments/:id/submissions). */
export function assignmentSubmissionsQueryOptions(assignmentId: string) {
  return queryOptions({
    queryKey: queryKeys.assignmentSubmissions(assignmentId),
    queryFn: () => fetchAssignmentSubmissions(assignmentId),
  });
}

/** Chi tiết một bài nộp kèm điểm/dấu chấm/hội thoại (GET /assignments/:id/submissions/:userId). */
export function submissionDetailQueryOptions(assignmentId: string, userId: string) {
  return queryOptions({
    queryKey: queryKeys.submissionDetail(assignmentId, userId),
    queryFn: () => fetchSubmissionDetail(assignmentId, userId),
  });
}

/** Ngân hàng câu nhận xét mẫu của giáo viên (GET /assign-comment-bank). */
export function commentBankQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.commentBank,
    queryFn: () => fetchCommentBank(),
  });
}

/** Người dùng hiện tại rút gọn (GET /users/me) — panel học sinh cần id của mình cho hội thoại phản hồi. */
export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.currentUser,
    queryFn: () => fetchCurrentUser(),
  });
}

/** Đột biến trả bài theo đợt cho cả lớp (POST /assignments/:id/release-batch) — làm mới danh sách bài nộp và chi tiết bài tập. */
export function useReleaseSubmissionsBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => releaseSubmissionsBatch(assignmentId),
    onSuccess: (_data, assignmentId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentSubmissions(assignmentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến lưu gói chấm một bài nộp (POST .../submissions/:userId/grade) — làm mới chi tiết bài nộp đó và danh sách bài nộp. */
export function useGradeSubmission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; userId: string; body: AssignmentWriteBody }) =>
      gradeSubmission(input),
    onSuccess: (_data, { assignmentId, userId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.submissionDetail(assignmentId, userId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentSubmissions(assignmentId) });
    },
  });
}

/** Đột biến thả một dấu chấm trên tệp bài nộp (POST .../annotations) — làm mới chi tiết bài nộp chứa tệp. */
export function useAddSubmissionAnnotation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; userId: string; body: AssignmentWriteBody }) =>
      addSubmissionAnnotation(input),
    onSuccess: (_data, { assignmentId, userId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.submissionDetail(assignmentId, userId) });
    },
  });
}

/** Đột biến xoá một dấu chấm (DELETE .../annotations/:annotationId) — làm mới chi tiết bài nộp chứa tệp. */
export function useDeleteSubmissionAnnotation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; userId: string; annotationId: string }) =>
      deleteSubmissionAnnotation(input),
    onSuccess: (_data, { assignmentId, userId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.submissionDetail(assignmentId, userId) });
    },
  });
}

/** Đột biến trả bài cho một học sinh (POST .../submissions/:userId/release) — làm mới chi tiết bài nộp đó và danh sách bài nộp. */
export function useReleaseSubmission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; userId: string }) => releaseSubmission(input),
    onSuccess: (_data, { assignmentId, userId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.submissionDetail(assignmentId, userId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentSubmissions(assignmentId) });
    },
  });
}

/** Đột biến thêm một câu vào ngân hàng nhận xét (POST /assign-comment-bank) — đáp ứng là mục vừa tạo nên vá thẳng vào cache danh sách (chống trùng theo id). */
export function useCreateCommentBankEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { category: string; text: string }) => createCommentBankEntry(body),
    onSuccess: (created) => {
      queryClient.setQueryData<TeacherCommentBankEntryView[]>(queryKeys.commentBank, (old) =>
        old ? (old.some((entry) => entry.id === created.id) ? old : [...old, created]) : old,
      );
    },
  });
}

/**
 * Đột biến gửi một tin trong hội thoại phản hồi của bài đã trả (POST .../submissions/:userId/messages) —
 * làm mới cả hai bề mặt chứa hội thoại: chi tiết bài nộp phía giáo viên và chi tiết bài tập phía học sinh
 * (hội thoại của học sinh nằm trong mySubmission của đáp ứng chi tiết bài tập).
 */
export function usePostFeedbackMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; userId: string; body: string }) =>
      postFeedbackMessage(input),
    onSuccess: (_data, { assignmentId, userId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.submissionDetail(assignmentId, userId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến tải một tệp vào bản nháp bài nộp (POST .../submission/files, thân FormData) — làm mới chi tiết bài tập (bản nháp của chính học sinh nằm trong đó). */
export function useUploadSubmissionFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; formData: FormData }) => uploadSubmissionFile(input),
    onSuccess: (_data, { assignmentId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến gỡ một tệp khỏi bản nháp (DELETE .../submission/files/:fileId) — làm mới chi tiết bài tập. */
export function useDeleteSubmissionFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; fileId: string }) => deleteSubmissionFile(input),
    onSuccess: (_data, { assignmentId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến chốt nộp bài (POST .../submission/submit) — làm mới chi tiết bài tập. */
export function useSubmitSubmission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => submitSubmission(assignmentId),
    onSuccess: (_data, assignmentId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến mở lại bài đã nộp khi chưa bị trả (POST .../submission/reopen) — làm mới chi tiết bài tập. */
export function useReopenSubmission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => reopenSubmission(assignmentId),
    onSuccess: (_data, assignmentId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến lưu cài đặt bài tập (PATCH /assignments/:id) — làm mới chi tiết bài tập. */
export function useUpdateAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; body: AssignmentWriteBody }) =>
      updateAssignment(input),
    onSuccess: (_data, { assignmentId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến lưu rubric của bài tập (PUT /assignments/:id/rubric) — làm mới chi tiết bài tập (rubric nằm trong cùng đáp ứng). */
export function useSaveAssignmentRubric() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assignmentId: string; body: AssignmentWriteBody }) =>
      saveAssignmentRubric(input),
    onSuccess: (_data, { assignmentId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
    },
  });
}

/** Đột biến xoá hẳn bài tập (DELETE /assignments/:id) — làm mới chi tiết và danh sách bài nộp của bài đã xoá (mọi bề mặt còn giữ cache đều phải bỏ dữ kiện cũ). */
export function useDeleteAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => deleteAssignment(assignmentId),
    onSuccess: (_data, assignmentId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentDetail(assignmentId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignmentSubmissions(assignmentId) });
    },
  });
}
