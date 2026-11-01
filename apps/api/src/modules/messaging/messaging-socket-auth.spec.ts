import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { SpaceRoutingError } from '../../db/routing/space-connection-resolver';
import { tenantAls } from '../tenants/tenant-als';
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
 *
 * Tiền điều kiện Phần B (issue #587, hạng mục 1): handshake tại địa
 * chỉ của trung tâm ở kho riêng thì MỌI lượt đọc danh tính phải chạy
 * trong kho của trung tâm đó. Các ca của khối này dùng một đầu dò
 * ghi lại từng lượt đọc có nằm trong `withSpaceDatabase` hay không
 * và store ALS tại thời điểm đọc — gỡ bước phân giải không gian (đọc
 * thẳng như đường kho chung) là các khẳng định về đầu dò đỏ ngay.
 */
describe('MessagingSocketAuth — dual auth cookie + token (GĐ5)', () => {
  const SECRET = 'test-jwt-secret-gd5';

  function build(opts: {
    betterAuthEnabled?: boolean;
    getSession?: unknown;
    getSessionThrows?: boolean;
    defaultTenantId?: string | null;
    suspended?: boolean;
    /** Chế độ kho mà sổ đăng ký trả cho slug của Host: mặc định slug chưa đăng ký (đường kho chung). */
    spaceMode?: 'dedicated' | 'shared';
    /** Lỗi phân giải mà bộ phân giải ném ra (lệch bí mật/role của kho đích). */
    resolveError?: Error;
    spaceId?: string;
    platformTenantId?: string;
  } = {}) {
    // Đầu dò phạm vi kho: `insideSpace` bật trong lúc callback của
    // `withSpaceDatabase` chạy; mọi lượt đọc của các fake ghi lại
    // trạng thái đầu dò tại thời điểm đọc, kèm store ALS thật.
    const probe = {
      insideSpace: false,
      reads: [] as { kind: string; insideSpace: boolean }[],
      spaceSlugs: [] as string[],
      alsStores: [] as unknown[],
    };
    const users = {
      getByIdOrUndefined: vi.fn(async (id: string) => {
        probe.reads.push({ kind: 'user', insideSpace: probe.insideSpace });
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
            probe.reads.push({ kind: 'session', insideSpace: probe.insideSpace });
            if (opts.getSessionThrows) throw new Error('bad signature');
            return opts.getSession ?? null;
          }),
        },
      })),
    };
    const repo = {
      getUserDefaultTenantId: vi.fn(async () => {
        probe.reads.push({ kind: 'defaultTenant', insideSpace: probe.insideSpace });
        probe.alsStores.push(tenantAls.getStore());
        return opts.defaultTenantId ?? null;
      }),
    };
    const spaceDb = {
      resolveTarget: vi.fn(async (slug: string) => {
        if (opts.resolveError) throw opts.resolveError;
        if (opts.spaceMode === 'dedicated') {
          return {
            mode: 'dedicated', spaceId: opts.spaceId ?? 'space-1', slug, status: 'active',
            databaseName: 'lms_centre_test', schemaVersion: 'v1',
          };
        }
        if (opts.spaceMode === 'shared') {
          return {
            mode: 'shared', spaceId: 'space-shared', slug, status: 'active',
            databaseName: 'lms_shared_test', schemaVersion: 'v1',
          };
        }
        throw new SpaceRoutingError('space_routing.space_not_found', `Space slug ${slug} is not registered`);
      }),
      getDatabaseForSpace: vi.fn(async () => ({})),
      withSpaceDatabase: vi.fn(async (slug: string, fn: (db: unknown) => Promise<unknown>) => {
        probe.spaceSlugs.push(slug);
        probe.insideSpace = true;
        try {
          return await fn({});
        } finally {
          probe.insideSpace = false;
        }
      }),
    };
    const tenants = {
      platformTenant: vi.fn(async () => ({ id: opts.platformTenantId ?? 'tenant-platform' })),
    };
    const config = { getOrThrow: vi.fn(() => SECRET) };
    const auth = new MessagingSocketAuth(
      config as never,
      users as never,
      betterAuth as never,
      repo as never,
      spaceDb as never,
      tenants as never,
    );
    return { auth, users, betterAuth, repo, spaceDb, tenants, probe };
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
    expect(identity).toEqual({ userId: 'u1', username: 'user-u1', tenantId: 'tenant-default', spaceSlug: null });
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
    expect(identity).toEqual({ userId: 'u2', username: 'user-u2', tenantId: 'tenant-t', spaceSlug: null });
  });

  it('phiên cookie hỏng → rơi xuống token dự phòng thay vì từ chối ngay', async () => {
    const token = sign({ sub: 'u3', username: 'u3', sid: 's1' });
    const { auth } = build({ getSessionThrows: true });
    const identity = await auth.authenticateHandshake({
      headers: { cookie: 'better-auth.session_token=bad' },
      auth: { token },
    });
    expect(identity).toEqual({ userId: 'u3', username: 'user-u3', tenantId: null, spaceSlug: null });
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

  describe('phân giải không gian theo Host của handshake (tiền điều kiện Phần B, issue #587)', () => {
    const HOST = 'trung-tam-a.test.local';
    const SLUG = 'trung-tam-a';
    const SPACE_ID = 'space-1';

    it('cookie tại địa chỉ kho riêng: phiên, tài khoản và tenant mặc định đều đọc trong kho của trung tâm', async () => {
      const { auth, probe } = build({
        spaceMode: 'dedicated', spaceId: SPACE_ID, getSession: sessionValue, defaultTenantId: 'tenant-a',
      });
      const identity = await auth.authenticateHandshake({
        headers: { host: HOST, cookie: 'better-auth.session_token=abc123' },
      });
      expect(identity).toEqual({ userId: 'u1', username: 'user-u1', tenantId: 'tenant-a', spaceSlug: SLUG });
      // Cả ba lượt đọc đều nằm trong phạm vi kho của trung tâm, theo
      // đúng thứ tự phiên → tài khoản → tenant mặc định; không lượt
      // nào chạy ngoài phạm vi (tức ở kho chung).
      expect(probe.reads).toEqual([
        { kind: 'session', insideSpace: true },
        { kind: 'user', insideSpace: true },
        { kind: 'defaultTenant', insideSpace: true },
      ]);
      expect(probe.spaceSlugs.every((slug) => slug === SLUG)).toBe(true);
      // Lượt suy tenant mặc định giữ ngữ cảnh platform KÈM slug của
      // trung tâm trong store ALS — mất slug là rơi về kho chung.
      expect(probe.alsStores[0]).toMatchObject({ platform: true, spaceSlug: SLUG });
    });

    it('token mang centre_id khớp tại địa chỉ kho riêng: tài khoản tra trong kho của trung tâm', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a', centre_id: SPACE_ID });
      const { auth, probe } = build({ spaceMode: 'dedicated', spaceId: SPACE_ID, betterAuthEnabled: false });
      const identity = await auth.authenticateHandshake({ headers: { host: HOST }, auth: { token } });
      expect(identity).toEqual({ userId: 'u9', username: 'user-u9', tenantId: 'tenant-a', spaceSlug: SLUG });
      expect(probe.reads).toEqual([{ kind: 'user', insideSpace: true }]);
    });

    it('token mang centre_id lệch trung tâm tại địa chỉ → null và không tra tài khoản ở bất kỳ kho nào', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a', centre_id: 'space-khac' });
      const { auth, users, probe } = build({ spaceMode: 'dedicated', spaceId: SPACE_ID, betterAuthEnabled: false });
      const identity = await auth.authenticateHandshake({ headers: { host: HOST }, auth: { token } });
      expect(identity).toBeNull();
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
      expect(probe.reads).toEqual([]);
    });

    it('token không mang centre_id tại địa chỉ kho riêng → null, không rơi về tra cứu ở kho chung', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a' });
      const { auth, users } = build({ spaceMode: 'dedicated', spaceId: SPACE_ID, betterAuthEnabled: false });
      const identity = await auth.authenticateHandshake({ headers: { host: HOST }, auth: { token } });
      expect(identity).toBeNull();
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
    });

    it('token phiên vận hành platform (tid của tenant platform, không claim) tại địa chỉ kho riêng vẫn tra ở kho chung', async () => {
      const token = sign({ sub: 'admin-1', username: 'admin-1', sid: 's1', tid: 'tenant-platform' });
      const { auth, probe } = build({ spaceMode: 'dedicated', spaceId: SPACE_ID, betterAuthEnabled: false });
      const identity = await auth.authenticateHandshake({ headers: { host: HOST }, auth: { token } });
      expect(identity).toEqual({ userId: 'admin-1', username: 'user-admin-1', tenantId: 'tenant-platform', spaceSlug: null });
      expect(probe.reads).toEqual([{ kind: 'user', insideSpace: false }]);
    });

    it('lỗi phân giải không gian (bí mật kho đích lệch sổ) → handshake ném lỗi fail-closed, không đọc kho nào', async () => {
      const { auth, users, probe } = build({
        spaceMode: 'dedicated',
        resolveError: new SpaceRoutingError('space_routing.secret_invalid', 'Space secret is invalid'),
        getSession: sessionValue,
      });
      await expect(
        auth.authenticateHandshake({ headers: { host: HOST, cookie: 'better-auth.session_token=abc123' } }),
      ).rejects.toThrow('Space secret is invalid');
      expect(probe.reads).toEqual([]);
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
    });

    it('tầng định tuyến chưa cấu hình: token mang centre_id tại địa chỉ trung tâm bị từ chối và không tra tài khoản ở kho chung', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a', centre_id: SPACE_ID });
      const { auth, users, probe } = build({
        resolveError: new SpaceRoutingError('space_routing.not_configured', 'Space routing is not configured'),
        betterAuthEnabled: false,
      });
      const identity = await auth.authenticateHandshake({ headers: { host: HOST }, auth: { token } });
      expect(identity).toBeNull();
      expect(users.getByIdOrUndefined).not.toHaveBeenCalled();
      expect(probe.reads).toEqual([]);
    });

    it('tầng định tuyến chưa cấu hình: token không mang centre_id vẫn được phục vụ từ kho chung như trước', async () => {
      const token = sign({ sub: 'u9', username: 'u9', sid: 's1', tid: 'tenant-a' });
      const { auth, probe } = build({
        resolveError: new SpaceRoutingError('space_routing.not_configured', 'Space routing is not configured'),
        betterAuthEnabled: false,
      });
      const identity = await auth.authenticateHandshake({ headers: { host: HOST }, auth: { token } });
      expect(identity).toEqual({ userId: 'u9', username: 'user-u9', tenantId: 'tenant-a', spaceSlug: null });
      expect(probe.reads).toEqual([{ kind: 'user', insideSpace: false }]);
    });

    it('địa chỉ của trung tâm ở kho chung (sổ ghi shared) → đường kho chung như cũ, không vào phạm vi kho riêng', async () => {
      const { auth, spaceDb, probe } = build({
        spaceMode: 'shared', getSession: sessionValue, defaultTenantId: 'tenant-s',
      });
      const identity = await auth.authenticateHandshake({
        headers: { host: HOST, cookie: 'better-auth.session_token=abc123' },
      });
      expect(identity).toEqual({ userId: 'u1', username: 'user-u1', tenantId: 'tenant-s', spaceSlug: null });
      expect(spaceDb.withSpaceDatabase).not.toHaveBeenCalled();
      expect(probe.reads.every((read) => !read.insideSpace)).toBe(true);
    });
  });
});
