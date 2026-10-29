import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Cohort,
  CourseCompletion,
  CourseGroup,
  CourseGrouping,
  EnrolInstance,
  UserEnrolment,
} from '@lms/contracts';
import { queryClient } from '#lib/query-client';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  addCohortMember,
  addCourseGroupMember,
  addGroupToGrouping,
  createCourseGroup,
  createCourseGrouping,
  deleteCourseGroup,
  deleteCourseGrouping,
  enrolUserManually,
  fetchCohortMembers,
  fetchCohorts,
  fetchCourseCompletions,
  fetchCourseConversation,
  fetchCourseDetail,
  fetchCourseEnrolInstances,
  fetchCourseEnrolments,
  fetchCourseGroupingGroups,
  fetchCourseGroupMembers,
  fetchCourseGroupings,
  fetchCourseGroups,
  openGroupConversation,
  removeCohortMember,
  removeCourseGroupMember,
  renameCourseGroup,
  saveCourseGroupMode,
  toggleCourseConversation,
  toggleEnrolSuspend,
} from '../api/course-admin';
import { queryKeys } from './keys';

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
 * Lời gọi API thuần nằm ở tầng `api/` của feature; khoá riêng của
 * courses nằm ở `keys.ts` cùng tầng này, riêng khoá chi tiết khoá và
 * hội thoại dùng chung nên ở lại factory tập trung.
 */

// --- Truy vấn nền của trang ---------------------------------------------------

/** Tuỳ chọn truy vấn các nhóm của khoá (GET /courses/:id/groups); lỗi tải → rỗng. */
export function courseGroupsQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.courseGroups(courseId),
    queryFn: () => fetchCourseGroups(courseId).catch(() => [] as CourseGroup[]),
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
    queryFn: () => fetchCourseGroupings(courseId).catch(() => [] as CourseGrouping[]),
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
    queryFn: () => fetchCohorts().catch(() => [] as Cohort[]),
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
      fetchCourseEnrolInstances(courseId).catch(() => [] as EnrolInstance[]),
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
      fetchCourseEnrolments(courseId).catch(() => [] as UserEnrolment[]),
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
      fetchCourseCompletions(courseId).catch(() => [] as CourseCompletion[]),
  });
}

/** Hook đọc tiến độ hoàn thành cho trang quản trị khoá. */
export function useCourseCompletions(courseId: string) {
  return useQuery(courseCompletionsQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn chi tiết khoá (GET /courses/:id); lỗi tải → null (trang báo chưa nạp được chế độ nhóm). */
export function courseDetailQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.courseDetail(courseId),
    queryFn: () => fetchCourseDetail(courseId).catch(() => null),
  });
}

/** Hook đọc chi tiết khoá cho trang quản trị (khởi tạo bản nháp chế độ nhóm). */
export function useCourseDetail(courseId: string) {
  return useQuery(courseDetailQueryOptions(courseId));
}

/** Tuỳ chọn truy vấn hội thoại chat toàn lớp (GET /messages/courses/:id/conversation); lỗi tải → null. */
export function courseConversationQueryOptions(courseId: string) {
  return queryOptions({
    queryKey: sharedQueryKeys.courseConversation(courseId),
    queryFn: () => fetchCourseConversation(courseId).catch(() => null),
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
    queryFn: () => fetchCourseGroupMembers(courseId, groupId),
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
    queryFn: () => fetchCourseGroupingGroups(courseId, groupingId),
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
    queryFn: () => fetchCohortMembers(cohortId),
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
    mutationFn: (name: string) => createCourseGroup(courseId, name),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.courseGroups(courseId) }),
  });
}

/** Đột biến đổi tên nhóm (PATCH /courses/:id/groups/:groupId, chỉ gửi `name`). */
export function useRenameCourseGroup(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupId: string; name: string }) => renameCourseGroup(courseId, input),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.courseGroups(courseId) }),
  });
}

/** Đột biến xoá nhóm (DELETE /courses/:id/groups/:groupId) — thành viên bị gỡ khỏi nhóm, ghi danh khoá giữ nguyên. */
export function useDeleteCourseGroup(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (groupId: string) => deleteCourseGroup(courseId, groupId),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.courseGroups(courseId) }),
  });
}

/** Đột biến thêm học viên đã ghi danh vào nhóm (POST groups/:groupId/members). */
export function useAddCourseGroupMember(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupId: string; userId: string }) =>
      addCourseGroupMember(courseId, input),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.courseGroupMembers(courseId, vars.groupId) }),
  });
}

/** Đột biến gỡ thành viên khỏi nhóm (DELETE groups/:groupId/members/:userId) — chỉ gỡ khỏi nhóm. */
export function useRemoveCourseGroupMember(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupId: string; userId: string }) =>
      removeCourseGroupMember(courseId, input),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.courseGroupMembers(courseId, vars.groupId) }),
  });
}

/** Đột biến lưu chế độ nhóm của khoá (PATCH /courses/:id với `groupMode` + `groupModeForce`). */
export function useSaveCourseGroupMode(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { groupMode: number; groupModeForce: boolean }) =>
      saveCourseGroupMode(courseId, body),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: sharedQueryKeys.courseDetail(courseId) }),
  });
}

/** Đột biến bật/tắt chat toàn lớp (PATCH /messages/conversations/:id, cờ `enabled`) — ghi thẳng kết quả vào bộ nhớ đệm hội thoại của khoá. */
export function useToggleCourseConversation(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { conversationId: string; enabled: boolean }) =>
      toggleCourseConversation(input),
    onSuccess: (updated) => {
      client.setQueryData(sharedQueryKeys.courseConversation(courseId), {
        id: updated.id,
        enabled: updated.enabled,
      });
    },
  });
}

/** Đột biến mở chat của một course group (POST /messages/conversations/group) — trả về id hội thoại để deep-link. */
export function useOpenGroupConversation() {
  return useMutation({
    mutationFn: (groupId: string) => openGroupConversation(groupId),
  });
}

/** Đột biến tạo grouping (POST /courses/:id/groupings; idNumber/description tuỳ chọn). */
export function useCreateCourseGrouping(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; idNumber?: string; description?: string }) =>
      createCourseGrouping(courseId, body),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroupings(courseId) }),
  });
}

/** Đột biến xoá grouping (DELETE /courses/:id/groupings/:groupingId) — các nhóm trong khoá không bị xoá theo. */
export function useDeleteCourseGrouping(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (groupingId: string) => deleteCourseGrouping(courseId, groupingId),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.courseGroupings(courseId) }),
  });
}

/** Đột biến gắn một nhóm vào grouping (POST groupings/:groupingId/groups với `{ groupId }`). */
export function useAddGroupToGrouping(courseId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { groupingId: string; groupId: string }) =>
      addGroupToGrouping(courseId, input),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({
        queryKey: queryKeys.courseGroupingGroups(courseId, vars.groupingId),
      }),
  });
}

/** Đột biến thêm thành viên vào cohort (POST /cohorts/:id/members) — backend kích hoạt đồng bộ ghi danh theo cohort. */
export function useAddCohortMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { cohortId: string; userId: string }) => addCohortMember(input),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.cohortMembers(vars.cohortId) }),
  });
}

/** Đột biến gỡ thành viên khỏi cohort (DELETE /cohorts/:id/members/:userId). */
export function useRemoveCohortMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { cohortId: string; userId: string }) => removeCohortMember(input),
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
    mutationFn: (input: { manualInstanceId: string | null; userId: string }) =>
      enrolUserManually(courseId, input),
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
    mutationFn: (ue: UserEnrolment) => toggleEnrolSuspend(courseId, ue),
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
