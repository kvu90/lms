import type { MyTenant } from '@lms/contracts';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/**
 * Bộ chọn tenant (TENANT-0, #168): người dùng thuộc nhiều tenant (giáo
 * viên dạy hai trường, admin vận hành) chuyển không gian làm việc trong
 * phiên qua POST /auth/switch-tenant — máy chủ đổi ngữ cảnh tenant
 * gắn với phiên hiện tại (sau GĐ2 là phiên cookie Better Auth; xem
 * switchTenant bên dưới); giao diện nạp lại toàn bộ để mọi dữ liệu
 * theo tenant hiệu lực mới. Người chỉ thuộc một tenant thì không
 * thấy bộ chọn.
 */
export async function fetchMyTenants(): Promise<MyTenant[]> {
  return apiJson<MyTenant[]>('/api/v1/auth/tenants');
}

/**
 * Tuỳ chọn truy vấn các tenant người dùng là thành viên (GET
 * /api/v1/auth/tenants): mục chuyển không gian đọc qua TanStack để
 * hưởng cache + dedupe theo khoá nhà máy thay cho fetch tay trong
 * effect.
 */
export function myTenantsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.myTenants,
    queryFn: () => fetchMyTenants(),
  });
}

/** Hook đọc các tenant người dùng là thành viên cho mục chuyển không gian; lỗi tải cho dữ kiện vắng (mục bị ẩn như trước). */
export function useMyTenants() {
  return useQuery(myTenantsQueryOptions());
}

/**
 * Chuyển tenant: sau cutover phiên cookie (issue #7, GĐ2) web không
 * còn giữ token để ghi đè — hiệu lực đổi tenant phải nằm ở chính
 * phiên cookie phía server (đội BA-4 chuẩn hoá switch-tenant thành
 * cookie-effective trước khi bật cờ cutover; đáp ứng vẫn có thể trả
 * cặp token cho client bearer khác, web BỎ QUA phần đó). Nạp lại
 * trang để áp dụng ngữ cảnh mới ở mọi bề mặt (loader SSR + cache).
 */
export async function switchTenant(tenantId: string): Promise<void> {
  await apiJson(`/api/v1/auth/switch-tenant/${tenantId}`, { method: 'POST' });
  window.location.reload();
}
