import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../users/users.service';

export interface MessagingSocketIdentity {
  userId: string;
  username: string;
  /**
   * Tenant hiệu lực của phiên (claim `tid` của token, TENANT-1 #196):
   * room + khoá presence của socket được namespace theo tenant này.
   * Token cũ không mang `tid` → null (room rơi về đoạn 'platform').
   */
  tenantId: string | null;
}

/**
 * Lớp xác thực MỎNG cho kênh realtime của messaging — điểm chạm DUY
 * NHẤT của gateway với cơ chế auth hiện tại (issue #33, chặng A1).
 *
 * Hiện tại hệ thống đăng nhập bằng JWT tự viết: access token mang
 * `{ sub, username, sid }`, không có `scope` (token có scope là của
 * luồng khác, bị JwtAuthStrategy của REST từ chối), và user phải còn
 * active (không suspended/deleted). Lớp này áp đúng các kiểm đó qua
 * cùng secret và UsersService.
 *
 * Khi chương trình Better Auth (issue #7) cắt authn sang cơ chế mới,
 * CHỈ file này phải đổi cách lấy danh tính từ handshake (gateway,
 * consumer và client không biết gì về cơ chế bên dưới) — giữ nguyên
 * interface `authenticate(token) → identity | null`.
 */
@Injectable()
export class JwtMessagingSocketAuth {
  private readonly jwt: JwtService;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly users: UsersService,
  ) {
    this.jwt = new JwtService({ secret: config.getOrThrow<string>('JWT_SECRET') });
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
