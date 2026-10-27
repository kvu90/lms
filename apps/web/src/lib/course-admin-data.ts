import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Cohort,
  Course,
  CourseCompletion,
  CourseGroup,
  CourseGrouping,
  EnrolInstance,
  UserEnrolment,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryClient } from './query-client';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu của trang quản trị khoá học (F-01 của rà soát #133):
 * nhóm, grouping, cohort, instance ghi danh, ghi danh, tiến độ hoàn
 * thành, chi tiết khoá (chế độ nhóm) và hội thoại chat toàn lớp.
 *
 * Quy ước giữ nguyên từ bản thủ công: các danh sách nền của trang tải
 * lỗi thì coi như rỗng (hàm truy vấn tự nuốt lỗi về giá trị dự phòng)
 * để một mảng hỏng không sập cả trang; các danh sách lười tải theo
 * dòng mở rộng (thành viên nhóm/cohort, nhóm của grouping) thì lỗi
 * nổi lên truy vấn để trang báo đúng thông điệp của mảng đó. Đột biến
 * làm mới đúng cụm khoá bị ảnh hưởng; riêng thêm/gỡ thành viên, bản
 * thủ công tải lại danh sách sau ghi (tải lại lỗi thì sửa tại chỗ) —
 * ở khuôn Query, làm mới khoá sẽ tải lại và khi tải lại lỗi thì dữ
 * liệu cũ được giữ nguyên trong bộ nhớ đệm.
 */

/** Một dòng thành viên (nhóm khoá hoặc cohort): userId + thời điểm thêm. */
export interface MemberRow {
  userId: string;
  timeAdded: string;
}

/** Hội thoại chat toàn lớp của khoá (GET ensure phía messaging). */
export interface CourseConversationView {
  id: string;
  enabled: boolean;
}

// --- Truy vấn nền của trang ---------------------------------------------------

/** Tuỳ chọn truy vấn các nhóm của khoá (GET /courses/:id/groups); lỗi tải → rỗng. */
export function courseGroupsQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseGroups(courseId),
    queryFn: () => apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groups`).catch(() => [] as CourseGroup[]),
  });
}

/** Hook đọc các nhóm của khoá cho trang quản trị. */
export function useCourseGroups(courseId: string) {
  return useQuery(courseGroupsQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn các grouping của khoá; lỗi tải → rỗng. */
export function courseGroupingsQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseGroupings(courseId),
    queryFn: () =>
      apiJson<CourseGrouping[]>(`/api/v1/courses/${courseId}/groupings`).catch(() => [] as CourseGrouping[]),
  });
}

/** Hook đọc các grouping của khoá cho trang quản trị. */
export function useCourseGroupings(courseId: string) {
  return useQuery(courseGroupingsQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn toàn bộ cohort (GET /cohorts); lỗi tải → rỗng. */
export function cohortsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.cohorts,
    queryFn: () => apiJson<Cohort[]>('/api/v1/cohorts').catch(() => [] as Cohort[]),
  });
}

/** Hook đọc danh sách cohort cho trang quản trị khoá. */
export function useCohorts() {
  return useQuery(cohortsQueryOptions());
}

/** Tuỳ chọn truy vấn các instance ghi danh của khoá; lỗi tải → rỗng. */
export function courseEnrolInstancesQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseEnrolInstances(courseId),
    queryFn: () =>
      apiJson<EnrolInstance[]>(`/api/v1/courses/${courseId}/enrol/instances`).catch(() => [] as EnrolInstance[]),
  });
}

/** Hook đọc các instance ghi danh cho trang quản trị khoá. */
export function useCourseEnrolInstances(courseId: string) {
  return useQuery(courseEnrolInstancesQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn các ghi danh của khoá; lỗi tải → rỗng. */
export function courseEnrolmentsQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseEnrolments(courseId),
    queryFn: () =>
      apiJson<UserEnrolment[]>(`/api/v1/courses/${courseId}/enrolments`).catch(() => [] as UserEnrolment[]),
  });
}

/** Hook đọc các ghi danh cho trang quản trị khoá. */
export function useCourseEnrolments(courseId: string) {
  return useQuery(courseEnrolmentsQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn tiến độ hoàn thành của khoá; lỗi tải → rỗng. */
export function courseCompletionsQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseCompletions(courseId),
    queryFn: () =>
      apiJson<CourseCompletion[]>(`/api/v1/courses/${courseId}/completion`).catch(() => [] as CourseCompletion[]),
  });
}

/** Hook đọc tiến độ hoàn thành cho trang quản trị khoá. */
export function useCourseCompletions(courseId: string) {
  return useQuery(courseCompletionsQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn chi tiết khoá (GET /courses/:id); lỗi tải → null (trang báo chưa nạp được chế độ nhóm). */
export function courseDetailQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseDetail(courseId),
    queryFn: () => apiJson<Course>(`/api/v1/courses/${courseId}`).catch(() => null),
  });
}

/** Hook đọc chi tiết khoá cho trang quản trị (khởi tạo bản nháp chế độ nhóm). */
export function useCourseDetail(courseId: string) {
  return useQuery(courseDetailQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn hội thoại chat toàn lớp (GET /messages/courses/:id/conversation); lỗi tải → null. */
export function courseConversationQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: queryKeys.courseConversation(courseId),
    queryFn: () =>
      apiJson<CourseConversationView>(`/api/v1/messages/courses/${courseId}/conversation`).catch(() => null),
  });
}

/** Hook đọc hội thoại chat toàn lớp cho trang quản trị khoá. */
export function useCourseConversation(courseId: string) {
  return useQuery(courseConversationQueryOptions(courseId));
}

// --- Truy vấn lười tải theo dòng mở rộng ---------------------------------------

/** Tuỳ chọn truy vấn thành viên của một nhóm khoá — lỗi tải nổi lên truy vấn để trang báo tin. */
export function courseGroupMembersQueryOptions(courseId: string, groupId: string) {
  return queryOptions({
    queryKey: queryKeys.courseGroupMembers(courseId, groupId),
    queryFn: () => apiJson<MemberRow[]>(`/api/v1/courses/${courseId}/groups/${groupId}/members`),
  });
}

/** Hook đọc thành viên nhóm — chỉ gắn khi nhóm đang mở nên tải lười đúng nhịp bản thủ công. */
export function useCourseGroupMembers(courseId: string, groupId: string) {
  return useQuery(courseGroupMembersQueryOptions(courseId, groupId));
}

/** Tuỳ chọn truy vấn các nhóm trong một grouping — lỗi tải nổi lên truy vấn để trang báo tin. */
export function courseGroupingGroupsQueryOptions(courseId: string, groupingId: string) {
  return queryOptions({
    queryKey: queryKeys.courseGroupingGroups(courseId, groupingId),
    queryFn: () => apiJson<CourseGroup[]>(`/api/v1/courses/${courseId}/groupings/${groupingId}/groups`),
  });
}

/** Hook đọc các nhóm của grouping — chỉ gắn khi grouping đang mở. */
export function useCourseGroupingGroups(courseId: string, groupingId: string) {
  return useQuery(courseGroupingGroupsQueryOptions(courseId, groupingId));
}

/** Tuỳ chọn truy vấn thành viên của một cohort — lỗi tải nổi lên truy vấn để trang báo tin. */
export function cohortMembersQueryOptions(cohortId: string) {
  return queryOptions({
    queryKey: queryKeys.cohortMembers(cohortId),
    queryFn: () => apiJson<MemberRow[]>(`/api/v1/cohorts/${cohortId}/members`),
  });
}

/** Hook đọc thành viên cohort — chỉ gắn khi cohort đang mở. */
export function useCohortMembers(cohortId: string) {
  return useQuery(cohortMembersQueryOptions(cohortId));
}

// --- Đột biến -------------------------------------------------------------------

/** Đột biến tạo nhóm trong khoá (POST /courses/:id/groups). */
export function useCreateCourseGroup(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiJson(`/api/v1/courses/${courseId}/groups`, { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroups(courseId) }),
  });
}

/** Đột biến đổi tên nhóm (PATCH /courses/:id/groups/:groupId, chỉ gửi `name`). */
export function useRenameCourseGroup(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, name }: { groupId: string; name: string }) =>
      apiJson(`/api/v1/courses/${courseId}/groups/${groupId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroups(courseId) }),
  });
}

