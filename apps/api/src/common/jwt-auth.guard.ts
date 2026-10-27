import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { AUTHENTICATED_VIA_BETTER_AUTH } from './better-auth-session.guard';
import type { AuthenticatedUser } from './current-user.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Guard JWT toàn cục: chỉ gồm danh tính (sub + sid). Capability không bao giờ được lấy từ token (report §3.3). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }
  override canActivate(context: ExecutionContext) {
    // Danh tính đã được BetterAuthSessionGuard (chạy trước guard này)
    // xác lập từ cookie phiên Better Auth thì không đòi Bearer token —
    // ngoài trường hợp đó hành vi của guard không đổi một chút nào.
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser; [AUTHENTICATED_VIA_BETTER_AUTH]?: boolean }>();
    if (req?.[AUTHENTICATED_VIA_BETTER_AUTH] && req.user) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
  override handleRequest<TUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user) throw new UnauthorizedException({ message: 'Authentication required', code: 'auth.unauthenticated' });
    return user;
  }
}
