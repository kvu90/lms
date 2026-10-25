import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ngữ cảnh tenant dùng chung cho toàn tiến trình WORKER (TENANT-1,
 * #196) — bản sao của `apps/api/src/modules/tenants/tenant-als.ts`
 * theo tiền lệ repo (mỗi app giữ bản sao hạ tầng riêng, vd
 * event-log-writer).
 *
 * Singleton AsyncLocalStorage nằm ở module trung lập không phụ thuộc
 * Nest để cả hai phía cùng đọc/ghi MỘT thực thể: phía job/scheduler
 * (bọc ngữ cảnh tường minh khi chạy) và phía hạ tầng
 * (`TenantAwarePool` — gắn GUC `app.tenant_id` / `app.platform` lên
 * mọi kết nối PG được checkout trong ngữ cảnh này). Worker không có
 * request HTTP: mọi scheduler/processor phải TỰ bọc ngữ cảnh — quét
 * xuyên tenant dùng ngữ cảnh platform, xử lý bản ghi của một tenant
 * thì dùng ngữ cảnh của tenant đó. Ngoài ngữ cảnh, pool gắn GUC rỗng
 * (fail-closed: chỉ thấy dòng platform ở các bảng cho phép).
 */
export interface TenantAlsStore {
  /** Tenant hiệu lực; undefined khi ngữ cảnh là đường platform hoặc ngoài ngữ cảnh. */
  tenantId?: string;
  userId?: string;
  /**
   * Đường platform tường minh (vận hành xuyên tenant): kết nối được
   * gắn cờ `app.platform = 'on'`. Chỉ mã vận hành hệ thống (relay
   * outbox, scheduler quét xuyên tenant) mới được vào ngữ cảnh này.
   */
  platform?: boolean;
}

export const tenantAls = new AsyncLocalStorage<TenantAlsStore>();
