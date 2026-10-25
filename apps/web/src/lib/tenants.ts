import type { MyTenant, TokenPair } from '@lms/contracts';
import { apiJson, tokenStore } from './api';

/**
 * Bộ chọn tenant (TENANT-0, #168): người dùng thuộc nhiều tenant (giáo
 * viên dạy hai trường, admin vận hành) chuyển không gian làm việc trong
 * phiên qua POST /auth/switch-tenant — máy chủ thu hồi family token cũ
 * và cấp cặp mới mang claim `tid` của tenant đích; giao diện nạp lại
 * toàn bộ để mọi dữ liệu theo tenant hiệu lực mới. Người chỉ thuộc một
 * tenant thì không thấy bộ chọn.
 */
export async function fetchMyTenants(): Promise<MyTenant[]> {
  return apiJson<MyTenant[]>('/auth/tenants');
}

/** Chuyển tenant: lưu cặp token mới rồi nạp lại trang để áp dụng ngữ cảnh mới ở mọi bề mặt. */
export async function switchTenant(tenantId: string): Promise<void> {
  const pair = await apiJson<TokenPair>(`/auth/switch-tenant/${tenantId}`, { method: 'POST' });
  tokenStore.save(pair);
  window.location.reload();
}
