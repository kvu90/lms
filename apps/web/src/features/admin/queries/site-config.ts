import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSiteSettingAudit, fetchSiteSettings, resetSiteSetting, saveSiteSetting } from '../api/site-config';
import { queryKeys } from './keys';

/**
 * Tầng truy vấn của cụm cấu hình site thuộc feature admin: hook đọc
 * bảng cấu hình và vết thay đổi, đột biến lưu/đặt lại setting. Lời
 * gọi API thuần nằm ở tầng `api/` của feature; khoá truy vấn riêng
 * của admin nằm ở `keys.ts` cùng tầng này.
 */

/** Bảng cấu hình site hiện hành (GET /site-config). */
export function useSiteSettings() {
  return useQuery({
    queryKey: queryKeys.siteConfig,
    queryFn: () => fetchSiteSettings(),
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
    queryFn: () => fetchSiteSettingAudit().catch(() => []),
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
    mutationFn: (input: { component: string; name: string; value: unknown }) => saveSiteSetting(input),
    onSuccess: invalidate,
  });
}

/** Xoá ghi đè của một setting để nó về mặc định trong code (DELETE /site-config/:component/:name). */
export function useResetSiteSetting() {
  const invalidate = useInvalidateSiteConfig();
  return useMutation({
    mutationFn: (input: { component: string; name: string }) => resetSiteSetting(input),
    onSuccess: invalidate,
  });
}
