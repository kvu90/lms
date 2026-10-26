import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { MessagingSocketAuth } from './messaging-socket-auth';

/**
 * GĐ5 (issue #7): gateway realtime xác thực hai đường, cookie phiên
 * Better Auth TRƯỚC, access token JWT làm đường dự phòng.
 *
 * - Cookie hợp lệ (cờ bật, phiên dùng được, tài khoản còn active) →
 *   danh tính chốt ở cookie, tenant = tenant mặc định của user (phiên
 *   cookie không mang claim `tid` như JWT).
 * - Cookie không dùng được (cờ tắt, hỏng chữ ký, hết hạn, tài khoản
 *   bị khoá) → KHÔNG từ chối ngay mà rơi xuống đường token, đúng
 *   semantics của BetterAuthSessionGuard phía HTTP.
 * - Đường token giữ nguyên luật cũ: chỉ access token đăng nhập (không
 *   scope, có sid), tài khoản còn active; token có scope/thiếu sid/
 *   sai chữ ký → null, gateway ngắt kết nối.
 */
describe('MessagingSocketAuth — dual auth cookie + token (GĐ5)', () => {
  const SECRET = 'test-jwt-secret-gd5';

  function build(opts: {
    betterAuthEnabled?: boolean;
    getSession?: unknown;
    getSessionThrows?: boolean;
    defaultTenantId?: string | null;
    suspended?: boolean;
  } = {}) {
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => ({
        id, username: `user-${id}`, suspended: opts.suspended ?? false, deleted: false,
      })),
    };
    const betterAuth = {
      enabled: opts.betterAuthEnabled ?? true,
      requireAuth: vi.fn(() => ({
        api: {
          getSession: vi.fn(async () => {
            if (opts.getSessionThrows) throw new Error('bad signature');
            return opts.getSession ?? null;
          }),
        },
      })),
    };
    const repo = {
      getUserDefaultTenantId: vi.fn(async () => opts.defaultTenantId ?? null),
    };
    const config = { getOrThrow: vi.fn(() => SECRET) };
    const auth = new MessagingSocketAuth(
      config as never,
      users as never,
      betterAuth as never,
      repo as never,
    );
    return { auth, users, betterAuth, repo };
  }

  function sign(payload: Record<string, unknown>): string {
    return new JwtService({ secret: SECRET }).sign(payload);
  }

  const sessionValue = { session: { userId: 'u1' }, user: { id: 'u1' } };

  it('cookie hợp lệ → danh tính từ cookie, tenant mặc định của user', async () => {
    const { auth } = build({ getSession: sessionValue, defaultTenantId: 'tenant-default' });
    const identity = await auth.authenticateHandshake({
      headers: { cookie: 'better-auth.session_token=abc123' },
    });
    expect(identity).toEqual({ userId: 'u1', username: 'user-u1', tenantId: 'tenant-default' });
  });

  it('cookie có tiền tố __Secure- vẫn nhận', async () => {
    const { auth } = build({ getSession: sessionValue, defaultTenantId: null });
    const identity = await auth.authenticateHandshake({
      headers: { cookie: 'other=x; __Secure-better-auth.session_token=abc123' },
    });
    expect(identity?.userId).toBe('u1');
  });

  it('cờ Better Auth tắt → bỏ qua cookie, dùng token dự phòng', async () => {
    const token = sign({ sub: 'u2', username: 'u2', sid: 's1', tid: 'tenant-t' });
    const { auth } = build({ betterAuthEnabled: false, getSession: sessionValue });
    const identity = await auth.authenticateHandshake({
      headers: { cookie: 'better-auth.session_token=abc123' },
      auth: { token },
    });
    expect(identity).toEqual({ userId: 'u2', username: 'user-u2', tenantId: 'tenant-t' });
  });

  it('phiên cookie hỏng → rơi xuống token dự phòng thay vì từ chối ngay', async () => {
    const token = sign({ sub: 'u3', username: 'u3', sid: 's1' });
    const { auth } = build({ getSessionThrows: true });
    const identity = await auth.authenticateHandshake({
      headers: { cookie: 'better-auth.session_token=bad' },
      auth: { token },
    });
    expect(identity).toEqual({ userId: 'u3', username: 'user-u3', tenantId: null });
  });

  it('cookie hợp lệ nhưng tài khoản bị khoá → null khi không có token', async () => {
    const { auth } = build({ getSession: sessionValue, suspended: true });
    const identity = await auth.authenticateHandshake({
      headers: { cookie: 'better-auth.session_token=abc123' },
    });
    expect(identity).toBeNull();
  });

  it('token có scope → null (không phải access token đăng nhập)', async () => {
    const token = sign({ sub: 'u4', username: 'u4', sid: 's1', scope: 'mfa_challenge' });
    const { auth } = build({ betterAuthEnabled: false });
    const identity = await auth.authenticateHandshake({ headers: {}, auth: { token } });
    expect(identity).toBeNull();
  });

  it('token qua header Bearer vẫn dùng được khi auth.token vắng', async () => {
    const token = sign({ sub: 'u5', username: 'u5', sid: 's1' });
    const { auth } = build({ betterAuthEnabled: false });
    const identity = await auth.authenticateHandshake({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity?.userId).toBe('u5');
  });

  it('không cookie, không token → null', async () => {
    const { auth } = build({ betterAuthEnabled: false });
    const identity = await auth.authenticateHandshake({ headers: {} });
    expect(identity).toBeNull();
  });
});
