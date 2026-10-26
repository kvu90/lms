import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { fromNodeHeaders } from 'better-auth/node';
import { BetterAuthService } from '../auth/better-auth/better-auth.service';
import { BETTER_AUTH_SESSION_COOKIE } from '../auth/better-auth/better-auth.instance';
import { tenantAls } from '../tenants/tenant-als';
import { UsersService } from '../users/users.service';
import { MessagingRepository } from './messaging.repository';

export interface MessagingSocketIdentity {
  userId: string;
  username: string;
  /**
   * Tenant hiệu lực của phiên (claim `tid` của token, TENANT-1 #196):
   * room + khoá presence của socket được namespace theo tenant này.
   * Token cũ không mang `tid` → null (room rơi về đoạn 'platform').
   * Phiên cookie Better Auth không mang claim: tenant được phân giải
   * là tenant mặc định của user (xem authenticateCookie).
   */
  tenantId: string | null;
}

/** Phần handshake của Socket.IO mà lớp auth cần: `auth` mang theo + headers (chứa cookie). */
export interface MessagingHandshake {
  auth?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

const SESSION_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)(?:__Secure-)?${BETTER_AUTH_SESSION_COOKIE}=`);

/**
 * Lớp xác thực MỎNG cho kênh realtime của messaging — điểm chạm DUY
 * NHẤT của gateway với cơ chế auth (issue #33, chặng A1).
 *
 * Hai đường danh tính, đúng thứ tự của chuỗi guard HTTP (GĐ5 của
 * issue #7 — realtime trên cookie):
 *
 * 1. **Cookie phiên Better Auth TRƯỚC** — cùng semantics với
 *    `BetterAuthSessionGuard` phía HTTP: cờ Better Auth bật + cookie
 *    phiên có mặt + phiên hợp lệ + tài khoản còn active (không
 *    suspended/deleted) thì danh tính chốt ở đây. Cookie có nhưng
 *    phiên không dùng được (hỏng chữ ký, hết hạn, tài khoản bị khoá)
 *    thì KHÔNG kết luận từ chối — rơi xuống đường token, đúng như
 *    guard HTTP không đặt danh tính và để JwtAuthGuard quyết định.
 * 2. **Access token JWT hiện tại** làm đường dự phòng (giữ nguyên
 *    hành vi cho tới cutover GĐ2): token mang `{ sub, username, sid }`,
 *    không có `scope` (token có scope là của luồng khác, bị
 *    JwtAuthStrategy của REST từ chối), và user phải còn active. Lớp
 *    này áp đúng các kiểm đó qua cùng secret và UsersService.
 *
 * Gateway, consumer và tầng phân phối không biết gì về cơ chế bên
 * dưới — chúng chỉ nhận `MessagingSocketIdentity | null`.
 */
@Injectable()
export class MessagingSocketAuth {
  private readonly jwt: JwtService;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly users: UsersService,
    private readonly betterAuth: BetterAuthService,
    private readonly repo: MessagingRepository,
  ) {
    this.jwt = new JwtService({ secret: config.getOrThrow<string>('JWT_SECRET') });
  }

  /**
   * Xác thực toàn bộ handshake: thử cookie phiên Better Auth trước,
   * không chốt được danh tính thì thử token mang theo handshake.
   * Null nghĩa là cả hai đường đều không dùng được — gateway ngắt
   * kết nối ngay, không lộ lý do ra client.
   */
  async authenticateHandshake(handshake: MessagingHandshake): Promise<MessagingSocketIdentity | null> {
    const viaCookie = await this.authenticateCookie(handshake.headers);
    if (viaCookie) return viaCookie;
    return this.authenticate(extractHandshakeToken(handshake));
  }

  /**
   * Danh tính từ cookie phiên Better Auth trong headers của
   * handshake (trình duyệt gửi cookie cùng nguồn kèm request bắt tay
   * khi client bật `withCredentials`). Trả null cho mọi trường hợp
   * không dùng được: cờ tắt, không có cookie phiên, phiên
   * hỏng/hết hạn, user không còn active.
   *
   * Phiên cookie không mang claim tenant như JWT: tenant hiệu lực
   * được phân giải như `TenantGuard` phía HTTP khi danh tính không
   * có `tid` — tenant mặc định của user theo membership (cùng luật
   * `TenantsService.resolveDefaultTenant`, bản gương trong repo của
   * messaging), tra cứu trong ngữ cảnh platform vì đây là đường
   * tiền-ngữ-cảnh giống hệt cách TenantGuard tự phân giải.
   */
  async authenticateCookie(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<MessagingSocketIdentity | null> {
    if (!this.betterAuth.enabled) return null;
    const cookie = headers['cookie'];
    if (typeof cookie !== 'string' || !SESSION_COOKIE_PATTERN.test(cookie)) return null;
    const auth = this.betterAuth.requireAuth();
    let resolved: Awaited<ReturnType<typeof auth.api.getSession>> = null;
    try {
      resolved = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    } catch {
      // Cookie hỏng chữ ký/định dạng: coi như không có phiên Better
      // Auth, để đường token quyết định — như BetterAuthSessionGuard.
      return null;
    }
    if (!resolved) return null;
    const user = await this.users.getByIdOrUndefined(resolved.session.userId);
    if (!user || user.suspended || user.deleted) return null;
    const tenantId = await tenantAls.run({ platform: true }, () =>
      this.repo.getUserDefaultTenantId(user.id),
    );
    return { userId: user.id, username: user.username, tenantId };
  }

  /**
   * Xác thực một access token lấy từ handshake của socket. Trả null
   * cho mọi trường hợp không hợp lệ (thiếu token, sai chữ ký, hết hạn,
   * token có scope, thiếu sid, user không còn active) — gateway ngắt
   * kết nối ngay, không lộ lý do ra client.
   */
  async authenticate(token: string | undefined): Promise<MessagingSocketIdentity | null> {
    if (!token) return null;
    let payload: { sub?: string; username?: string; scope?: unknown; sid?: unknown; tid?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      return null;
    }
    // Cùng luật với JwtAuthStrategy phía REST: chỉ access token đăng
    // nhập (không scope) gắn với một phiên (sid) mới được chấp nhận.
    if (!payload.sub || payload.scope !== undefined || typeof payload.sid !== 'string') return null;
    const user = await this.users.getByIdOrUndefined(payload.sub);
    if (!user || user.suspended || user.deleted) return null;
    return {
      userId: user.id,
      username: user.username,
      tenantId: typeof payload.tid === 'string' ? payload.tid : null,
    };
  }
}

/** Token từ handshake: ưu tiên `auth.token` (socket.io client chính thức), dự phòng header Bearer. */
function extractHandshakeToken(handshake: MessagingHandshake): string | undefined {
  const authToken = (handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;
  const header = handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return undefined;
}
