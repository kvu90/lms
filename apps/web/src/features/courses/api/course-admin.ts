import type {
  Cohort,
  Course,
  CourseCompletion,
  CourseGroup,
  CourseGrouping,
  EnrolInstance,
  UserEnrolment,
} from '@lms/contracts';
import { apiJson } from '#lib/api';
import type { CourseConversationView, MemberRow } from '../types/course-admin';

/**
 * Tầng gọi API thuần của trang quản trị khoá học thuộc feature
 * courses: chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay
 * React Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions, hook và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/course-admin-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc các nhóm của khoá (GET /courses/:id/groups).
 *
 * @param courseId - Định danh khoá.
 * @returns Danh sách nhóm của khoá.
 */
export function fetchCourseGroups(courseId: string) {
  return apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`);
}

/**
 * Đọc các grouping của khoá (GET /courses/:id/groupings).
 *
 * @param courseId - Định danh khoá.
 * @returns Danh sách grouping của khoá.
 */
export function fetchCourseGroupings(courseId: string) {
  return apiJson<CourseGrouping[]>(`/api/v1/courses/${courseId}/groupings`);
}

/**
 * Đọc toàn bộ cohort (GET /cohorts).
 *
 * @returns Danh sách cohort.
 */
export function fetchCohorts() {
  return apiJson<Cohort[]>('/api/v1/cohorts');
}

/**
 * Đọc các instance ghi danh của khoá (GET /courses/:id/enrol/instances).
 *
 * @param courseId - Định danh khoá.
 * @returns Danh sách instance ghi danh.
 */
export function fetchCourseEnrolInstances(courseId: string) {
  return apiJson<EnrolInstance[]>(`/api/v1/courses/${courseId}/enrol/instances`);
}

/**
 * Đọc các ghi danh của khoá (GET /courses/:id/enrolments).
 *
 * @param courseId - Định danh khoá.
 * @returns Danh sách ghi danh.
 */
export function fetchCourseEnrolments(courseId: string) {
  return apiJson<UserEnrolment[]>(`/api/v1/courses/${courseId}/enrolments`);
}

/**
 * Đọc tiến độ hoàn thành của khoá (GET /courses/:id/completion).
 *
 * @param courseId - Định danh khoá.
 * @returns Danh sách tiến độ hoàn thành.
 */
export function fetchCourseCompletions(courseId: string) {
  return apiJson<CourseCompletion[]>(`/api/v1/courses/${courseId}/completion`);
}

/**
 * Đọc chi tiết khoá (GET /courses/:id).
 *
 * @param courseId - Định danh khoá.
 * @returns Chi tiết khoá.
 */
export function fetchCourseDetail(courseId: string) {
  return apiJson<Course>(`/api/v1/courses/${courseId}`);
}

/**
 * Đọc hội thoại chat toàn lớp của khoá (GET /messages/courses/:id/conversation).
 *
 * @param courseId - Định danh khoá.
 * @returns Hội thoại chat toàn lớp.
 */
export function fetchCourseConversation(courseId: string) {
  return apiJson<CourseConversationView>(`/api/v1/messages/courses/${courseId}/conversation`);
}

/**
 * Đọc thành viên của một nhóm khoá (GET /courses/:id/groups/:groupId/members).
 *
 * @param courseId - Định danh khoá.
 * @param groupId - Định danh nhóm.
 * @returns Danh sách thành viên nhóm.
 */
export function fetchCourseGroupMembers(courseId: string, groupId: string) {
  return apiJson<MemberRow[]>(`/api/v1/courses/${courseId}/groups/${groupId}/members`);
}

/**
 * Đọc các nhóm trong một grouping (GET /courses/:id/groupings/:groupingId/groups).
 *
 * @param courseId - Định danh khoá.
 * @param groupingId - Định danh grouping.
 * @returns Danh sách nhóm của grouping.
 */
export function fetchCourseGroupingGroups(courseId: string, groupingId: string) {
  return apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groupings/${groupingId}/groups`);
}

