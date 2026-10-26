import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../../db/database';
import type { AuthMailService } from '../../mail/auth-mail.service';
import { PasswordService } from '../../users/password.service';
import type { LoginLockoutService } from '../login-lockout.service';
import { BetterAuthService } from './better-auth.service';

const SECRET = 'unit-test-secret-for-better-auth-0123456789';

function configStub(values: Record<string, unknown>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

/** Cổng lockout giả lập cho unit test: không khoá, ghi attempt là no-op (hành vi thật kiểm ở e2e). */
const lockoutStub = {
  isLoginLocked: async () => false,
  recordLoginAttempt: async () => undefined,
} as unknown as LoginLockoutService;

function buildService(values: Record<string, unknown>): BetterAuthService {
  const config = configStub(values);
  return new BetterAuthService(config, {} as unknown as Database, new PasswordService(config), undefined, lockoutStub);
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
    // Endpoint hooks của lockout theo tài khoản phải được gắn (điểm
    // 2.4): before chặn trước khi kiểm mật khẩu, after ghi attempt.
    expect(auth.options.hooks?.before).toBeDefined();
    expect(auth.options.hooks?.after).toBeDefined();
  });

  it('has no mail surface when the mail port is not wired (phase 2.5 not connected yet)', () => {
    const service = buildService({ BETTER_AUTH_ENABLED: true, BETTER_AUTH_SECRET: SECRET, PORT: 3000 });
    const auth = service.requireAuth();
    // Chưa nối cổng mail: không callback reset (endpoint reset của
    // Better Auth tự từ chối RESET_PASSWORD_DISABLED) và không plugin
    // OTP — không có luồng nào nhận yêu cầu rồi để mất.
    expect(auth.options.emailAndPassword?.sendResetPassword).toBeUndefined();
    expect(auth.options.plugins?.some((plugin) => plugin.id === 'email-otp')).toBe(false);
  });

  it('wires the mail port when provided: reset callback, email-otp plugin, revocation pin', async () => {
    const resetCalls: Array<{ userId: string; email: string; url: string }> = [];
    const mailPort = {
      sendPasswordResetEmail: async (input: { userId: string; email: string; url: string }) => {
        resetCalls.push(input);
      },
      sendEmailOtp: async () => undefined,
    } as unknown as AuthMailService;
    const config = configStub({ BETTER_AUTH_ENABLED: true, BETTER_AUTH_SECRET: SECRET, PORT: 3000 });
    const service = new BetterAuthService(
      config,
      {} as unknown as Database,
      new PasswordService(config),
      mailPort,
    );
    const auth = service.requireAuth();
    // Thu hồi phiên khi reset là chốt của issue, đặt sẵn từ Giai đoạn 1.
    expect(auth.options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    // Plugin emailOTP có mặt (đăng nhập bằng mã qua email).
    expect(auth.options.plugins?.some((plugin) => plugin.id === 'email-otp')).toBe(true);
    // Callback reset chuyển đúng { user, url } của Better Auth sang cổng mail.
    const sendReset = auth.options.emailAndPassword?.sendResetPassword;
    expect(typeof sendReset).toBe('function');
    await sendReset!({
      user: { id: 'user-1', email: 'u@example.com' } as never,
      url: 'https://app/reset-password/tok',
      token: 'tok',
    });
    expect(resetCalls).toEqual([{ userId: 'user-1', email: 'u@example.com', url: 'https://app/reset-password/tok' }]);
  });

  it('is inert for the OAuth AS when only MCP_AS_ENABLED is off (default)', () => {
    const service = buildService({});
    expect(service.mcpAsEnabled).toBe(false);
    expect(service.mcpAs).toBeNull();
  });

  it('refuses to initialize when MCP_AS_ENABLED without BETTER_AUTH_SECRET', () => {
    expect(() => buildService({ MCP_AS_ENABLED: true, PORT: 3000 })).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it('composes the OAuth AS (jwt + oauth-provider + cimd) under MCP_AS_ENABLED alone (issue #163)', () => {
    const service = buildService({ MCP_AS_ENABLED: true, BETTER_AUTH_SECRET: SECRET, PORT: 3000 });
    // Cờ GĐ1 vẫn tắt — AS là lát độc lập, không chờ cutover của #7.
    expect(service.enabled).toBe(false);
    expect(service.mcpAsEnabled).toBe(true);
    expect(service.mcpAs?.resource).toBe('http://localhost:3000/mcp');
    expect(service.mcpAs?.loginPage).toBe('/mcp-login');
    expect(service.mcpAs?.consentPage).toBe('/mcp-consent');
    const auth = service.requireAuth();
    const pluginIds = (auth.options.plugins ?? []).map((plugin) => plugin.id);
    expect(pluginIds).toContain('jwt');
    expect(pluginIds).toContain('oauth-provider');
    expect(pluginIds).toContain('cimd');
    // Endpoint /token của plugin jwt bị tắt khi compose AS.
    expect(auth.options.disabledPaths).toContain('/token');
    // Hai hiệu chỉnh bắt buộc của addendum phải nằm trong cấu hình
    // plugin: cửa sổ tái dùng refresh = 0 và TTL resource /mcp = 3600s.
    const pluginsJson = JSON.stringify(auth.options.plugins);
    expect(pluginsJson).toContain('"refreshTokenReuseInterval":0');
    expect(pluginsJson).toContain('"accessTokenTtl":3600');
  });
});
