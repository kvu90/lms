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
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource as defaultCimdFetch } from '@better-auth/cimd/node';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { mcp } from '@better-auth/mcp';
import { APIError, betterAuth } from 'better-auth';
import { jwt, username } from 'better-auth/plugins';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PasswordService } from '../../users/password.service';
import { betterAuthSchema } from './better-auth.schema';

/** Đường dẫn gốc mà handler của Better Auth được mount tại (xem better-auth.mount.ts). */
export const BETTER_AUTH_BASE_PATH = '/api/v1/auth';

/**
 * Bộ scope OAuth mà AS phát cho resource `/mcp` (issue #163): trần
 * quyền của access token — quyết định quyền thật vẫn là capability tại
 * context ở tầng tool như MCP-0. PRM ở mcp.mount.ts quảng bá đúng bộ
 * này (MCP_SCOPES) — hai nơi phải khớp nhau.
 */
export const MCP_OAUTH_SCOPES = [
  'lms.questions.read',
  'lms.questions.draft',
  'lms.questions.write',
  'lms.banks.contribute',
] as const;

/** TTL (giây) của access token cho resource `/mcp` — JWT đã phát không thu hồi server-side được (RFC 7009) nên TTL ngắn là đường bù đã chốt ở addendum. */
export const MCP_ACCESS_TOKEN_TTL_SECONDS = 3600;

export interface BetterAuthMcpAsConfig {
  /** Canonical resource URI của MCP server (origin công khai + `/mcp`) — trở thành `aud` của mọi access token. */
  resource: string;
  /** Trang web đăng nhập cho luồng authorize (chạy phiên Better Auth). */
  loginPage: string;
  /** Trang web đồng ý (consent) cho luồng authorize. */
  consentPage: string;
  /**
   * Transport lấy tài liệu metadata của client CIMD. Mặc định là
   * transport Node của `@better-auth/cimd/node` (đã xử lý SSRF/ghép IP);
   * test chích transport riêng để chạy CIMD trên loopback.
   */
  cimdFetch?: typeof defaultCimdFetch;
}

/** Tên cookie phiên của Better Auth (bản https thêm tiền tố `__Secure-`). */
export const BETTER_AUTH_SESSION_COOKIE = 'better-auth.session_token';

export interface BetterAuthFactoryDeps {
  /** Instance Drizzle của app (dùng chung pool kết nối, không mở pool riêng). */
  db: NodePgDatabase<Record<string, never>>;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  passwordService: PasswordService;
  /**
   * Cấu hình máy chủ OAuth (AS) cho MCP (issue #163, lát MCP-1): có
   * giá trị thì factory compose thêm `jwt()` + `mcp()` + `cimd()` —
   * instance trở thành AS phát access token cho `/mcp`. `null`/thiếu
   * = instance thuần GĐ1 như trước, KHÔNG có bề mặt OAuth nào.
   */
  mcpAs?: BetterAuthMcpAsConfig | null;
}

export function createBetterAuth(deps: BetterAuthFactoryDeps) {
  const mcpAs = deps.mcpAs ?? null;
  return betterAuth({
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    trustedOrigins: deps.trustedOrigins,
    // Khi compose AS: tắt endpoint `/token` của plugin jwt() theo tài
    // liệu OAuth Provider (token chỉ phát qua `/oauth2/token`).
    ...(mcpAs ? { disabledPaths: ['/token'] } : {}),
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
    plugins: [
      username({ displayUsername: false }),
      // ── Lát MCP-1 (issue #163): máy chủ OAuth cho MCP ──────────────
      // Chỉ compose khi cờ MCP_AS_ENABLED bật (service truyền mcpAs).
      // CIMD (client_id là URL tài liệu metadata, hồ sơ
      // mcp-2026-07-28) là đường đăng ký chính; DCR để lại cho client
      // legacy nên bật tường minh cả ba tuỳ chọn theo addendum §2.
      ...(mcpAs
        ? [
            jwt({ disableSettingJwtHeader: true }),
            mcp({
              loginPage: mcpAs.loginPage,
              consentPage: mcpAs.consentPage,
              resource: mcpAs.resource,
              scopes: [...MCP_OAUTH_SCOPES],
              resources: [
                {
                  identifier: mcpAs.resource,
                  allowedScopes: [...MCP_OAUTH_SCOPES],
                  accessTokenTtl: MCP_ACCESS_TOKEN_TTL_SECONDS,
                },
              ],
              // JWT đã phát không thu hồi được → KHÔNG cho cửa sổ ân
              // hạn tái dùng refresh token (mặc định plugin là 30s):
              // refresh cũ dùng lại là bị chặn ngay (addendum §2).
              refreshTokenReuseInterval: 0,
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              clientRegistrationDefaultApplicationType: 'infer',
            }),
            cimd({
              fetchClientMetadataResource: mcpAs.cimdFetch ?? defaultCimdFetch,
              metadataProfile: 'mcp-2026-07-28',
            }),
          ]
        : []),
    ],
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