/**
 * Đọc thành viên của một cohort (GET /cohorts/:id/members).
 *
 * @param cohortId - Định danh cohort.
 * @returns Danh sách thành viên cohort.
 */
export function fetchCohortMembers(cohortId: string) {
  return apiJson<MemberRow[]>(`/api/v1/cohorts/${cohortId}/members`);
}

/**
 * Tạo nhóm trong khoá (POST /courses/:id/groups).
 *
 * @param courseId - Định danh khoá.
 * @param name - Tên nhóm.
 * @returns Đáp ứng của API.
 */
export function createCourseGroup(courseId: string, name: string) {
  return apiJson(`/api/v1/courses/${courseId}/groups`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

/**
 * Đổi tên nhóm (PATCH /courses/:id/groups/:groupId, chỉ gửi `name`).
 *
 * @param courseId - Định danh khoá.
 * @param input - Định danh nhóm và tên mới.
 * @returns Đáp ứng của API.
 */
export function renameCourseGroup(courseId: string, input: { groupId: string; name: string }) {
  return apiJson(`/api/v1/courses/${courseId}/groups/${input.groupId}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: input.name }),
  });
}

/**
 * Xoá nhóm (DELETE /courses/:id/groups/:groupId).
 *
 * @param courseId - Định danh khoá.
 * @param groupId - Định danh nhóm.
 * @returns Đáp ứng của API.
 */
export function deleteCourseGroup(courseId: string, groupId: string) {
  return apiJson(`/api/v1/courses/${courseId}/groups/${groupId}`, { method: 'DELETE' });
}

/**
 * Thêm học viên đã ghi danh vào nhóm (POST /courses/:id/groups/:groupId/members).
 *
 * @param courseId - Định danh khoá.
 * @param input - Định danh nhóm và người dùng.
 * @returns Đáp ứng của API.
 */
export function addCourseGroupMember(
  courseId: string,
  input: { groupId: string; userId: string },
) {
  return apiJson(`/api/v1/courses/${courseId}/groups/${input.groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: input.userId }),
  });
}

/**
 * Gỡ thành viên khỏi nhóm (DELETE /courses/:id/groups/:groupId/members/:userId).
 *
 * @param courseId - Định danh khoá.
 * @param input - Định danh nhóm và người dùng.
 * @returns Đáp ứng của API.
 */
export function removeCourseGroupMember(
  courseId: string,
  input: { groupId: string; userId: string },
) {
  return apiJson(`/api/v1/courses/${courseId}/groups/${input.groupId}/members/${input.userId}`, {
    method: 'DELETE',
  });
}

/**
 * Lưu chế độ nhóm của khoá (PATCH /courses/:id với `groupMode` + `groupModeForce`).
 *
 * @param courseId - Định danh khoá.
 * @param body - Chế độ nhóm muốn lưu.
 * @returns Đáp ứng của API.
 */
export function saveCourseGroupMode(
  courseId: string,
  body: { groupMode: number; groupModeForce: boolean },
) {
  return apiJson(`/api/v1/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify(body) });
}

/**
 * Bật/tắt chat toàn lớp (PATCH /messages/conversations/:id, cờ `enabled`).
 *
 * @param input - Định danh hội thoại và cờ bật/tắt.
 * @returns Hội thoại sau khi đổi.
 */
export function toggleCourseConversation(input: { conversationId: string; enabled: boolean }) {
  return apiJson<CourseConversationView>(`/api/v1/messages/conversations/${input.conversationId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled: input.enabled }),
  });
}

/**
 * Mở chat của một course group (POST /messages/conversations/group).
 *
 * @param groupId - Định danh nhóm.
 * @returns Id hội thoại để deep-link.
 */
export function openGroupConversation(groupId: string) {
  return apiJson<{ id: string }>('/api/v1/messages/conversations/group', {
    method: 'POST',
    body: JSON.stringify({ groupId }),
  });
}

