import type {
  AssignSubmissionDetail,
  AssignSubmissionSummary,
  AssignmentForUserView,
  TeacherCommentBankEntryView,
} from '@lms/contracts';
import { apiJson } from '#lib/api';
import type { AssignmentWriteBody } from '../types/assignment';

/**
 * Tầng gọi API thuần của trang Bài tập thuộc feature assignments:
 * chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions, hook và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/assignment-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc chi tiết bài tập theo đúng quyền người xem (GET /assignments/:id).
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Chi tiết bài tập kèm các cờ quyền của người xem.
 */
export function fetchAssignment(assignmentId: string) {
  return apiJson<AssignmentForUserView>(`/api/v1/assignments/${assignmentId}`);
}

/**
 * Đọc danh sách bài nộp của lớp cho một bài tập (GET /assignments/:id/submissions).
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Danh sách bài nộp.
 */
export function fetchAssignmentSubmissions(assignmentId: string) {
  return apiJson<AssignSubmissionSummary[]>(`/api/v1/assignments/${assignmentId}/submissions`);
}

/**
 * Đọc chi tiết một bài nộp kèm điểm/dấu chấm/hội thoại
 * (GET /assignments/:id/submissions/:userId).
 *
 * @param assignmentId - Định danh bài tập.
 * @param userId - Định danh học sinh.
 * @returns Chi tiết bài nộp.
 */
export function fetchSubmissionDetail(assignmentId: string, userId: string) {
  return apiJson<AssignSubmissionDetail>(
    `/api/v1/assignments/${assignmentId}/submissions/${userId}`,
  );
}

/**
 * Đọc ngân hàng câu nhận xét mẫu của giáo viên (GET /assign-comment-bank).
 *
 * @returns Danh sách câu nhận xét mẫu.
 */
export function fetchCommentBank() {
  return apiJson<TeacherCommentBankEntryView[]>('/api/v1/assign-comment-bank');
}

/**
 * Đọc người dùng hiện tại rút gọn (GET /users/me) — panel học sinh
 * cần id của mình cho hội thoại phản hồi.
 *
 * @returns Id của người dùng hiện tại.
 */
export function fetchCurrentUser() {
  return apiJson<{ id: string }>('/api/v1/users/me');
}

/**
 * Trả bài theo đợt cho cả lớp (POST /assignments/:id/release-batch).
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Số bài đã trả và danh sách học sinh bị bỏ qua.
 */
