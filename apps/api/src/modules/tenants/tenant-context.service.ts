import { Injectable } from '@nestjs/common';
import { tenantAls, type TenantAlsStore } from './tenant-als';

export type TenantRequestContext = TenantAlsStore;

/**
 * Ngữ cảnh tenant của request/job đang chạy (AsyncLocalStorage dùng
 * chung `tenantAls`): được TenantGuard nạp từ claim `tid` của token sau
 * khi đã kiểm tra tenant + membership còn hiệu lực. Các service thuộc bề
 * mặt đã phủ tenant đọc tenant hiệu lực từ đây để gắn `tenant_id` khi
 * ghi và lọc khi đọc — lớp lọc ứng dụng; RLS là lưới cứng ở tầng DB.
 *
 * Từ TENANT-1 (#196), cùng ALS này còn là nguồn cho `TenantAwarePool`:
 * mọi kết nối PG checkout trong ngữ cảnh đều được gắn GUC
 * `app.tenant_id`/`app.platform` tương ứng, nên RLS fail-closed cưỡng
 * chế ngay cả với truy vấn không qua `TenantDbService`. Ngữ cảnh
 * `platform: true` chỉ do đường vận hành tường minh đặt
 * (TenantDbService) — TenantGuard không bao giờ đặt.
 *
 * ALS trống = luồng không-HTTP chưa vào ngữ cảnh tường minh (seed/
 * worker/consumer phải tự bọc bằng TenantDbService): kết nối không gắn
 * GUC tenant và RLS fail-closed chỉ cho thấy dòng platform
 * (tenant_id NULL) ở các bảng cho phép — không còn đường im lặng.
 */
@Injectable()
export class TenantContextService {
  /** Chạy `fn` với ngữ cảnh tenant cho trước (guard, job nền, spec). */
  run<T>(ctx: TenantRequestContext, fn: () => T): T {
    return tenantAls.run(ctx, fn);
  }

  /** Gắn ngữ cảnh cho chuỗi async hiện tại và mọi bước chạy sau trong cùng request (TenantGuard dùng). */
  enter(ctx: TenantRequestContext): void {
    tenantAls.enterWith(ctx);
  }

  /** Tenant hiệu lực của luồng hiện tại; undefined khi ngoài request hoặc đang ở đường platform. */
  currentTenantId(): string | undefined {
    return tenantAls.getStore()?.tenantId;
  }

  currentUserId(): string | undefined {
    return tenantAls.getStore()?.userId;
  }

  /** Luồng hiện tại có đang chạy ở đường platform tường minh không. */
  isPlatformContext(): boolean {
    return tenantAls.getStore()?.platform === true;
  }
}
