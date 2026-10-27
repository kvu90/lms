import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Capability, Role } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Một dòng cây context phân quyền (GET /access/contexts). */
export interface ContextRow {
  id: string;
  contextLevel: number;
  instanceId: string;
  path: string;
}

/** Một dòng ma trận capability của một vai (GET /access/roles/:id/capabilities). */
export interface RoleCapabilityRow {
  roleId: string;
  capability: string;
  contextId: string;
  permission: number;
}

/** Danh sách vai trò (GET /access/roles) — dùng chung khoá factory với các bề mặt quản trị khác. */
export function useAccessRoles() {
  return useQuery({
    queryKey: queryKeys.roles,
    queryFn: () => apiJson<Role[]>('/api/v1/access/roles'),
  });
}

/** Danh mục capability của hệ (GET /access/capabilities). */
export function useAccessCapabilities() {
  return useQuery({
    queryKey: queryKeys.accessCapabilities,
    queryFn: () => apiJson<Capability[]>('/api/v1/access/capabilities'),
  });
}

/** Tuỳ chọn truy vấn cây context phân quyền (GET /access/contexts) — dùng chung cho hook và clientLoader. */
export function accessContextsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.accessContexts,
    queryFn: () => apiJson<ContextRow[]>('/api/v1/access/contexts'),
  });
}

/** Cây context phân quyền (GET /access/contexts). */
export function useAccessContexts() {
  return useQuery(accessContextsQueryOptions());
}

/** Ma trận capability của một vai — chỉ tải khi vai được chọn xem ma trận. */
export function useRoleCapabilities(roleId: string | null) {
  return useQuery({
    queryKey: queryKeys.roleCapabilities(roleId ?? ''),
    queryFn: () => apiJson<RoleCapabilityRow[]>(`/api/v1/access/roles/${roleId}/capabilities`),
    enabled: roleId !== null,
  });
}

/**
 * Gán một vai cho người dùng tại một context (POST /access/assignments).
 * Sau khi gán: làm mới mọi truy vấn access (tiền tố factory) và ảnh chụp
 * capability — nếu người được gán là chính người đang đăng nhập thì bề mặt
 * quyền của họ phải thấy vai mới mà không cần tải lại trang.
 */
export function useCreateAssignment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { userId: string; roleId: string; contextId: string }) =>
      apiJson('/api/v1/access/assignments', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.access });
      void queryClient.invalidateQueries({ queryKey: queryKeys.capabilities });
    },
  });
}
