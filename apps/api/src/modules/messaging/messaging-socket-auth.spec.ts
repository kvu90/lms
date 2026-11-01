import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { SpaceRoutingError } from '../../db/routing/space-connection-resolver';
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
    // Khung định tuyến giả cho các ca phân giải không gian: `inSpace`
    // ghi lại mỗi lượt đọc diễn ra trong hay ngoài `withSpaceDatabase`,
    // để khẳng định lượt đọc chạy ĐÚNG kho chứ không chỉ được gọi.
    spaceMode?: 'dedicated' | 'shared';
    spaceSlug?: string;
    spaceId?: string;
    spaceResolveThrows?: Error;
    spacePrepareThrows?: Error;
  } = {}) {
    // Cờ phạm vi mà mock khung lật trong lúc callback chạy: mọi lượt
    // đọc (phiên, tài khoản, tenant mặc định) ghi lại giá trị cờ tại
    // thời điểm nó chạy, nên ca kiểm chứng được lượt đọc ở trong kho
    // đích thay vì chỉ đếm số lần gọi.
    let inSpace = false;
    const reads: { kind: string; inSpace: boolean }[] = [];
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => {
        reads.push({ kind: 'user', inSpace });
        return {
          id, username: `user-${id}`, suspended: opts.suspended ?? false, deleted: false,
        };
      }),
    };
    const betterAuth = {
      enabled: opts.betterAuthEnabled ?? true,
      requireAuth: vi.fn(() => ({
        api: {
          getSession: vi.fn(async () => {
            reads.push({ kind: 'session', inSpace });
            if (opts.getSessionThrows) throw new Error('bad signature');
            return opts.getSession ?? null;
          }),
        },
      })),
    };
    const repo = {
      getUserDefaultTenantId: vi.fn(async () => {
        reads.push({ kind: 'defaultTenant', inSpace });
        return opts.defaultTenantId ?? null;
      }),
    };
    const spaceDb = {
      resolveTarget: vi.fn(async () => {
        if (opts.spaceResolveThrows) throw opts.spaceResolveThrows;
        return {
          slug: opts.spaceSlug ?? 'truong-a',
          spaceId: opts.spaceId ?? 'space-1',
          status: 'active',
          databaseName: 'centre-a',
          mode: opts.spaceMode ?? 'shared',
          connectionRole: 'centre-a-app',
        };
      }),
      withSpaceDatabase: vi.fn(async (_slug: string, fn: () => Promise<unknown>) => {
        if (opts.spacePrepareThrows) throw opts.spacePrepareThrows;
        inSpace = true;
        try {
          return await fn();
        } finally {
          inSpace = false;
        }
      }),
    };
    const config = { getOrThrow: vi.fn(() => SECRET) };
    const auth = new MessagingSocketAuth(
      config as never,
      users as never,
      betterAuth as never,
      repo as never,
      spaceDb as never,
    );
    return { auth, users, betterAuth, repo, spaceDb, reads };
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

  /**
   * Phân giải không gian theo Host — tiền điều kiện Phần B của issue
   * #587 (PR-TĐ2), cùng khuôn JwtAuthStrategy phía HTTP: địa chỉ
   * trung tâm ở kho riêng thì mọi lượt đọc danh tính chạy trong kho
   * đó; địa chỉ còn lại giữ nguyên đường kho chung; lỗi phân giải/
   * chuẩn bị kho đích fail-closed thay vì rơi về kho chung.
   */
  describe('phân giải không gian theo Host của handshake', () => {
    const CENTRE_HOST = 'truong-a.test.local';

    it('địa chỉ trung tâm kho riêng → đường cookie đọc phiên, tài khoản và tenant mặc định trong kho của trung tâm đó', async () => {
      const { auth, spaceDb, reads } = build({
        getSession: sessionValue, defaultTenantId: 'tenant-a', spaceMode: 'dedicated',
      });
      const identity = await auth.authenticateHandshake({
        headers: { host: CENTRE_HOST, cookie: 'better-auth.session_token=abc123' },
      });
      expect(identity).toEqual({ userId: 'u1', username: 'user-u1', tenantId: 'tenant-a' });
      expect(spaceDb.withSpaceDatabase).toHaveBeenCalledWith('truong-a', expect.any(Function));
      expect(reads).toEqual([
        { kind: 'session', inSpace: true },
        { kind: 'user', inSpace: true },
        { kind: 'defaultTenant', inSpace: true },
      ]);
    });

    it('địa chỉ trung tâm ở kho chung → đường cookie giữ nguyên hành vi, không chạm khung định tuyến', async () => {
      const { auth, spaceDb, reads } = build({
        getSession: sessionValue, defaultTenantId: 'tenant-default', spaceMode: 'shared',
      });
      const identity = await auth.authenticateHandshake({
        headers: { host: 'trang-chinh.test.local', cookie: 'better-auth.session_token=abc123' },
      });
      expect(identity).toEqual({ userId: 'u1', username: 'user-u1', tenantId: 'tenant-default' });
      expect(spaceDb.withSpaceDatabase).not.toHaveBeenCalled();
      expect(reads.every((read) => !read.inSpace)).toBe(true);
    });

    it('địa chỉ trung tâm kho riêng → đường token tra tài khoản trong kho của trung tâm đó khi claim trung tâm khớp', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a', centre_id: 'space-1' });
      const { auth, spaceDb, reads } = build({ betterAuthEnabled: false, spaceMode: 'dedicated' });
      const identity = await auth.authenticateHandshake({
        headers: { host: CENTRE_HOST },
        auth: { token },
      });
      expect(identity).toEqual({ userId: 'u9', username: 'user-u9', tenantId: 'tenant-a' });
      expect(spaceDb.withSpaceDatabase).toHaveBeenCalledWith('truong-a', expect.any(Function));
      expect(reads).toEqual([{ kind: 'user', inSpace: true }]);
    });

    it('token cũ không claim trung tâm tại địa chỉ kho riêng → vẫn tra trong kho của trung tâm đó, không rơi về kho chung', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a' });
      const { auth, spaceDb, reads } = build({ betterAuthEnabled: false, spaceMode: 'dedicated' });
      const identity = await auth.authenticateHandshake({
        headers: { host: CENTRE_HOST },
        auth: { token },
      });
      expect(identity?.userId).toBe('u9');
      expect(spaceDb.withSpaceDatabase).toHaveBeenCalledWith('truong-a', expect.any(Function));
      expect(reads).toEqual([{ kind: 'user', inSpace: true }]);
    });

    it('token mang claim trung tâm lệch địa chỉ → null ngay, không tra tài khoản ở bất kỳ kho nào', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', centre_id: 'space-khac' });
      const { auth, users, spaceDb } = build({ betterAuthEnabled: false, spaceMode: 'dedicated' });
      const identity = await auth.authenticateHandshake({
        headers: { host: CENTRE_HOST },
        auth: { token },
      });
      expect(identity).toBeNull();
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
      expect(spaceDb.withSpaceDatabase).not.toHaveBeenCalled();
    });

    it('lỗi phân giải kho đích ở đường cookie → ném lỗi, không rơi xuống đường token', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1' });
      const { auth, users } = build({
        getSession: sessionValue,
        spaceResolveThrows: new SpaceRoutingError('space_routing.role_mismatch', 'role lệch sổ'),
      });
      await expect(auth.authenticateHandshake({
        headers: { host: CENTRE_HOST, cookie: 'better-auth.session_token=abc123' },
        auth: { token },
      })).rejects.toThrow('role lệch sổ');
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
    });

    it('lỗi chuẩn bị kho đích ở đường token → ném lỗi, không tra kho chung', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1' });
      const { auth, users } = build({
        betterAuthEnabled: false,
        spaceMode: 'dedicated',
        spacePrepareThrows: new SpaceRoutingError('space_routing.secret_missing', 'bí mật lệch sổ'),
      });
      await expect(auth.authenticateHandshake({
        headers: { host: CENTRE_HOST },
        auth: { token },
      })).rejects.toThrow('bí mật lệch sổ');
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
    });
  });
});
