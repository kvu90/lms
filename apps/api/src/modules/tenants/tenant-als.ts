import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ngữ cảnh tenant dùng chung cho toàn tiến trình API (TENANT-1, #196).
 *
 * Singleton AsyncLocalStorage nằm ở module trung lập không phụ thuộc
 * Nest để cả hai phía cùng đọc/ghi MỘT thực thể: phía Nest
 * (`TenantContextService`, do TenantGuard/interceptor nạp) và phía hạ
 * tầng (`TenantAwarePool` trong config/env — gắn GUC `app.tenant_id` /
 * `app.platform` lên mọi kết nối PG được checkout trong ngữ cảnh này).
 * Nếu mỗi phía giữ một ALS riêng, GUC sẽ không bao giờ khớp ngữ cảnh
 * request — đó là lý do file này tồn tại thay vì để ALS trong service.
 */
export interface TenantAlsStore {
  /** Tenant hiệu lực; undefined khi ngữ cảnh là đường platform hoặc ngoài request. */
  tenantId?: string;
  userId?: string;
  /**
   * Đường platform tường minh (vận hành xuyên tenant qua
   * `TenantDbService.withPlatform`/`runInPlatformContext`): kết nối được
   * gắn cờ `app.platform = 'on'`. Chỉ mã vận hành hệ thống (relay outbox,
   * consumer phân phối, seed) mới được vào ngữ cảnh này — mọi bề mặt
   * nghiệp vụ chạy trong ngữ cảnh tenant thường.
   */
  platform?: boolean;
}

export const tenantAls = new AsyncLocalStorage<TenantAlsStore>();
