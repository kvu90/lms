import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { BetterAuthService } from '../modules/auth/better-auth/better-auth.service';
import type { UsersService } from '../modules/users/users.service';
import { AUTHENTICATED_VIA_BETTER_AUTH, BetterAuthSessionGuard } from './better-auth-session.guard';
import type { AuthenticatedUser } from './current-user.decorator';

interface FakeRequest {
  headers: Record<string, string | undefined>;
  user?: AuthenticatedUser;
  [AUTHENTICATED_VIA_BETTER_AUTH]?: boolean;
}

function contextOf(req: FakeRequest): ExecutionContext {
  return {
    getHandler: () => null,
    getClass: () => null,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function buildGuard(input: {
  enabled: boolean;
  getSession?: () => Promise<unknown>;
  user?: Record<string, unknown> | undefined;
}): { guard: BetterAuthSessionGuard; getSession: ReturnType<typeof vi.fn> } {
  const getSession = vi.fn(input.getSession ?? (async () => null));
  const betterAuth = {
    enabled: input.enabled,
    requireAuth: () => ({ api: { getSession } }),
  } as unknown as BetterAuthService;
  const users = {
    getByIdOrUndefined: vi.fn(async () => input.user),
  } as unknown as UsersService;
  const reflector = { getAllAndOverride: () => false } as unknown as Reflector;
  return { guard: new BetterAuthSessionGuard(reflector, betterAuth, users), getSession };
}

const COOKIE = 'better-auth.session_token=tok.abc; other=1';

/**
 * Guard mỏng của Better Auth (issue #7, Giai đoạn 1): chỉ đặt danh tính
 * khi phiên Better Auth hợp lệ VÀ tài khoản còn hoạt động; mọi trường
 * hợp còn lại phải để nguyên cho đường JWT hiện tại quyết định.
 */
describe('Khối BetterAuthSessionGuard', () => {
  it('cho qua nguyên vẹn khi Better Auth đang tắt', async () => {
    const { guard, getSession } = buildGuard({ enabled: false });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('cho qua khi request không mang cookie phiên Better Auth', async () => {
    const { guard, getSession } = buildGuard({ enabled: true });
    const req: FakeRequest = { headers: { cookie: 'something-else=1' } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('ánh xạ phiên Better Auth hợp lệ thành AuthenticatedUser và đánh dấu request', async () => {
    const { guard } = buildGuard({
      enabled: true,
      getSession: async () => ({ session: { id: 'session-id', userId: 'user-id' }, user: { id: 'user-id' } }),
      user: { id: 'user-id', username: 'teacher1', deleted: false, suspended: false },
    });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(req.user).toEqual({ id: 'user-id', username: 'teacher1', sessionId: 'session-id' });
    expect(req[AUTHENTICATED_VIA_BETTER_AUTH]).toBe(true);
  });

  it('không xác thực người dùng bị đình chỉ ngay cả khi phiên đang sống', async () => {
    const { guard } = buildGuard({
      enabled: true,
      getSession: async () => ({ session: { id: 'session-id', userId: 'user-id' }, user: { id: 'user-id' } }),
      user: { id: 'user-id', username: 'teacher1', deleted: false, suspended: true },
    });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
    expect(req[AUTHENTICATED_VIA_BETTER_AUTH]).toBeUndefined();
  });

  it('cho qua (để 401 cho JWT guard) khi phiên không resolve được', async () => {
    const { guard } = buildGuard({ enabled: true, getSession: async () => null });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('cho qua khi getSession ném lỗi trên cookie sai định dạng', async () => {
    const { guard } = buildGuard({
      enabled: true,
      getSession: async () => {
        throw new Error('bad cookie');
      },
    });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });
});
