import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { sql } from 'drizzle-orm';
import { sql as kyselySql, type CentreTx } from '@lms/db';
import type { Database, DbTx } from '../../db/database';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { tenantAls, type TenantAlsStore } from './tenant-als';
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
 *
 * Bản Kysely tối thiểu (`withTenantKysely` / `withPlatformKysely` /
 * `withCurrentKysely`, issue #639) giữ cùng ngữ nghĩa transaction +
 * GUC nhưng chạy trên handle Kysely định tuyến và giữ `spaceSlug`
 * của ngữ cảnh cha (xem ghi chú ở `withTenantKysely`); phần đầy
 * đủ của các wrapper Kysely thuộc việc D3.
 */
@Injectable()
export class TenantDbService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly tenantContext: TenantContextService,
    private readonly spaceDb: SpaceDatabaseService,
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

  /**
   * Biến thể Kysely TỐI THIỂU của các wrapper `with*` (issue #639,
   * mức pilot cần — phần đầy đủ thuộc việc D3): cùng ngữ nghĩa
   * transaction + GUC như bản Drizzle, nhưng chạy trên handle
   * Kysely định tuyến (`SpaceDatabaseService.routedKysely`) và trả
   * handle giao dịch `CentreTx` cho callback.
   *
   * Điểm khác biệt có chủ đích so với bản Drizzle: ngữ cảnh ALS mà
   * wrapper dựng GIỮ LẠI `spaceSlug` của ngữ cảnh cha (bản Drizzle
   * thay toàn bộ store nên làm rơi slug định tuyến). Giữ slug là
   * điều kiện để `routedKysely` vẫn trỏ đúng kho riêng của trung
   * tâm bên trong transaction — wrapper mà làm rơi slug thì mọi
   * transaction Kysely đều rơi về kho chung bất kể phiên đang ở
   * kho riêng. Việc D3 về sau sẽ đối chiếu lại bản Drizzle theo
   * cùng luật này; PR này không sửa hành vi bản Drizzle.
   */
  async withTenantKysely<T>(tenantId: string, fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.runInKyselyContext({ tenantId, userId: this.tenantContext.currentUserId(), platform: false }, () =>
      this.spaceDb.routedKysely.transaction().execute(async (trx) => {
        await kyselySql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        await kyselySql`select set_config('app.platform', 'off', true)`.execute(trx);
        return fn(trx);
      }),
    );
  }

  /** Transaction Kysely đường platform (vận hành xuyên tenant) — cờ phiên tường minh, giữ `spaceSlug` của ngữ cảnh cha. */
  async withPlatformKysely<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.runInKyselyContext({ userId: this.tenantContext.currentUserId(), platform: true }, () =>
      this.spaceDb.routedKysely.transaction().execute(async (trx) => {
        await kyselySql`select set_config('app.platform', 'on', true)`.execute(trx);
        return fn(trx);
      }),
    );
  }

  /**
   * Transaction Kysely theo ngữ cảnh hiện tại: đang ở đường platform
   * thì withPlatformKysely, có tenant hiệu lực thì withTenantKysely,
   * ngoài mọi ngữ cảnh thì transaction thường trên handle định tuyến.
   */
  async withCurrentKysely<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    if (this.tenantContext.isPlatformContext()) return this.withPlatformKysely(fn);
    const tenantId = this.tenantContext.currentTenantId();
    if (tenantId) return this.withTenantKysely(tenantId, fn);
    return this.spaceDb.routedKysely.transaction().execute(fn);
  }

  /**
   * Chạy `fn` trong ngữ cảnh ALS giữ lại `spaceSlug` của ngữ cảnh
   * cha (định tuyến kho) nhưng thay các trường tenant/platform theo
   * wrapper đang chạy — xem ghi chú ở `withTenantKysely` về lý do
   * giữ slug.
   */
  private runInKyselyContext<T>(store: TenantAlsStore, fn: () => Promise<T>): Promise<T> {
    const parent = tenantAls.getStore();
    return tenantAls.run({ ...parent, ...store }, fn);
  }
}