/** Đột biến xoá nhóm (DELETE /courses/:id/groups/:groupId) — thành viên bị gỡ khỏi nhóm, ghi danh khoá giữ nguyên. */
export function useDeleteCourseGroup(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) =>
      apiJson(`/api/v1/courses/${courseId}/groups/${groupId}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroups(courseId) }),
  });
}

/** Đột biến thêm học viên đã ghi danh vào nhóm (POST groups/:groupId/members). */
export function useAddCourseGroupMember(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiJson(`/api/v1/courses/${courseId}/groups/${groupId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.courseGroupMembers(courseId, vars.groupId) }),
  });
}

/** Đột biến gỡ thành viên khỏi nhóm (DELETE groups/:groupId/members/:userId) — chỉ gỡ khỏi nhóm. */
export function useRemoveCourseGroupMember(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groupId, userId }: { groupId: string; userId: string }) =>
      apiJson(`/api/v1/courses/${courseId}/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.courseGroupMembers(courseId, vars.groupId) }),
  });
}

/** Đột biến lưu chế độ nhóm của khoá (PATCH /courses/:id với `groupMode` + `groupModeForce`). */
export function useSaveCourseGroupMode(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupMode: number; groupModeForce: boolean }) =>
      apiJson(`/api/v1/courses/${courseId}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseDetail(courseId) }),
  });
}

