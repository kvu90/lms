import { queryOptions, useMutation, useQuery } from '@tanstack/react-query';
import type {
  AssignSubmissionDetail,
  AssignSubmissionSummary,
  AssignmentForUserView,
  TeacherCommentBankEntryView,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu trang Bài tập (F-01 đợt 1, rà soát #133): chi tiết bài
 * tập theo đúng quyền người xem (API đã phân giải cờ canSubmit/
 * canGrade/canManage trong cùng đáp ứng). Options dùng chung cho hook
 * của trang và clientLoader của route module (prefetch cùng khoá).
 */
export function assignmentQueryOptions(assignmentId: string) {
  return queryOptions({
    queryKey: queryKeys.assignmentDetail(assignmentId),
    queryFn: () => apiJson<AssignmentForUserView>(`/api/v1/assignments/${assignmentId}`),
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
 * Các panel của trang Bài tập (F-01 của rà soát #133 — phần còn lại).
 *
 * Luồng nghiệp vụ: trang cha (pages/assignment) sở hữu dữ liệu bài
 * tập qua useAssignment; mỗi panel con tự nạp phần của nó (danh sách
 * bài nộp, chi tiết một bài nộp, ngân hàng nhận xét) vào state hiển
 * thị riêng và báo cha nạp lại qua prop reload/onChanged sau mỗi
 * thao tác. Các options/đột biến dưới đây gom lời gọi REST của các
 * panel về module này theo khuôn TanStack Query: đọc qua
 * queryOptions + khoá nhà máy (panel nạp bằng fetchQuery rồi đổ vào
 * form/state của nó), ghi qua đột biến MỎNG — nhịp làm mới vẫn do
 * panel quyết định qua các prop như bản thủ công.
 */

/** Danh sách bài nộp của lớp cho một bài tập (GET /assignments/:id/submissions). */
export function assignmentSubmissionsQueryOptions(assignmentId: string) {
  return queryOptions({
    queryKey: queryKeys.assignmentSubmissions(assignmentId),
    queryFn: () => apiJson<AssignSubmissionSummary[]>(`/api/v1/assignments/${assignmentId}/submissions`),
  });
}

/** Chi tiết một bài nộp kèm điểm/dấu chấm/hội thoại (GET /assignments/:id/submissions/:userId). */
export function submissionDetailQueryOptions(assignmentId: string, userId: string) {
  return queryOptions({
    queryKey: queryKeys.submissionDetail(assignmentId, userId),
    queryFn: () => apiJson<AssignSubmissionDetail>(`/api/v1/assignments/${assignmentId}/submissions/${userId}`),
  });
}

/** Ngân hàng câu nhận xét mẫu của giáo viên (GET /assign-comment-bank). */
export function commentBankQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.commentBank,
    queryFn: () => apiJson<TeacherCommentBankEntryView[]>('/api/v1/assign-comment-bank'),
  });
}

/** Người dùng hiện tại rút gọn (GET /users/me) — panel học sinh cần id của mình cho hội thoại phản hồi. */
export function currentUserQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.currentUser,
    queryFn: () => apiJson<{ id: string }>('/api/v1/users/me'),
  });
}

/** Thân ghi tự do của các thao tác bài tập (cấu trúc do panel dựng theo biểu mẫu của nó). */
export type AssignmentWriteBody = Record<string, unknown>;

