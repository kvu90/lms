import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../../db/database';
import { PasswordService } from '../../users/password.service';
import { BetterAuthService } from './better-auth.service';

const SECRET = 'unit-test-secret-for-better-auth-0123456789';

function configStub(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function buildService(values: Record<string, unknown>): BetterAuthService {
  const config = configStub(values);
  return new BetterAuthService(config, {} as unknown as Database, new PasswordService(config));
}

/**
 * Nền Better Auth sau cờ (issue #7, Giai đoạn 1): cờ tắt phải hoàn toàn
 * bất hoạt, cờ bật thiếu secret phải từ chối khởi tạo, và các tuỳ chọn
 * đã chốt trong issue phải được ghim đúng trên instance.
 */
describe('BetterAuthService', () => {
  it('is fully inert when the flag is off (default)', () => {
    const service = buildService({});
    expect(service.enabled).toBe(false);
    expect(service.auth).toBeNull();
    expect(() => service.requireAuth()).toThrow(/not enabled/);
  });

  it('refuses to initialize when enabled without BETTER_AUTH_SECRET', () => {
    expect(() => buildService({ BETTER_AUTH_ENABLED: true, PORT: 3000 })).toThrow(
      /BETTER_AUTH_SECRET is required/,
    );
  });

  it('pins the options settled in issue #7 when enabled', () => {
    const service = buildService({ BETTER_AUTH_ENABLED: true, BETTER_AUTH_SECRET: SECRET, PORT: 3000 });
    expect(service.enabled).toBe(true);
    const auth = service.requireAuth();
    expect(auth.options.basePath).toBe('/api/v1/auth');
    expect(auth.options.emailAndPassword?.disableSignUp).toBe(true);
    // Ghim tường minh false: Better Auth tự bỏ qua kiểm tra Origin khi
    // NODE_ENV=test nếu không khai — xem báo cáo Giai đoạn 0.
    expect(auth.options.advanced?.disableOriginCheck).toBe(false);
    // PostgreSQL tự sinh UUIDv7; Better Auth không tự sinh id.
    expect(auth.options.advanced?.database?.generateId).toBe(false);
    // Cookie cache tắt để thu hồi phiên có hiệu lực ngay.
    expect(auth.options.session?.cookieCache?.enabled).toBe(false);
    // Plugin username chính chủ phải có mặt (đăng nhập bằng username).
    expect(auth.options.plugins?.some((plugin) => plugin.id === 'username')).toBe(true);
  });
});