/** Đột biến bật/tắt chat toàn lớp (PATCH /messages/conversations/:id, cờ `enabled`) — ghi thẳng kết quả vào bộ nhớ đệm hội thoại của khoá. */
export function useToggleCourseConversation(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, enabled }: { conversationId: string; enabled: boolean }) =>
      apiJson<CourseConversationView>(`/api/v1/messages/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: (updated) => {
      client.setQueryData(queryKeys.courseConversation(courseId), {
        id: updated.id,
        enabled: updated.enabled,
      });
    },
  });
}

/** Đột biến mở chat của một course group (POST /messages/conversations/group) — trả về id hội thoại để deep-link. */
export function useOpenGroupConversation() {
  return useMutation({
    mutationFn: (groupId: string) =>
      apiJson<{ id: string }>('/api/v1/messages/conversations/group', {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      }),
  });
}

/** Đột biến tạo grouping (POST /courses/:id/groupings; idNumber/description tuỳ chọn). */
export function useCreateCourseGrouping(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; idNumber?: string; description?: string }) =>
      apiJson(`/api/v1/courses/${courseId}/groupings`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroupings(courseId) }),
  });
}

/** Đột biến xoá grouping (DELETE /courses/:id/groupings/:groupingId) — các nhóm trong khoá không bị xoá theo. */
export function useDeleteCourseGrouping(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (groupingId: string) =>
      apiJson(`/api/v1/courses/${courseId}/groupings/${groupingId}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroupings(courseId) }),
  });
}

/** Đột biến gắn một nhóm vào grouping (POST groupings/:groupingId/groups với `{ groupId }`). */
export function useAddGroupToGrouping(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ groupingId, groupId }: { groupingId: string; groupId: string }) =>
      apiJson(`/api/v1/courses/${courseId}/groupings/${groupingId}/groups`, {
        method: 'POST',
        body: JSON.stringify({ groupId }),
      }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.courseGroupingGroups(courseId, vars.groupingId) }),
  });
}

/** Đột biến thêm thành viên vào cohort (POST /cohorts/:id/members) — backend kích hoạt đồng bộ ghi danh theo cohort. */
export function useAddCohortMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ cohortId, userId }: { cohortId: string; userId: string }) =>
      apiJson(`/api/v1/cohorts/${cohortId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.cohortMembers(vars.cohortId) }),
  });
}

/** Đột biến gỡ thành viên khỏi cohort (DELETE /cohorts/:id/members/:userId). */
export function useRemoveCohortMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ cohortId, userId }: { cohortId: string; userId: string }) =>
      apiJson(`/api/v1/cohorts/${cohortId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.cohortMembers(vars.cohortId) }),
  });
}

/**
 * Đột biến ghi danh thủ công: chưa có instance `manual` thì tạo trước
 * (POST enrol/instances) rồi mới ghi danh người dùng vào instance đó
 * (POST enrol/instances/:id/enrol) — đúng hai bước của bản thủ công.
 */
export function useEnrolUserManually(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ manualInstanceId, userId }: { manualInstanceId: string | null; userId: string }) => {
      let instanceId = manualInstanceId;
      if (!instanceId) {
        const created = await apiJson<EnrolInstance>(`/api/v1/courses/${courseId}/enrol/instances`, {
          method: 'POST',
          body: JSON.stringify({ method: 'manual' }),
        });
        instanceId = created.id;
      }
      await apiJson(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/enrol`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.courseEnrolInstances(courseId) });
      void client.invalidateQueries({ queryKey: queryKeys.courseEnrolments(courseId) });
    },
  });
}

/** Đột biến tạm khoá/kích hoạt lại một ghi danh (POST enrol/instances/:id/users/:userId/suspend|reactivate). */
export function useToggleEnrolSuspend(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ue: UserEnrolment) => {
      const action = ue.status === 1 ? 'reactivate' : 'suspend';
      return apiJson(`/api/v1/courses/${courseId}/enrol/instances/${ue.enrolId}/users/${ue.userId}/${action}`, {
        method: 'POST',
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseEnrolments(courseId) }),
  });
}

/**
 * Nạp trước cho route quản trị khoá: tám nguồn nền của trang (cùng
 * các tuỳ chọn truy vấn trang dùng) để điều hướng tới trang không
 * phải chờ waterfalls phía client.
 */
export async function courseAdminPageClientLoader(courseId: string) {
  await Promise.allSettled([
    queryClient.ensureQueryData(courseGroupsQueryOptions(courseId)),
    queryClient.ensureQueryData(courseGroupingsQueryOptions(courseId)),
    queryClient.ensureQueryData(cohortsQueryOptions()),
    queryClient.ensureQueryData(courseEnrolInstancesQueryOptions(courseId)),
    queryClient.ensureQueryData(courseEnrolmentsQueryOptions(courseId)),
    queryClient.ensureQueryData(courseCompletionsQueryOptions(courseId)),
    queryClient.ensureQueryData(courseConversationQueryOptions(courseId)),
    queryClient.ensureQueryData(courseDetailQueryOptions(courseId)),
  ]);
  return null;
}
