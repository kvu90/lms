import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { TenantContextService } from './tenant-context.service';

export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Wrapper transaction gắn ngữ cảnh tenant vào phiên DB (TENANT-0, #168 —
 * hồ sơ mục 3.3): mọi truy vấn trong transaction chạy với GUC
 * `app.tenant_id` (hoặc cờ `app.platform = 'on'` cho đường platform) để
 * ROW LEVEL SECURITY (ENABLE + FORCE + policy trên các bảng đã mang
 * tenant_id) cưỡng chế cách ly ở tầng DB — truy vấn thô quên lọc
 * tenant_id trong một phiên tenant vẫn chỉ thấy dữ liệu của tenant đó.
 *
 * GUC đặt bằng `set_config(..., true)` = phạm vi transaction, tự mất khi
 * transaction kết thúc nên không rò sang kết nối pooled khác. Role ứng
 * dụng không có BYPASSRLS; luồng platform phải đi qua `withPlatform` —
 * cờ phiên tường minh, mọi thao tác qua đường này đều được ghi audit ở
 * tầng ứng dụng (TenantsService / SiteConfigService).
 */
@Injectable()
export class TenantDbService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Transaction trong ngữ cảnh một tenant cụ thể. */
  async withTenant<T>(tenantId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(sql`select set_config('app.platform', 'off', true)`);
      return fn(tx);
    });
  }

  /** Transaction đường platform (vận hành xuyên tenant) — cờ phiên tường minh. */
  async withPlatform<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.platform', 'on', true)`);
      return fn(tx);
    });
  }

  /**
   * Transaction theo ngữ cảnh request hiện tại: có tenant hiệu lực thì
   * withTenant, ngoài request (seed/worker) thì transaction thường —
   * policy RLS chỉ siết khi GUC được đặt (xem migration baseline).
   */
  async withCurrent<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    const tenantId = this.tenantContext.currentTenantId();
    if (tenantId) return this.withTenant(tenantId, fn);
    return this.db.transaction(fn);
  }
}