/**
 * Tạo grouping (POST /courses/:id/groupings; idNumber/description tuỳ chọn).
 *
 * @param courseId - Định danh khoá.
 * @param body - Thân tạo grouping.
 * @returns Đáp ứng của API.
 */
export function createCourseGrouping(
  courseId: string,
  body: { name: string; idNumber?: string; description?: string },
) {
  return apiJson(`/api/v1/courses/${courseId}/groupings`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Xoá grouping (DELETE /courses/:id/groupings/:groupingId).
 *
 * @param courseId - Định danh khoá.
 * @param groupingId - Định danh grouping.
 * @returns Đáp ứng của API.
 */
export function deleteCourseGrouping(courseId: string, groupingId: string) {
  return apiJson(`/api/v1/courses/${courseId}/groupings/${groupingId}`, { method: 'DELETE' });
}

/**
 * Gắn một nhóm vào grouping (POST /courses/:id/groupings/:groupingId/groups với `{ groupId }`).
 *
 * @param courseId - Định danh khoá.
 * @param input - Định danh grouping và nhóm.
 * @returns Đáp ứng của API.
 */
export function addGroupToGrouping(
  courseId: string,
  input: { groupingId: string; groupId: string },
) {
  return apiJson(`/api/v1/courses/${courseId}/groupings/${input.groupingId}/groups`, {
    method: 'POST',
    body: JSON.stringify({ groupId: input.groupId }),
  });
}

/**
 * Thêm thành viên vào cohort (POST /cohorts/:id/members) — backend
 * kích hoạt đồng bộ ghi danh theo cohort.
 *
 * @param input - Định danh cohort và người dùng.
 * @returns Đáp ứng của API.
 */
export function addCohortMember(input: { cohortId: string; userId: string }) {
  return apiJson(`/api/v1/cohorts/${input.cohortId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: input.userId }),
  });
}

/**
 * Gỡ thành viên khỏi cohort (DELETE /cohorts/:id/members/:userId).
 *
 * @param input - Định danh cohort và người dùng.
 * @returns Đáp ứng của API.
 */
export function removeCohortMember(input: { cohortId: string; userId: string }) {
  return apiJson(`/api/v1/cohorts/${input.cohortId}/members/${input.userId}`, {
    method: 'DELETE',
  });
}

/**
 * Ghi danh thủ công hai bước: chưa có instance `manual` thì tạo
 * trước (POST enrol/instances) rồi mới ghi danh người dùng vào
 * instance đó (POST enrol/instances/:id/enrol) — đúng hai bước của
 * bản thủ công.
 *
 * @param courseId - Định danh khoá.
 * @param input - Instance manual hiện có (nếu đã có) và người dùng.
 */
export async function enrolUserManually(
  courseId: string,
  input: { manualInstanceId: string | null; userId: string },
) {
  let instanceId = input.manualInstanceId;
  if (!instanceId) {
    const created = await apiJson<EnrolInstance>(`/api/v1/courses/${courseId}/enrol/instances`, {
      method: 'POST',
      body: JSON.stringify({ method: 'manual' }),
    });
    instanceId = created.id;
  }
  await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/enrol`, {
    method: 'POST',
    body: JSON.stringify({ userId: input.userId }),
  });
}

/**
 * Tạm khoá hoặc kích hoạt lại một ghi danh (POST
 * enrol/instances/:id/users/:userId/suspend|reactivate — hành động
 * suy từ trạng thái hiện tại của ghi danh).
 *
 * @param courseId - Định danh khoá.
 * @param ue - Ghi danh cần đổi trạng thái.
 * @returns Đáp ứng của API.
 */
export function toggleEnrolSuspend(courseId: string, ue: UserEnrolment) {
  const action = ue.status === 1 ? 'reactivate' : 'suspend';
  return apiJson(
    `/api/v1/courses/${courseId}/enrol/instances/${ue.enrolId}/users/${ue.userId}/${action}`,
    { method: 'POST' },
  );
}
