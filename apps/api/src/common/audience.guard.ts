import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedUser } from './current-user.decorator';
import { IS_PLATFORM_ROUTE_KEY } from './platform-route.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard tách audience token (issue #584) — chạy ngay sau
 * `JwtAuthGuard`, trước `TenantGuard`.
 *
 * Luật chỉ có hai chiều, không có ngoại lệ theo user hay capability:
 * - Token mang audience `platform` (cấp từ bề mặt đăng nhập quản
 *   trị platform riêng) CHỈ được gọi route mang `@PlatformRoute()`;
 *   gọi route nghiệp vụ thường → 403 `auth.audience_denied`.
 * - Token nghiệp vụ thường (không mang audience platform) CHỈ được
 *   gọi route nghiệp vụ; gọi route vận hành platform → 403
 *   `auth.audience_denied`.
 * Route `@Public()` không qua cổng này (chưa có danh tính để xét);
 * request chưa có danh tính thì `JwtAuthGuard` đã xử lý trước.
 * Phiên cookie Better Auth không mang audience nên được coi là
 * token nghiệp vụ — muốn vận hành platform thì đăng nhập lấy
 * token platform, không dùng phiên cookie.
 */
@Injectable()
export class AudienceGuard {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) return true;
    const isPlatformRoute = this.reflector.getAllAndOverride<boolean>(IS_PLATFORM_ROUTE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPlatformToken = user.audience === 'platform';
    if (isPlatformToken && !isPlatformRoute) {
      throw new ForbiddenException({
        message: 'Platform tokens cannot call business APIs',
        code: 'auth.audience_denied',
      });
    }
    if (!isPlatformToken && isPlatformRoute) {
      throw new ForbiddenException({
        message: 'Business tokens cannot call platform operations APIs',
        code: 'auth.audience_denied',
      });
    }
    return true;
  }
}
