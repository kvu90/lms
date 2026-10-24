import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { BetterAuthService } from '../modules/auth/better-auth/better-auth.service';
import { BETTER_AUTH_SESSION_COOKIE } from '../modules/auth/better-auth/better-auth.instance';
import { UsersService } from '../modules/users/users.service';
import type { AuthenticatedUser } from './current-user.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Dấu hiệu trên request: danh tính đã được guard này xác lập từ phiên
 * Better Auth — JwtAuthGuard nhìn thấy dấu này thì bỏ qua, không đòi
 * Bearer token nữa (xem jwt-auth.guard.ts).
 */
export const AUTHENTICATED_VIA_BETTER_AUTH = 'authenticatedViaBetterAuth';

interface BetterAuthRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  [AUTHENTICATED_VIA_BETTER_AUTH]?: boolean;
}

const SESSION_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)(?:__Secure-)?${BETTER_AUTH_SESSION_COOKIE}=`);

/**
 * Guard mỏng của Better Auth (issue #7, Giai đoạn 1) — chạy toàn cục
 * TRƯỚC JwtAuthGuard và chỉ làm một việc: dịch cookie phiên Better Auth
 * thành đúng interface `AuthenticatedUser { id, username, sessionId }`
 * mà tầng authz và mọi service nghiệp vụ đang dùng, nên không một dòng
 * authz nào phải sửa.
 *
 * Nguyên tắc không đổi hành vi cũ:
 * - Cờ Better Auth tắt → trả true ngay, như không tồn tại.
 * - Request không mang cookie phiên Better Auth → trả true, JwtAuthGuard
 *   xử lý như hiện tại (kể cả việc ném 401).
 * - Cookie có nhưng phiên không hợp lệ/hết hạn → cũng trả true và KHÔNG
 *   đặt danh tính: quyết định từ chối vẫn thuộc về JwtAuthGuard như cũ.
 * - Phiên hợp lệ nhưng tài khoản bị suspended/deleted → không đặt danh
 *   tính (chặn dù phiên còn hạn, cùng semantics với JwtStrategy).
 *
 * `sessionId` ở đây là id của dòng phiên trong bảng `session` của
 * Better Auth — cùng vai trò `sid` của hệ JWT hiện tại.
 */
@Injectable()
export class BetterAuthSessionGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly betterAuth: BetterAuthService,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.betterAuth.enabled) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<BetterAuthRequest>();
    const cookie = req.headers['cookie'];
    if (typeof cookie !== 'string' || !SESSION_COOKIE_PATTERN.test(cookie)) return true;

    const auth = this.betterAuth.requireAuth();
    let resolved: Awaited<ReturnType<typeof auth.api.getSession>> = null;
    try {
      resolved = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    } catch {
      // Cookie hỏng chữ ký/định dạng: coi như không có phiên Better Auth,
      // để đường JWT hiện tại quyết định như trước đến nay.
      return true;
    }
    if (!resolved) return true;

    const user = await this.users.getByIdOrUndefined(resolved.session.userId);
    if (!user || user.deleted || user.suspended) return true;

    req.user = { id: user.id, username: user.username, sessionId: resolved.session.id };
    req[AUTHENTICATED_VIA_BETTER_AUTH] = true;
    return true;
  }
}
