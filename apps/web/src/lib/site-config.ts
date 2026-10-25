import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SiteSetting, SiteSettingAuditEntry } from '@lms/contracts';
import { apiJson } from './api';
import { queryKeys } from './query-keys';

/** Bảng cấu hình site hiện hành (GET /site-config). */
export function useSiteSettings() {
  return useQuery({
    queryKey: queryKeys.siteConfig,
    queryFn: () => apiJson<SiteSetting[]>('/api/v1/site-config'),
  });
}

/**
 * Vết thay đổi cấu hình gần nhất (GET /site-config/audit). Lỗi ở truy vấn
 * này không bao giờ làm hỏng trang (hạ cấp thành danh sách rỗng, đúng hành
 * vi cũ) và chỉ tải sau khi bảng cấu hình tải xong.
 */
export function useSiteSettingAudit(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.siteConfigAudit,
    queryFn: () => apiJson<SiteSettingAuditEntry[]>('/api/v1/site-config/audit').catch(() => []),
    enabled,
  });
}

/** Làm mới bảng cấu hình + audit sau khi lưu/đặt lại một setting. */
function useInvalidateSiteConfig() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.siteConfig });
}

/** Lưu giá trị ghi đè của một setting (PUT /site-config/:component/:name). */
export function useSaveSiteSetting() {
  const invalidate = useInvalidateSiteConfig();
  return useMutation({
    mutationFn: (input: { component: string; name: string; value: unknown }) =>
      apiJson(`/api/v1/site-config/${input.component}/${input.name}`, {
        method: 'PUT',
        body: JSON.stringify({ value: input.value }),
      }),
    onSuccess: invalidate,
  });
}

/** Xoá ghi đè của một setting để nó về mặc định trong code (DELETE /site-config/:component/:name). */
export function useResetSiteSetting() {
  const invalidate = useInvalidateSiteConfig();
  return useMutation({
    mutationFn: (input: { component: string; name: string }) =>
      apiJson(`/api/v1/site-config/${input.component}/${input.name}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}
