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
describe('BetterAuthSessionGuard', () => {
  it('passes through untouched when Better Auth is disabled', async () => {
    const { guard, getSession } = buildGuard({ enabled: false });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('passes through when the request carries no Better Auth session cookie', async () => {
    const { guard, getSession } = buildGuard({ enabled: true });
    const req: FakeRequest = { headers: { cookie: 'something-else=1' } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(req.user).toBeUndefined();
  });

  it('maps a valid Better Auth session onto AuthenticatedUser and marks the request', async () => {
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

  it('does not authenticate a suspended user even with a live session', async () => {
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

  it('passes through (leaving the 401 to the JWT guard) when the session does not resolve', async () => {
    const { guard } = buildGuard({ enabled: true, getSession: async () => null });
    const req: FakeRequest = { headers: { cookie: COOKIE } };
    await expect(guard.canActivate(contextOf(req))).resolves.toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('passes through when getSession throws on a malformed cookie', async () => {
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
