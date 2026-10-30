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
   * Slug của không gian (trung tâm) trong sổ đăng ký control plane
   * mà ngữ cảnh này thuộc về — khoá định tuyến của khung kết nối
   * theo trung tâm (issue #581): handle định tuyến ở tầng dữ kiện
   * (`SpaceDatabaseService.routedDatabase`) đọc trường này để chọn
   * kho của trung tâm khi trung tâm đã ở kho riêng. Đường gắn ngữ
   * cảnh của request (SpaceContextGuard + TenantContextInterceptor,
   * issue #582) và của job (bộ chạy job theo trung tâm phía worker,
   * issue #582) nạp trường này sau bước chuẩn bị của khung; ngữ
   * cảnh không do các đường đó nạp thì không mang slug và tầng dữ
   * kiện chạy đúng đường kho chung như hiện tại. Trường này
   * KHÔNG thay `tenantId`: GUC RLS vẫn theo `tenantId`, hai định
   * danh sống ở hai tầng khác nhau (sổ đăng ký ↔ dòng tenant trong
   * kho).
   */
  spaceSlug?: string;
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
