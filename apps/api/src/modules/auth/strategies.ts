import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

/**
 * GĐ5 (issue #7): ngoại lệ token-qua-query cho stream SSE ĐÃ GỠ.
 * Từ cutover phiên cookie, EventSource cùng nguồn tự gửi cookie
 * phiên và chuỗi guard (BetterAuthSessionGuard → JwtAuthGuard)
 * xác thực như mọi route — không còn lý do cho token trong URL
 * (rò rỉ qua log/history). Access token chỉ còn qua header
 * Authorization Bearer, như mọi route khác.
 */

@Injectable()
/** Chiến lược xác thực cục bộ (username + mật khẩu) cho các guard cần kiểm tra thông tin đăng nhập trực tiếp. */
export class LocalAuthStrategy extends PassportStrategy(LocalStrategy, 'local') {
  constructor(private readonly auth: AuthService) { super(); }
  async validate(username: string, password: string): Promise<{ id: string; username: string }> {
    const user = await this.auth.validateCredentials(username, password);
    return { id: user.id, username: user.username };
  }
}

export interface JwtPayload { sub: string; username: string; sid: string; scope?: string; /** Tenant hiệu lực của phiên (TENANT-0, #168). */ tid?: string }

@Injectable()
/** Chiến lược JWT: giải mã access token và dựng principal cho request (id, username, cờ site admin). */
export class JwtAuthStrategy extends PassportStrategy(JwtStrategy, 'jwt') {
  constructor(config: ConfigService, private readonly users: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }
  /** Chỉ danh tính — và tài khoản phải còn đang hoạt động: token của người dùng bị đình chỉ/đã xoá sẽ chết tại đây. */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Challenge token của bước MFA (scope 'mfa_challenge', không có sid
    // phiên) chỉ dùng được cho POST /auth/mfa/verify — không phải access
    // token nên bị từ chối ở mọi route thường.
    if (payload.scope !== undefined || !payload.sid) {
      throw new UnauthorizedException({ message: 'Token is not an access token', code: 'auth.unauthenticated' });
    }
    const user = await this.users.getByIdOrUndefined(payload.sub);
    if (!user || user.deleted || user.suspended) {
      throw new UnauthorizedException({ message: 'Account is not active', code: 'auth.account_inactive' });
    }
    return { id: user.id, username: user.username, sessionId: payload.sid, tenantId: payload.tid };
  }
}
