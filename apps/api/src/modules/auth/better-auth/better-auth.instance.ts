/**
 * Factory dựng Better Auth instance (issue #7, Giai đoạn 1) — hàm thuần,
 * không phụ thuộc Nest, để cả `BetterAuthService` (đường chạy của app)
 * lẫn script/test kiểm chứng dùng chung một định nghĩa duy nhất.
 *
 * Các điểm đã chốt trong issue và kiểm chứng ở Giai đoạn 0 (4/4 cổng đạt):
 * - ghim exact `better-auth@1.7.12` + `@better-auth/drizzle-adapter@1.7.12`
 *   (khai trong package.json, không dùng dải ^);
 * - adapter Drizzle `transaction: true`, ánh xạ lên bảng `users` hiện hữu
 *   với `generateId: false` — PostgreSQL tự sinh UUIDv7 cho mọi bảng;
 * - mật khẩu uỷ thác gói argon2 của dự án qua `PasswordService`: chiều
 *   `hash` chạy `validatePolicy` trước khi băm, chiều `verify` kiểm hash
 *   PHC argon2id do hệ hiện tại sinh ra — không ép đặt lại mật khẩu;
 * - đăng nhập username qua plugin chính chủ (`displayUsername: false`);
 *   `disableSignUp: true` (không đăng ký công khai);
 * - ghim `advanced.disableOriginCheck: false` — Better Auth tự bỏ qua
 *   kiểm tra Origin khi NODE_ENV=test nếu không khai tường minh;
 * - `session.cookieCache` tắt: thu hồi phiên có hiệu lực ngay;
 * - secret riêng `BETTER_AUTH_SECRET`, không dùng chung JWT_SECRET.
 */
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { APIError, betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PasswordService } from '../../users/password.service';
import { betterAuthSchema } from './better-auth.schema';

/** Đường dẫn gốc mà handler của Better Auth được mount tại (xem better-auth.mount.ts). */
export const BETTER_AUTH_BASE_PATH = '/api/v1/auth';

/** Tên cookie phiên của Better Auth (bản https thêm tiền tố `__Secure-`). */
export const BETTER_AUTH_SESSION_COOKIE = 'better-auth.session_token';

export interface BetterAuthFactoryDeps {
  /** Instance Drizzle của app (dùng chung pool kết nối, không mở pool riêng). */
  db: NodePgDatabase<Record<string, never>>;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  passwordService: PasswordService;
}

export function createBetterAuth(deps: BetterAuthFactoryDeps) {
  return betterAuth({
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    trustedOrigins: deps.trustedOrigins,
    database: drizzleAdapter(deps.db, {
      provider: 'pg',
      schema: betterAuthSchema,
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      // Thu hồi mọi phiên còn lại khi đặt lại mật khẩu (chốt trong issue;
      // luồng reset thi công ở Giai đoạn 2, cấu hình đặt sẵn từ nền này).
      revokeSessionsOnPasswordReset: true,
      password: {
        hash: async (password: string): Promise<string> => {
          const violations = deps.passwordService.validatePolicy(password);
          if (violations.length > 0) {
            throw new APIError('BAD_REQUEST', {
              message: `Password policy violated: ${violations.join('; ')}`,
            });
          }
          return deps.passwordService.hash(password);
        },
        verify: async ({ hash, password }: { hash: string; password: string }): Promise<boolean> =>
          deps.passwordService.verify(hash, password),
      },
    },
    plugins: [username({ displayUsername: false })],
    session: {
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      database: { generateId: false },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
