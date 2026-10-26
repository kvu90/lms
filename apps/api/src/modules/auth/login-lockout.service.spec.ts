import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { UsersService } from '../users/users.service';
import type { AuthRepository } from './auth.repository';
import { LoginLockoutService } from './login-lockout.service';

/**
 * Chính sách khoá tạm thời theo tài khoản (điểm 2.4, issue #7): một
 * nguồn semantics cho legacy + Better Auth trên bảng `login_attempts`.
 * Các ca ở đây ghim đúng semantics Moodle mà hệ legacy đã chạy: đủ
 * ngưỡng thất bại LIÊN TIẾP (sau lần thành công gần nhất) trong cửa
 * sổ thì khoá tới hết thời lượng khoá; ngưỡng 0 tắt hẳn. Luồng thật
 * qua hai đường đăng nhập được kiểm ở e2e.
 */
const MIN = 60_000;

interface AttemptRow {
  attemptedAt: Date;
}

function buildService(opts: {
  failures?: AttemptRow[];
  lastSuccess?: Date;
  config?: Record<string, unknown>;
  user?: { id: string; username: string; deleted: boolean } | undefined;
}) {
  const recorded: { userId: string; username: string; success: boolean; ip?: string }[] = [];
  const repo = {
    recentFailedAttempts: async () => opts.failures ?? [],
    lastSuccessfulAttemptAt: async () => opts.lastSuccess,
    recordAttempt: async (v: { userId: string; username: string; success: boolean; ip?: string }) => {
      recorded.push(v);
    },
  } as unknown as AuthRepository;
  const users = {
    getByUsername: async () => opts.user,
    getByEmail: async () => opts.user,
  } as unknown as UsersService;
  const config = { get: (key: string) => (opts.config ?? {})[key] } as unknown as ConfigService;
  return { service: new LoginLockoutService(repo, users, config), recorded };
}

function failuresAt(...minutesAgo: number[]): AttemptRow[] {
  const now = Date.now();
  return minutesAgo.map((m) => ({ attemptedAt: new Date(now - m * MIN) }));
}

describe('LoginLockoutService', () => {
  it('does not lock below the threshold', async () => {
    const { service } = buildService({ failures: failuresAt(1, 2, 3, 4) });
    expect(await service.isLockedOut('user-1')).toBe(false);
  });

  it('locks once the threshold of consecutive failures is reached', async () => {
    const { service } = buildService({ failures: failuresAt(1, 2, 3, 4, 5) });
    expect(await service.isLockedOut('user-1')).toBe(true);
  });

  it('only counts failures after the last successful login', async () => {
    const { service } = buildService({
      failures: failuresAt(1, 2, 4, 5, 6),
      lastSuccess: new Date(Date.now() - 3 * MIN),
    });
    expect(await service.isLockedOut('user-1')).toBe(false);
  });

  it('unlocks after the lockout duration has elapsed', async () => {
    const { service } = buildService({ failures: failuresAt(31, 32, 33, 34, 35) });
    expect(await service.isLockedOut('user-1')).toBe(false);
  });

  it('is disabled entirely when the threshold is 0', async () => {
    const { service } = buildService({
      failures: failuresAt(1, 1, 1, 1, 1, 1, 1, 1),
      config: { LOCKOUT_THRESHOLD: 0 },
    });
    expect(await service.isLockedOut('user-1')).toBe(false);
  });

  it('never locks an unknown login identifier and records nothing for it', async () => {
    const { service, recorded } = buildService({ user: undefined });
    expect(await service.isLoginLocked({ username: 'ghost' })).toBe(false);
    await service.recordLoginAttempt({ username: 'ghost' }, false, '198.51.100.7');
    expect(recorded).toHaveLength(0);
  });

  it('records attempts under the canonical username when resolving by email', async () => {
    const user = { id: 'user-9', username: 'canonical.name', deleted: false };
    const { service, recorded } = buildService({ user });
    await service.recordLoginAttempt({ email: 'person@example.com' }, true, '198.51.100.7');
    expect(recorded).toEqual([
      { userId: 'user-9', username: 'canonical.name', success: true, ip: '198.51.100.7' },
    ]);
  });
});
