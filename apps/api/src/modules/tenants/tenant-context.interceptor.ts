import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import { TenantContextService } from './tenant-context.service';

/**
 * Bọc ngữ cảnh tenant (ALS) quanh handler (TENANT-0, #168).
 *
 * Vì sao cần interceptor này thay vì chỉ `enterWith` trong
 * TenantGuard: Nest thực thi guard và handler ở hai gốc async khác
 * nhau — ngữ cảnh gắn bằng `enterWith` lúc guard chạy KHÔNG tới được
 * handler (kiểm chứng thực nghiệm bằng spec tenant-isolation: mọi bề
 * mặt đều rơi về tenant-zero). TenantGuard vì vậy ghim tenant đã phân
 * giải lên `request.tenantId`; interceptor (chạy sau guard, trước
 * handler) subscribe handler BÊN TRONG `TenantContextService.run` —
 * điểm subscribe là nơi handler thật sự được gọi, nên mọi await phía
 * sau trong request đều mang ngữ cảnh tenant đúng.
 *
 * Từ issue #582, cùng cơ chế ghim-đọc-lại này mang thêm slug của
 * trung tâm: `SpaceContextGuard` (chạy sau TenantGuard) ghim
 * `request.spaceSlug` sau khi đã chuẩn bị kho của trung tâm, và
 * interceptor nạp cả slug vào store ALS để handle định tuyến ở tầng
 * dữ kiện chọn đúng kho cho mọi truy vấn của handler.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{
      tenantId?: string;
      spaceSlug?: string;
      user?: AuthenticatedUser;
    }>();
    const tenantId = request.tenantId;
    const spaceSlug = request.spaceSlug;
    if (!tenantId && !spaceSlug) return next.handle();
    return new Observable((subscriber) => {
      const subscription = this.tenantContext.run(
        { tenantId, userId: request.user?.id, ...(spaceSlug ? { spaceSlug } : {}) },
        () => next.handle().subscribe(subscriber),
      );
      return () => subscription.unsubscribe();
    });
  }
}
