import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssignRole, CreateRole, ReplaceRoleCapabilities, UpdateRole } from '@lms/contracts';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createAssignment,
  createRole,
  deleteAssignment,
  deleteRole,
  fetchRoleHolderUserIds,
  fetchUserWithAssignmentsById,
  listAssignments,
  listUsersWithAssignments,
  replaceRoleCapabilities,
  updateRole,
  type ListUsersWithAssignmentsParams,
} from '../api/admin-roles';
import { queryKeys } from './keys';

/**
 * Tầng đột biến của bề mặt quản trị vai trò thuộc feature admin.
 *
 * Luồng làm mới sau mỗi lần ghi thành công: làm mới gốc khoá `access`
 * của tầng dùng chung — danh sách vai kèm tổng hợp (`GET
 * /access/roles`) và ma trận đã lưu của vai (`GET
 * /access/roles/:id/capabilities`) đều nằm dưới tiền tố này nên cùng
 * về trạng thái mới; lưới thẻ vì thế cập nhật ngay mà không cần tải
 * lại trang. Lời gọi API thuần nằm ở tầng `api/` của feature.
 */

/** Đột biến tạo vai trò (POST /access/roles). */
export function useCreateRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: CreateRole) => createRole(draft),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.access }),
  });
}

/** Đột biến cập nhật tên/mô tả vai trò (PATCH /access/roles/:id). */
export function useUpdateRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { roleId: string; draft: UpdateRole }) => updateRole(input),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.access }),
  });
}

/** Đột biến lưu ma trận thay toàn bộ (PUT /access/roles/:id/capabilities). */
export function useReplaceRoleCapabilities() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { roleId: string; payload: ReplaceRoleCapabilities }) => replaceRoleCapabilities(input),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.access }),
  });
}

/** Đột biến xoá vai trò (DELETE /access/roles/:id). */
export function useDeleteRole() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (roleId: string) => deleteRole(roleId),
    onSuccess: () => client.invalidateQueries({ queryKey: sharedQueryKeys.access }),
  });
}

/**
 * Tuỳ chọn truy vấn trang người dùng kèm gán vai (issue #569) — khoá
 * mang đủ bộ lọc/tìm/phân trang nên bảng đổi tiêu chí nào cũng gọi
 * lại server với tham số đó; trang gọi giữ keepPreviousData để đổi
 * lọc/trang không nháy rỗng bảng. Đơn vị phân trang là người dùng.
 */
export function usersWithAssignmentsQueryOptions(params: ListUsersWithAssignmentsParams) {
  return queryOptions({
    queryKey: queryKeys.usersWithAssignments(params),
    queryFn: () => listUsersWithAssignments(params),
  });
}

/**
 * Tuỳ chọn truy vấn đúng một người dùng kèm gán vai cho chế độ lọc
 * theo người dùng của bảng (tham số `userId` trên URL) — lượt tra quét
 * các trang của endpoint gộp ở tầng `api/` vì endpoint không có tham
 * số lọc theo định danh người dùng.
 */
export function userWithAssignmentsByIdQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.userWithAssignmentsById(userId),
    queryFn: () => fetchUserWithAssignmentsById(userId),
  });
}

/**
 * Tuỳ chọn truy vấn các dòng gán vai của đúng một người dùng cho cột
 * Vai trò của trang danh sách người dùng: dùng lọc `userId` của đợt 1
 * ở cỡ trang 100 — một người giữ vai ở nhiều ngữ cảnh vẫn nằm trong
 * một trang này trong thực tế (số dòng gán của một người bị chặn bởi
 * số vai trò × số ngữ cảnh họ thật sự tham gia), và tổng server công
 * bố đi kèm để trang biết khi nào tập dòng chưa đủ.
 */
export function userAssignmentsQueryOptions(userId: string) {
  return queryOptions({
    queryKey: queryKeys.userAssignments(userId),
    queryFn: () => listAssignments({ userId, page: 1, pageSize: 100 }),
  });
}

/**
 * Tuỳ chọn truy vấn tập người giữ một vai trò tại ngữ cảnh hệ thống
 * cho bộ lọc theo vai trò của trang danh sách người dùng — phép lọc
 * chạy phía server trên endpoint gán vai, trang chỉ giao tập định
 * danh trả về với tập người dùng của chính nó.
 */
export function roleHoldersQueryOptions(roleId: string, contextId: string) {
  return queryOptions({
    queryKey: queryKeys.roleHolders(roleId, contextId),
    queryFn: () => fetchRoleHolderUserIds(roleId, contextId),
  });
}

/**
 * Đột biến gán vai từ bảng (POST /access/assignments) — thành công thì
 * làm mới cả bảng gán (gốc khoá của feature) và lưới thẻ vai (tiền tố
 * `access` chứa số người giữ), nên bảng tải lại đúng trang và bộ lọc
 * hiện hành, thẻ vai cập nhật số người giữ ngay.
 */
export function useCreateRoleAssignment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AssignRole) => createAssignment(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.roleAssignmentsRoot });
      void client.invalidateQueries({ queryKey: sharedQueryKeys.access });
    },
  });
}

/**
 * Đột biến gỡ dòng gán từ bảng (DELETE /access/assignments/:id) — làm
 * mới cùng hai gốc khoá như chiều gán để bảng và lưới thẻ cùng về
 * trạng thái mới.
 */
export function useDeleteRoleAssignment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => deleteAssignment(assignmentId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.roleAssignmentsRoot });
      void client.invalidateQueries({ queryKey: sharedQueryKeys.access });
    },
  });
}
