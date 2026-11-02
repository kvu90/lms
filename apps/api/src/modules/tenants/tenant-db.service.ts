import { Injectable } from '@nestjs/common';
import { sql as kyselySql, type CentreTx } from '@lms/db';
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
 *    transaction cũng được pool gắn GUC nhất quán. Các wrapper chạy
 *    trên handle Kysely định tuyến (`SpaceDatabaseService.routedKysely`)
 *    và ngữ cảnh ALS mà chúng dựng GIỮ LẠI `spaceSlug` của ngữ cảnh
 *    cha — giữ slug là điều kiện để `routedKysely` vẫn trỏ đúng kho
 *    riêng của trung tâm bên trong transaction (xem ghi chú ở
 *    `withTenant`).
 *
 * Role ứng dụng không có BYPASSRLS; đường platform là seam duy nhất
 * vượt tenant và mọi thao tác qua đường này phải được ghi audit ở tầng
 * ứng dụng (TenantsService / SiteConfigService / event log).
 *
 * (Bản song song phía bộ máy cũ của năm điểm vào này đã xoá ở issue
 * #663 cùng đợt gỡ bộ máy cũ khỏi cây — chúng không còn điểm gọi nào
 * từ khi các cụm nghiệp vụ chuyển hết sang Kysely.)
 */
@Injectable()
export class TenantDbService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly spaceDb: SpaceDatabaseService,
  ) {}

  /**
   * Chạy `fn` trong ngữ cảnh ALS của một tenant (không mở
   * transaction): trường tenant/userId lấy theo đối số, nhưng ngữ
   * cảnh dựng bằng cơ chế hợp ngữ cảnh cha nên giữ `spaceSlug` định
   * tuyến; mọi truy vấn qua `routedKysely` trong `fn` chạy dưới
   * RLS của đúng tenant đó nhờ GUC mà pool gắn theo ngữ cảnh.
   */
  async runInTenantContext<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.runInContext(
      { tenantId, userId: this.tenantContext.currentUserId(), platform: false },
      fn,
    );
  }

  /**
   * Chạy `fn` trong ngữ cảnh ALS platform tường minh (không mở
   * transaction) — giữ `spaceSlug` của ngữ cảnh cha như mọi điểm
   * vào của service này; chỉ dành cho vận hành hệ thống (relay
   * outbox, consumer phân phối nền, seed, job quét xuyên tenant)
   * — nơi mỗi thao tác dữ liệu tenant cụ thể vẫn phải tự giới hạn
   * theo tenant của bản ghi.
   */
  async runInPlatformContext<T>(fn: () => Promise<T>): Promise<T> {
    return this.runInContext({ userId: this.tenantContext.currentUserId(), platform: true }, fn);
  }

  /**
   * Transaction trong ngữ cảnh một tenant cụ thể: cùng ngữ nghĩa
   * transaction + GUC như mọi wrapper của service này, chạy trên
   * handle Kysely định tuyến và trả handle giao dịch `CentreTx`
   * cho callback.
   *
   * Điểm cần giữ: ngữ cảnh ALS mà wrapper dựng GIỮ LẠI
   * `spaceSlug` của ngữ cảnh cha. Giữ slug là điều kiện để
   * `routedKysely` vẫn trỏ đúng kho riêng của trung tâm bên trong
   * transaction — wrapper mà làm rơi slug thì mọi transaction đều
   * rơi về kho chung bất kể phiên đang ở kho riêng.
   */
  async withTenant<T>(tenantId: string, fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.runInContext({ tenantId, userId: this.tenantContext.currentUserId(), platform: false }, () =>
      this.spaceDb.routedKysely.transaction().execute(async (trx) => {
        await kyselySql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        await kyselySql`select set_config('app.platform', 'off', true)`.execute(trx);
        return fn(trx);
      }),
    );
  }

  /** Transaction đường platform (vận hành xuyên tenant) — cờ phiên tường minh, giữ `spaceSlug` của ngữ cảnh cha. */
  async withPlatform<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    return this.runInContext({ userId: this.tenantContext.currentUserId(), platform: true }, () =>
      this.spaceDb.routedKysely.transaction().execute(async (trx) => {
        await kyselySql`select set_config('app.platform', 'on', true)`.execute(trx);
        return fn(trx);
      }),
    );
  }

  /**
   * Transaction theo ngữ cảnh hiện tại: đang ở đường platform thì
   * withPlatform, có tenant hiệu lực thì withTenant, ngoài mọi ngữ
   * cảnh thì transaction thường trên handle định tuyến — nhưng dưới
   * RLS fail-closed, transaction thường chỉ chạm được dòng platform
   * (tenant_id NULL) ở các bảng cho phép; mã nền phải vào một trong
   * hai ngữ cảnh tường minh ở trên.
   */
  async withCurrent<T>(fn: (tx: CentreTx) => Promise<T>): Promise<T> {
    if (this.tenantContext.isPlatformContext()) return this.withPlatform(fn);
    const tenantId = this.tenantContext.currentTenantId();
    if (tenantId) return this.withTenant(tenantId, fn);
    return this.spaceDb.routedKysely.transaction().execute(fn);
  }

  /**
   * Chạy `fn` trong ngữ cảnh ALS giữ lại `spaceSlug` của ngữ cảnh
   * cha (định tuyến kho) nhưng thay các trường tenant/platform theo
   * wrapper đang chạy — xem ghi chú ở `withTenant` về lý do giữ slug.
   */
  private runInContext<T>(store: TenantAlsStore, fn: () => Promise<T>): Promise<T> {
    const parent = tenantAls.getStore();
    return tenantAls.run({ ...parent, ...store }, fn);
  }
}
