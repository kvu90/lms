import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Global JWT guard: identity only (sub + sid). Capabilities are never taken from the token (report §3.3). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) { super(); }
  override canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    return super.canActivate(context);
  }
  override handleRequest<TUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user) throw new UnauthorizedException({ message: 'Authentication required', code: 'auth.unauthenticated' });
    return user;
  }
}
