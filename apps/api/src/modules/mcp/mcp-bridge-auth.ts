import { createHmac, timingSafeEqual } from 'node:crypto';
import { UsersService } from '../users/users.service';

/**
 * CẦU AUTH TẠM của MCP-0 (issue #110) — KHÔNG phải OAuth 2.1 của đặc tả
 * MCP: chấp nhận access token JWT hiện hữu của hệ (cùng định dạng
 * JwtAuthStrategy đang gác REST: HS256 bằng JWT_SECRET, payload
 * { sub, username, sid }, không có `scope`, tài khoản còn hoạt động).
 * Chỉ phục vụ nghiệm thu nội bộ bằng MCP Inspector + client hỗ trợ gắn
 * header Bearer tuỳ chỉnh. AS OAuth 2.1 đầy đủ (authorize/consent/CIMD)
 * là lát MCP-1; khi đó lớp này bị thay, resource server + tools không
 * đổi vì chỉ phụ thuộc danh tính đã xác thực (actor) — xem hồ sơ
 * research MCP Phần 2.2/4.1.
 */
export interface BridgeIdentity {
  userId: string;
  username: string;
  sessionId: string;
}

function decodeJsonPart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Kiểm chữ ký HS256 + hạn + đúng loại access token; null khi bất kỳ điều kiện nào sai. */
export function verifyBridgeToken(token: string, secret: string): BridgeIdentity | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJsonPart(headerPart);
  const payload = decodeJsonPart(payloadPart);
  if (!header || header.alg !== 'HS256' || !payload) return null;
  const expected = createHmac('sha256', secret).update(`${headerPart}.${payloadPart}`).digest();
  const given = Buffer.from(signaturePart, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  // Token hết hạn bị từ chối (ignoreExpiration: false như JwtStrategy).
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return null;
  // Challenge token MFA mang `scope` và không có sid phiên — không phải
  // access token, từ chối như JwtStrategy.validate.
  if (payload.scope !== undefined || typeof payload.sid !== 'string' || payload.sid.length === 0) return null;
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  return {
    userId: payload.sub,
    username: typeof payload.username === 'string' ? payload.username : '',
    sessionId: payload.sid,
  };
}

export class McpBridgeAuth {
  constructor(
    private readonly jwtSecret: string,
    private readonly users: UsersService,
  ) {}

  /** Bearer token → danh tính còn hiệu lực; null = 401 (thiếu/sai/hết hạn token hoặc tài khoản không còn hoạt động). */
  async authenticate(authorization: string | undefined): Promise<BridgeIdentity | null> {
    if (!authorization?.startsWith('Bearer ')) return null;
    const identity = verifyBridgeToken(authorization.slice('Bearer '.length).trim(), this.jwtSecret);
    if (!identity) return null;
    const user = await this.users.getByIdOrUndefined(identity.userId);
    if (!user || user.deleted || user.suspended) return null;
    return { ...identity, username: user.username };
  }
}
