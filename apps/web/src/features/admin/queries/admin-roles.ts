import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { CreateRole, ReplaceRoleCapabilities, UpdateRole } from '@lms/contracts';
import { queryKeys as sharedQueryKeys } from '#lib/query-keys';
import { createRole, deleteRole, replaceRoleCapabilities, updateRole } from '../api/admin-roles';

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