/** Đột biến trả bài theo đợt cho cả lớp (POST /assignments/:id/release-batch). */
export function useReleaseSubmissionsBatch() {
  return useMutation({
    mutationFn: (assignmentId: string) =>
      apiJson<{ releasedCount: number; skippedUserIds: string[] }>(`/api/v1/assignments/${assignmentId}/release-batch`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
  });
}

/** Đột biến lưu gói chấm một bài nộp (POST .../submissions/:userId/grade). */
export function useGradeSubmission() {
  return useMutation({
    mutationFn: ({ assignmentId, userId, body }: { assignmentId: string; userId: string; body: AssignmentWriteBody }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/grade`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** Đột biến thả một dấu chấm trên tệp bài nộp (POST .../annotations). */
export function useAddSubmissionAnnotation() {
  return useMutation({
    mutationFn: ({ assignmentId, userId, body }: { assignmentId: string; userId: string; body: AssignmentWriteBody }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/annotations`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** Đột biến xoá một dấu chấm (DELETE .../annotations/:annotationId). */
export function useDeleteSubmissionAnnotation() {
  return useMutation({
    mutationFn: ({ assignmentId, userId, annotationId }: { assignmentId: string; userId: string; annotationId: string }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/annotations/${annotationId}`, {
        method: 'DELETE',
      }),
  });
}

/** Đột biến trả bài cho một học sinh (POST .../submissions/:userId/release). */
export function useReleaseSubmission() {
  return useMutation({
    mutationFn: ({ assignmentId, userId }: { assignmentId: string; userId: string }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/release`, { method: 'POST' }),
  });
}

/** Đột biến thêm một câu vào ngân hàng nhận xét (POST /assign-comment-bank) — trả mục vừa tạo. */
export function useCreateCommentBankEntry() {
  return useMutation({
    mutationFn: (body: { category: string; text: string }) =>
      apiJson<TeacherCommentBankEntryView>('/api/v1/assign-comment-bank', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

/** Đột biến gửi một tin trong hội thoại phản hồi của bài đã trả (POST .../submissions/:userId/messages). */
export function usePostFeedbackMessage() {
  return useMutation({
    mutationFn: ({ assignmentId, userId, body }: { assignmentId: string; userId: string; body: string }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submissions/${userId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
  });
}

/** Đột biến tải một tệp vào bản nháp bài nộp (POST .../submission/files, thân FormData). */
export function useUploadSubmissionFile() {
  return useMutation({
    mutationFn: ({ assignmentId, formData }: { assignmentId: string; formData: FormData }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submission/files`, { method: 'POST', body: formData }),
  });
}

/** Đột biến gỡ một tệp khỏi bản nháp (DELETE .../submission/files/:fileId). */
export function useDeleteSubmissionFile() {
  return useMutation({
    mutationFn: ({ assignmentId, fileId }: { assignmentId: string; fileId: string }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/submission/files/${fileId}`, { method: 'DELETE' }),
  });
}

/** Đột biến chốt nộp bài (POST .../submission/submit). */
export function useSubmitSubmission() {
  return useMutation({
    mutationFn: (assignmentId: string) => apiJson(`/api/v1/assignments/${assignmentId}/submission/submit`, { method: 'POST' }),
  });
}

/** Đột biến mở lại bài đã nộp khi chưa bị trả (POST .../submission/reopen). */
export function useReopenSubmission() {
  return useMutation({
    mutationFn: (assignmentId: string) => apiJson(`/api/v1/assignments/${assignmentId}/submission/reopen`, { method: 'POST' }),
  });
}

/** Đột biến lưu cài đặt bài tập (PATCH /assignments/:id). */
export function useUpdateAssignment() {
  return useMutation({
    mutationFn: ({ assignmentId, body }: { assignmentId: string; body: AssignmentWriteBody }) =>
      apiJson(`/api/v1/assignments/${assignmentId}`, { method: 'PATCH', body: JSON.stringify(body) }),
  });
}

/** Đột biến lưu rubric của bài tập (PUT /assignments/:id/rubric). */
export function useSaveAssignmentRubric() {
  return useMutation({
    mutationFn: ({ assignmentId, body }: { assignmentId: string; body: AssignmentWriteBody }) =>
      apiJson(`/api/v1/assignments/${assignmentId}/rubric`, { method: 'PUT', body: JSON.stringify(body) }),
  });
}

/** Đột biến xoá hẳn bài tập (DELETE /assignments/:id). */
export function useDeleteAssignment() {
  return useMutation({
    mutationFn: (assignmentId: string) => apiJson(`/api/v1/assignments/${assignmentId}`, { method: 'DELETE' }),
  });
}
