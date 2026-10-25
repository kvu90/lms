import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ngữ cảnh tenant của request/job đang chạy (AsyncLocalStorage): được
 * TenantGuard nạp từ claim `tid` của token sau khi đã kiểm tra tenant +
 * membership còn hiệu lực. Các service thuộc bề mặt ĐÃ PHỦ tenant (lát
 * TENANT-0) đọc tenant hiệu lực từ đây để gắn `tenant_id` khi ghi và lọc
 * khi đọc — đây là lớp lọc ứng dụng, RLS là lưới an toàn phía DB cho các
 * transaction chạy qua TenantDbService.
 *
 * ALS trống = luồng không-HTTP (seed script, worker, test gọi thẳng
 * service): các bề mặt đã phủ rơi về tenant-zero khi cần một tenant cụ
 * thể (xem TenantsService.resolveEffectiveTenantId).
 */
export interface TenantRequestContext {
  tenantId: string;
  userId?: string;
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantRequestContext>();

  /** Chạy `fn` với ngữ cảnh tenant cho trước (guard, job nền, spec). */
  run<T>(ctx: TenantRequestContext, fn: () => T): T {
    return this.storage.run(ctx, fn);
  }

  /** Gắn ngữ cảnh cho chuỗi async hiện tại và mọi bước chạy sau trong cùng request (TenantGuard dùng). */
  enter(ctx: TenantRequestContext): void {
    this.storage.enterWith(ctx);
  }

  /** Tenant hiệu lực của luồng hiện tại; undefined khi ngoài request. */
  currentTenantId(): string | undefined {
    return this.storage.getStore()?.tenantId;
  }

  currentUserId(): string | undefined {
    return this.storage.getStore()?.userId;
  }
}
