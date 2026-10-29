import type { SiteSetting, SiteSettingAuditEntry } from '@lms/contracts';
import { apiJson } from '#lib/api';

/**
 * Tầng gọi API thuần của cụm cấu hình site thuộc feature admin: chỉ
 * chứa các hàm gọi HTTP, không phụ thuộc React hay React Query.
 * Tầng `queries/` của feature bọc các hàm này thành hook và đột
 * biến. Tách từ module phẳng `src/lib/site-config.ts` khi tổ chức
 * lại apps/web theo mô hình features/ (issue #500).
 */

/**
 * Đọc bảng cấu hình site hiện hành (GET /site-config).
 *
 * @returns Danh sách setting hiện hành.
 */
export function fetchSiteSettings() {
  return apiJson<SiteSetting[]>('/api/v1/site-config');
}

/**
 * Đọc vết thay đổi cấu hình gần nhất (GET /site-config/audit).
 *
 * @returns Danh sách mục audit gần nhất.
 */
export function fetchSiteSettingAudit() {
  return apiJson<SiteSettingAuditEntry[]>('/api/v1/site-config/audit');
}

/**
 * Lưu giá trị ghi đè của một setting (PUT /site-config/:component/:name).
 *
 * @param input - Component, tên setting và giá trị ghi đè.
 * @returns Đáp ứng của API.
 */
export function saveSiteSetting(input: { component: string; name: string; value: unknown }) {
  return apiJson(`/api/v1/site-config/${input.component}/${input.name}`, {
    method: 'PUT',
    body: JSON.stringify({ value: input.value }),
  });
}

/**
 * Xoá ghi đè của một setting để nó về mặc định trong code
 * (DELETE /site-config/:component/:name).
 *
 * @param input - Component và tên setting.
 * @returns Đáp ứng của API.
 */
export function resetSiteSetting(input: { component: string; name: string }) {
  return apiJson(`/api/v1/site-config/${input.component}/${input.name}`, { method: 'DELETE' });
}
