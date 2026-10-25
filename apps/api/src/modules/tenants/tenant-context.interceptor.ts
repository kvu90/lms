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
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly tenantContext: TenantContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{ tenantId?: string; user?: AuthenticatedUser }>();
    const tenantId = request.tenantId;
    if (!tenantId) return next.handle();
    return new Observable((subscriber) => {
      const subscription = this.tenantContext.run({ tenantId, userId: request.user?.id }, () =>
        next.handle().subscribe(subscriber),
      );
      return () => subscription.unsubscribe();
    });
  }
}
