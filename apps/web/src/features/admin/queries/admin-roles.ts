import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AssignRole, CreateRole, ReplaceRoleCapabilities, UpdateRole } from '@lms/contracts';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import {
  createAssignment,
  createRole,
  deleteAssignment,
  deleteRole,
  listAssignments,
  replaceRoleCapabilities,
  updateRole,
  type ListAssignmentsParams,
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
 * Tuỳ chọn truy vấn trang dòng gán vai (đợt 3) — khoá mang đủ bộ lọc/
 * tìm/phân trang nên bảng đổi tiêu chí nào cũng gọi lại server với
 * tham số đó; trang gọi giữ keepPreviousData để đổi lọc/trang không
 * nháy rỗng bảng.
 */
export function roleAssignmentsQueryOptions(params: ListAssignmentsParams) {
  return queryOptions({
    queryKey: queryKeys.roleAssignments(params),
    queryFn: () => listAssignments(params),
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
