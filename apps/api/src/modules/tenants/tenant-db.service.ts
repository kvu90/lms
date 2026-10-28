import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import type { Database, DbTx } from '../../db/database';
import { TenantContextService } from './tenant-context.service';


/**
 * Cổng DB theo tenant (TENANT-0 #168, hoàn thiện ở TENANT-1 #196).
 *
 * Hai tầng cơ chế cùng dùng chung ALS `tenantAls`:
 *
 * 1. **Ngữ cảnh ALS (không transaction)** — `runInTenantContext` /
 *    `runInPlatformContext`: mọi kết nối PG mà `TenantAwarePool`
 *    checkout trong ngữ cảnh đều được gắn GUC `app.tenant_id` (hoặc cờ
 *    `app.platform = 'on'`) ở mức phiên và reset ở lần checkout kế tiếp,
 *    nên TOÀN BỘ truy vấn của request/job chạy dưới RLS fail-closed của
 *    đúng tenant đó mà không cần bọc transaction. Đây là đường mặc định
 *    của request HTTP (TenantGuard + TenantContextInterceptor nạp ngữ
 *    cảnh) và của các job/consumer được bọc tường minh.
 *
 * 2. **Transaction tường minh** — `withTenant` / `withPlatform` /
 *    `withCurrent`: cho các thao tác cần nguyên tử nhiều câu lệnh; GUC
 *    đặt bằng `set_config(..., true)` trong transaction, đồng thời ngữ
 *    cảnh ALS được đặt quanh transaction để kết nối của chính
 *    transaction cũng được pool gắn GUC nhất quán.
 *
 * Role ứng dụng không có BYPASSRLS; đường platform là seam duy nhất
 * vượt tenant và mọi thao tác qua đường này phải được ghi audit ở tầng
 * ứng dụng (TenantsService / SiteConfigService / event log).
 */
@Injectable()
export class TenantDbService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Chạy `fn` trong ngữ cảnh ALS của một tenant (không mở transaction). */
  async runInTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.tenantContext.run({ tenantId, userId: this.tenantContext.currentUserId() }, fn);
  }

  /**
   * Chạy `fn` trong ngữ cảnh ALS platform tường minh (không mở
   * transaction): chỉ dành cho vận hành hệ thống (relay outbox, consumer
   * phân phối nền, seed, job quét xuyên tenant) — nơi mỗi thao tác dữ
   * liệu tenant cụ thể vẫn phải tự giới hạn theo tenant của bản ghi.
   */
  async runInPlatformContext<T>(fn: () => Promise<T>): Promise<T> {
    return this.tenantContext.run({ platform: true, userId: this.tenantContext.currentUserId() }, fn);
  }

  /** Transaction trong ngữ cảnh một tenant cụ thể. */
  async withTenant<T>(tenantId: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.runInTenantContext(tenantId, () =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        await tx.execute(sql`select set_config('app.platform', 'off', true)`);
        return fn(tx);
      }),
    );
  }

  /** Transaction đường platform (vận hành xuyên tenant) — cờ phiên tường minh. */
  async withPlatform<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return this.runInPlatformContext(() =>
      this.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.platform', 'on', true)`);
        return fn(tx);
      }),
    );
  }

  /**
   * Transaction theo ngữ cảnh hiện tại: đang ở đường platform thì
   * withPlatform, có tenant hiệu lực thì withTenant, ngoài mọi ngữ cảnh
   * thì transaction thường — nhưng dưới RLS fail-closed, transaction
   * thường chỉ chạm được dòng platform (tenant_id NULL) ở các bảng cho
   * phép; mã nền phải vào một trong hai ngữ cảnh tường minh ở trên.
   */
  async withCurrent<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    if (this.tenantContext.isPlatformContext()) return this.withPlatform(fn);
    const tenantId = this.tenantContext.currentTenantId();
    if (tenantId) return this.withTenant(tenantId, fn);
    return this.db.transaction(fn);
  }
}
