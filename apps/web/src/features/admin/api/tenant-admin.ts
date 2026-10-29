import type { CreateTenant, CreateUser, Tenant, TenantMembership } from '@lms/contracts';
import { apiJson } from '#lib/api';
import type { TenantMemberStatus, TenantUserSummary } from '../types/tenant-admin';

/**
 * Tầng gọi API thuần của bề mặt quản trị tenant thuộc feature
 * admin: chỉ chứa các hàm gọi HTTP, không phụ thuộc React hay React
 * Query. Tầng `queries/` của feature bọc các hàm này thành
 * queryOptions và đột biến. Tách từ module dữ liệu phẳng
 * `src/lib/tenant-admin-data.ts` khi tổ chức lại apps/web theo mô
 * hình features/ (issue #500).
 */

/**
 * Đọc danh sách tenant toàn hệ thống cho chế độ platform
 * (GET /api/v1/tenants).
 *
 * @returns Mọi tenant của hệ thống.
 */
export function fetchTenants() {
  return apiJson<Tenant[]>('/api/v1/tenants');
}

/**
 * Đọc tenant hiệu lực của phiên cho chế độ chủ trung tâm
 * (GET /api/v1/tenants/current).
 *
 * @returns Bản ghi tenant đầy đủ đang hiệu lực trong phiên.
 */
export function fetchCurrentTenant() {
  return apiJson<Tenant>('/api/v1/tenants/current');
}

/**
 * Đọc membership của đúng một tenant (GET /api/v1/tenants/:id/members).
 *
 * @param tenantId - Định danh tenant.
 * @returns Danh sách membership của tenant.
 */
export function fetchTenantMembers(tenantId: string) {
  return apiJson<TenantMembership[]>(`/api/v1/tenants/${tenantId}/members`);
}

/**
 * Đọc hồ sơ người dùng của đúng một tenant (GET /api/v1/tenants/:id/users).
 *
 * @param tenantId - Định danh tenant.
 * @returns Danh sách hồ sơ người dùng của tenant.
 */
export function fetchTenantUsers(tenantId: string) {
  return apiJson<TenantUserSummary[]>(`/api/v1/tenants/${tenantId}/users`);
}

/**
 * Tạo tenant ở phạm vi platform (POST /api/v1/tenants).
 *
 * @param draft - Thân tạo tenant.
 * @returns Tenant vừa tạo.
 */
export function createTenant(draft: CreateTenant) {
  return apiJson<Tenant>('/api/v1/tenants', { method: 'POST', body: JSON.stringify(draft) });
}

/**
 * Thêm một người dùng toàn cục có sẵn vào tenant
 * (POST /api/v1/tenants/:id/members).
 *
 * @param input - Định danh tenant và người dùng.
 * @returns Membership vừa tạo.
 */
export function addTenantMember(input: { tenantId: string; userId: string }) {
  return apiJson<TenantMembership>(`/api/v1/tenants/${input.tenantId}/members`, {
    method: 'POST',
    body: JSON.stringify({ userId: input.userId }),
  });
}

/**
 * Tạo tài khoản mới và gắn ngay vào tenant (POST /api/v1/tenants/:id/users).
 *
 * @param input - Định danh tenant và thân tạo người dùng.
 * @returns Hồ sơ người dùng vừa tạo.
 */
export function createTenantUser(input: { tenantId: string; draft: CreateUser }) {
  return apiJson<TenantUserSummary>(`/api/v1/tenants/${input.tenantId}/users`, {
    method: 'POST',
    body: JSON.stringify(input.draft),
  });
}

/**
 * Đổi trạng thái membership (PATCH /api/v1/tenants/:id/members/:userId).
 *
 * @param input - Định danh tenant, người dùng và trạng thái muốn đặt.
 * @returns Membership sau khi đổi.
 */
export function setTenantMemberStatus(input: {
  tenantId: string;
  userId: string;
  status: TenantMemberStatus;
}) {
  return apiJson<TenantMembership>(`/api/v1/tenants/${input.tenantId}/members/${input.userId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: input.status }),
  });
}
