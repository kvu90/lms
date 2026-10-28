import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTenant,
  CreateUser,
  MyTenant,
  Tenant,
  TenantMembership,
} from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Tầng dữ liệu của bề mặt quản trị tenant.
 *
 * Luồng đọc có hai chế độ được quyết định bởi trang gọi:
 * - Platform: `GET /api/v1/tenants` trả mọi tenant; trang chọn một
 *   tenant rồi đọc membership và người dùng của đúng tenant đó.
 * - Tenant: `GET /api/v1/tenants/current` chỉ trả tenant hiệu lực của
 *   phiên; trang dùng chính `id` trong đáp ứng này cho mọi lời gọi
 *   membership và người dùng, không tự suy tenant từ danh sách platform.
 *
 * Mọi thao tác ghi đều đi qua API tenant hiện có. Sau khi server xác
 * nhận, tầng này làm mới gốc khoá `admin.tenants` để danh sách tenant,
 * membership và hồ sơ người dùng cùng về trạng thái mới; riêng đổi trạng
 * thái membership còn làm mới ảnh chụp quyền vì membership là một cổng
 * trong quá trình phân giải quyền của chính người bị đổi trạng thái.
 */

/** Phần hồ sơ người dùng mà bề mặt tenant được phép tiêu thụ để ghép với membership. */
export interface TenantUserSummary {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email?: string;
  suspended: boolean;
  deleted: boolean;
}

/** Trạng thái membership có thể đặt qua API tenant. */
export type TenantMemberStatus = TenantMembership['status'];

/** Tuỳ chọn truy vấn danh sách tenant toàn hệ thống cho chế độ platform. */
export function tenantsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.tenants,
    queryFn: () => apiJson<Tenant[]>('/api/v1/tenants'),
  });
}

/**
 * Tuỳ chọn truy vấn tenant hiệu lực cho chế độ chủ trung tâm.
 *
 * Đáp ứng là bản ghi rút gọn `MyTenant` (id, slug, name, kind, active)
 * của chính người dùng đang đăng nhập — không phải bản ghi tenant đầy
 * đủ phía platform — nên tầng hiển thị không được đọc gói, trạng thái
 * vòng đời hay mốc thời gian từ đáp ứng này.
 */
export function currentTenantQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.currentTenant,
    queryFn: () => apiJson<MyTenant>('/api/v1/tenants/current'),
  });
}

/** Tuỳ chọn truy vấn membership của đúng một tenant. */
export function tenantMembersQueryOptions(tenantId: string) {
  return queryOptions({
    queryKey: queryKeys.tenantMembers(tenantId),
    queryFn: () => apiJson<TenantMembership[]>(`/api/v1/tenants/${tenantId}/members`),
    enabled: tenantId !== '',
  });
}

/** Tuỳ chọn truy vấn hồ sơ người dùng của đúng một tenant. */
export function tenantUsersQueryOptions(tenantId: string) {
  return queryOptions({
    queryKey: queryKeys.tenantUsers(tenantId),
    queryFn: () => apiJson<TenantUserSummary[]>(`/api/v1/tenants/${tenantId}/users`),
    enabled: tenantId !== '',
  });
}

/** Đột biến tạo tenant ở phạm vi platform (`POST /api/v1/tenants`). */
export function useCreateTenant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (draft: CreateTenant) =>
      apiJson<Tenant>('/api/v1/tenants', { method: 'POST', body: JSON.stringify(draft) }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tenantsRoot }),
  });
}

/** Đột biến thêm một người dùng toàn cục có sẵn vào tenant (`POST /api/v1/tenants/:id/members`). */
export function useAddTenantMember() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, userId }: { tenantId: string; userId: string }) =>
      apiJson<TenantMembership>(`/api/v1/tenants/${tenantId}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tenantsRoot }),
  });
}

/** Đột biến tạo tài khoản mới và gắn ngay vào tenant (`POST /api/v1/tenants/:id/users`). */
export function useCreateTenantUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tenantId, draft }: { tenantId: string; draft: CreateUser }) =>
      apiJson<TenantUserSummary>(`/api/v1/tenants/${tenantId}/users`, {
        method: 'POST',
        body: JSON.stringify(draft),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tenantsRoot }),
  });
}

/** Đột biến đổi trạng thái membership (`PATCH /api/v1/tenants/:id/members/:userId`). */
export function useSetTenantMemberStatus() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      tenantId,
      userId,
      status,
    }: {
      tenantId: string;
      userId: string;
      status: TenantMemberStatus;
    }) =>
      apiJson<TenantMembership>(`/api/v1/tenants/${tenantId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.tenantsRoot });
      void client.invalidateQueries({ queryKey: queryKeys.capabilities });
    },
  });
}