export function releaseSubmissionsBatch(assignmentId: string) {
  return apiJson<{ releasedCount: number; skippedUserIds: string[] }>(
    `/api/v1/assignments/${assignmentId}/release-batch`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

/**
 * Lưu gói chấm một bài nộp (POST .../submissions/:userId/grade).
 *
 * @param input - Bài tập, học sinh và thân chấm do panel dựng.
 * @returns Đáp ứng của API.
 */
export function gradeSubmission(input: {
  assignmentId: string;
  userId: string;
  body: AssignmentWriteBody;
}) {
  return apiJson(`/api/v1/assignments/${input.assignmentId}/submissions/${input.userId}/grade`, {
    method: 'POST',
    body: JSON.stringify(input.body),
  });
}

/**
 * Thả một dấu chấm trên tệp bài nộp (POST .../annotations).
 *
 * @param input - Bài tập, học sinh và thân dấu chấm.
 * @returns Đáp ứng của API.
 */
export function addSubmissionAnnotation(input: {
  assignmentId: string;
  userId: string;
  body: AssignmentWriteBody;
}) {
  return apiJson(
    `/api/v1/assignments/${input.assignmentId}/submissions/${input.userId}/annotations`,
    { method: 'POST', body: JSON.stringify(input.body) },
  );
}

/**
 * Xoá một dấu chấm (DELETE .../annotations/:annotationId).
 *
 * @param input - Bài tập, học sinh và dấu chấm.
 * @returns Đáp ứng của API.
 */
export function deleteSubmissionAnnotation(input: {
  assignmentId: string;
  userId: string;
  annotationId: string;
}) {
  return apiJson(
    `/api/v1/assignments/${input.assignmentId}/submissions/${input.userId}/annotations/${input.annotationId}`,
    { method: 'DELETE' },
  );
}

/**
 * Trả bài cho một học sinh (POST .../submissions/:userId/release).
 *
 * @param input - Bài tập và học sinh.
 * @returns Đáp ứng của API.
 */
export function releaseSubmission(input: { assignmentId: string; userId: string }) {
  return apiJson(`/api/v1/assignments/${input.assignmentId}/submissions/${input.userId}/release`, {
    method: 'POST',
  });
}

/**
 * Thêm một câu vào ngân hàng nhận xét (POST /assign-comment-bank).
 *
 * @param body - Nhóm và nội dung câu nhận xét.
 * @returns Mục vừa tạo.
 */
export function createCommentBankEntry(body: { category: string; text: string }) {
  return apiJson<TeacherCommentBankEntryView>('/api/v1/assign-comment-bank', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Gửi một tin trong hội thoại phản hồi của bài đã trả
 * (POST .../submissions/:userId/messages).
 *
 * @param input - Bài tập, học sinh và nội dung tin.
 * @returns Đáp ứng của API.
 */
export function postFeedbackMessage(input: {
  assignmentId: string;
  userId: string;
  body: string;
}) {
  return apiJson(
    `/api/v1/assignments/${input.assignmentId}/submissions/${input.userId}/messages`,
    { method: 'POST', body: JSON.stringify({ body: input.body }) },
  );
}

/**
 * Tải một tệp vào bản nháp bài nộp (POST .../submission/files, thân FormData).
 *
 * @param input - Bài tập và FormData chứa tệp.
 * @returns Đáp ứng của API.
 */
export function uploadSubmissionFile(input: { assignmentId: string; formData: FormData }) {
  return apiJson(`/api/v1/assignments/${input.assignmentId}/submission/files`, {
    method: 'POST',
    body: input.formData,
  });
}

/**
 * Gỡ một tệp khỏi bản nháp (DELETE .../submission/files/:fileId).
 *
 * @param input - Bài tập và tệp.
 * @returns Đáp ứng của API.
 */
export function deleteSubmissionFile(input: { assignmentId: string; fileId: string }) {
  return apiJson(`/api/v1/assignments/${input.assignmentId}/submission/files/${input.fileId}`, {
    method: 'DELETE',
  });
}

/**
 * Chốt nộp bài (POST .../submission/submit).
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Đáp ứng của API.
 */
export function submitSubmission(assignmentId: string) {
  return apiJson(`/api/v1/assignments/${assignmentId}/submission/submit`, { method: 'POST' });
}

/**
 * Mở lại bài đã nộp khi chưa bị trả (POST .../submission/reopen).
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Đáp ứng của API.
 */
export function reopenSubmission(assignmentId: string) {
  return apiJson(`/api/v1/assignments/${assignmentId}/submission/reopen`, { method: 'POST' });
}

/**
 * Lưu cài đặt bài tập (PATCH /assignments/:id).
 *
 * @param input - Bài tập và thân cài đặt.
 * @returns Đáp ứng của API.
 */
export function updateAssignment(input: { assignmentId: string; body: AssignmentWriteBody }) {
  return apiJson(`/api/v1/assignments/${input.assignmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(input.body),
  });
}

/**
 * Lưu rubric của bài tập (PUT /assignments/:id/rubric).
 *
 * @param input - Bài tập và thân rubric.
 * @returns Đáp ứng của API.
 */
export function saveAssignmentRubric(input: { assignmentId: string; body: AssignmentWriteBody }) {
  return apiJson(`/api/v1/assignments/${input.assignmentId}/rubric`, {
    method: 'PUT',
    body: JSON.stringify(input.body),
  });
}

/**
 * Xoá hẳn bài tập (DELETE /assignments/:id).
 *
 * @param assignmentId - Định danh bài tập.
 * @returns Đáp ứng của API.
 */
export function deleteAssignment(assignmentId: string) {
  return apiJson(`/api/v1/assignments/${assignmentId}`, { method: 'DELETE' });
}
