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
import { createAuthMiddleware } from 'better-auth/api';
import { jwt, username } from 'better-auth/plugins';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PasswordService } from '../../users/password.service';
import { eq } from 'drizzle-orm';
import { createEmailOtpPlugin, type AuthMailPort } from '../../mail/email-otp.plugin';
import { betterAuthSchema, betterAuthTwoFactor } from './better-auth.schema';
import { createOAuthMfaGateHook } from './oauth-mfa-gate';
import type { LockoutGuardPort } from '../login-lockout.service';
import { lockoutHooks } from './lockout.hooks';

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

/**
 * Cấu hình đăng nhập xã hội (issue #7, chặng 2.3): service chỉ truyền
 * vào provider nào ĐỦ cả id lẫn secret từ env; provider vắng mặt trong
 * object này là provider tắt — không đăng ký, không bề mặt.
 */
export interface BetterAuthSocialConfig {
  google?: { clientId: string; clientSecret: string };
  facebook?: { clientId: string; clientSecret: string };
}

export interface BetterAuthFactoryDeps {
  /** Instance Drizzle của app (dùng chung pool kết nối, không mở pool riêng). */
  db: NodePgDatabase<Record<string, never>>;
  secret: string;
  baseURL: string;
  trustedOrigins: string[];
  passwordService: PasswordService;
  /** Provider xã hội đã cấu hình từ env (rỗng/thiếu = không có đăng nhập xã hội qua Better Auth). */
  socialProviders?: BetterAuthSocialConfig | null;
  /**
   * Cổng gửi mail auth (issue #7 chặng 2.5, lát BA-2): có giá trị thì
   * factory nối `sendResetPassword` vào cổng này và đăng ký plugin
   * `emailOTP` (qua đúng một dòng gọi factory trong module mail) để
   * mã OTP cũng đi qua cổng. `null`/thiếu = instance không có đường
   * gửi mail: endpoint reset của Better Auth tự từ chối
   * (RESET_PASSWORD_DISABLED) và bề mặt OTP không tồn tại — đúng
   * hành vi "chưa nối mail thì không mở luồng", không gửi đi đâu cả.
   */
  authMail?: AuthMailPort | null;
  /**
   * Cấu hình máy chủ OAuth (AS) cho MCP (issue #163, lát MCP-1): có
   * giá trị thì factory compose thêm `jwt()` + `mcp()` + `cimd()` —
   * instance trở thành AS phát access token cho `/mcp`. `null`/thiếu
   * = instance thuần GĐ1 như trước, KHÔNG có bề mặt OAuth nào.
   */
  mcpAs?: BetterAuthMcpAsConfig | null;
  /**
   * Cổng lockout theo tài khoản (điểm 2.4, issue #7): có giá trị thì
   * factory gắn endpoint hooks để các đường sign-in credential của
   * Better Auth dùng chung chính sách khoá + bảng `login_attempts` với
   * hệ legacy. Truyền qua deps (không qua DI của Nest) vì factory là
   * hàm thuần và hooks chạy ngoài vòng đời Nest — cùng khuôn
   * `passwordService`. Thiếu/`null` = không gắn (đường kiểm chứng tối
   * thiểu không đổi hành vi).
   */
  lockout?: LockoutGuardPort | null;
}

/**
 * Dựng object `socialProviders` cho instance từ cấu hình env: chỉ gồm
 * provider đã cấu hình. Cả hai provider đều `disableSignUp: true` ở
 * cấp provider — OAuth KHÔNG bao giờ tự tạo tài khoản (khớp
 * `disableSignUp` toàn cục đã chốt: tài khoản do admin/cầu nối tạo),
 * kể cả khi client xin `requestSignUp`; luồng còn lại là đăng nhập
 * bằng liên kết đã có + liên kết ngầm theo email theo luật account
 * linking bên dưới.
 */
function buildSocialProviders(config: BetterAuthSocialConfig | null | undefined) {
  if (!config) return undefined;
  const providers: Record<string, { clientId: string; clientSecret: string; disableImplicitSignUp: true; disableSignUp: true }> = {};
  if (config.google) providers.google = { ...config.google, disableImplicitSignUp: true, disableSignUp: true };
  if (config.facebook) providers.facebook = { ...config.facebook, disableImplicitSignUp: true, disableSignUp: true };
  return Object.keys(providers).length > 0 ? providers : undefined;
}

/**
 * Chuỗi hoá hai after-hook thành một middleware duy nhất (better-auth
 * chỉ nhận một `hooks.after`): lockout ghi attempt trước (dựa trên đáp
 * ứng gốc của endpoint), rồi cổng MFA xử lý callback OAuth. Hai hook
 * tác động lên hai tập đường rời nhau (sign-in credential vs callback
 * OAuth) nên thứ tự không đổi semantics; lỗi redirect của cổng MFA
 * (APIError) vẫn lan ra ngoài như khi đứng một mình vì dispatch bắt
 * APIError thành response. TUYỆT ĐỐI không ghi đè `hooks` bằng spread
 * sau khối này — spread sau sẽ lặng lẽ thay cả cổng MFA (lỗi đã suýt
 * xảy ra khi rebase 2.4 lên main có cổng MFA).
 */
function composeAfterHooks(
  first: ReturnType<typeof lockoutHooks>['after'] | undefined,
  second: ReturnType<typeof createOAuthMfaGateHook>,
) {
  if (!first) return second;
  return createAuthMiddleware(async (ctx) => {
    await first(ctx);
    await second(ctx);
  });
}

export function createBetterAuth(deps: BetterAuthFactoryDeps) {
  const mcpAs = deps.mcpAs ?? null;
  const lockoutHookSet = deps.lockout ? lockoutHooks(deps.lockout) : null;
  return betterAuth({
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    trustedOrigins: deps.trustedOrigins,
    socialProviders: buildSocialProviders(deps.socialProviders),
    account: {
      accountLinking: {
        enabled: true,
        // ĐÃ CHỐT trong kế hoạch GĐ2: Facebook KHÔNG vào
        // trustedProviders — và theo source 1.7.12, Facebook luôn
        // trả emailVerified=false (cả đường id_token lẫn userinfo)
        // nên không bao giờ tự liên kết theo email; chỉ Google (có
        // xác thực email của chính Google) mới liên kết ngầm.
        trustedProviders: [],
        // Mặc định của Better Auth còn đòi email phía tài khoản local
        // đã xác thực, trong khi MỌI tài khoản do cầu nối/admin tạo
        // đều có email_verified=false — giữ mặc định thì luật liên
        // kết theo email chết lặng lẽ. Cổng gác đúng theo kế hoạch
        // là xác thực email PHÍA PROVIDER, nên tắt điều kiện local.
        requireLocalEmailVerified: false,
      },
    },
    hooks: {
      // Cổng chặn hoàn tất OAuth khi tài khoản đã bật MFA (chặng
      // 2.3) — xem oauth-mfa-gate.ts; hook tự đi qua ở mọi đường
      // không phải callback OAuth có phiên mới. Khi có cổng lockout
      // 2.4 thì chuỗi hoá chung một after duy nhất (xem
      // composeAfterHooks) — không phía nào ghi đè phía nào.
      ...(lockoutHookSet?.before ? { before: lockoutHookSet.before } : {}),
      after: composeAfterHooks(lockoutHookSet?.after, createOAuthMfaGateHook({
        // Tra bản ghi MFA trực tiếp qua ánh xạ Drizzle — model
        // twoFactor chưa có trong registry adapter khi plugin chưa
        // bật (xem OAuthMfaGateDeps).
        lookupTwoFactorRecord: async (userId) => {
          const rows = await deps.db
            .select({ verified: betterAuthTwoFactor.verified })
            .from(betterAuthTwoFactor)
            .where(eq(betterAuthTwoFactor.userId, userId))
            .limit(1);
          return rows[0] ?? null;
        },
      })),
    },
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
      // Chặng 2.5 (lát BA-2): callback gửi mail reset CHỈ ghi yêu
      // cầu vào outbox qua cổng mail (AuthMailService lo phần đó) —
      // không gửi đồng bộ trong request như khuyến nghị chống timing
      // attack của Better Auth. Chưa nối cổng mail thì không khai
      // callback này: endpoint reset tự từ chối thay vì nhận yêu cầu
      // rồi để mất.
      ...(deps.authMail
        ? {
            sendResetPassword: async ({
              user,
              url,
            }: {
              user: { id: string; email: string };
              url: string;
              token: string;
            }): Promise<void> => {
              await deps.authMail!.sendPasswordResetEmail({ userId: user.id, email: user.email, url });
            },
          }
        : {}),
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
      // Lát BA-2 (issue #7 chặng 2.5): đăng nhập bằng email OTP — plugin dựng từ factory trong module mail, mã gửi qua cổng mail (outbox → Resend).
      ...(deps.authMail ? [createEmailOtpPlugin(deps.authMail)] : []),
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
              // Scope của AS = 4 scope quyền của resource + scope
              // giao thức `offline_access` (plugin bắt scope này nằm
              // trong danh sách của AS thì client mới đăng ký/ xin
              // được nó; metadata của RESOURCE tự lọc các scope
              // phía-AS ra nên PRM vẫn chỉ quảng bá 4 scope quyền).
              scopes: [...MCP_OAUTH_SCOPES, 'offline_access'],
              resources: [
                {
                  identifier: mcpAs.resource,
                  // CỐ Ý không ghim allowedScopes cho resource:
                  // plugin tính effectiveScopes bằng phép giao với
                  // allowedScopes, làm scope giao thức offline_access
                  // bị tước khỏi scope LƯU trên refresh token → ở
                  // grant refresh, plugin không còn căn cứ cấp token
                  // xoay vòng (kiểm chứng dist + DB ở e2e MCP-1:
                  // refresh chỉ trả access token mới, token cũ không
                  // bị thu hồi). Bỏ allowedScopes thì trần scope của
                  // resource vẫn do danh sách scope của AS (đúng 4
                  // scope quyền + offline_access) và scope client đã
                  // đăng ký gác; đổi lại access token mang thêm
                  // offline_access trong claim scope — RS bỏ qua
                  // scope không thuộc bộ tool.
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
              // `offline_access` là scope GIAO THỨC phía AS, không
              // phải scope quyền của resource /mcp: plugin chỉ cho
              // client đăng ký scope này khi AS khai tường minh tại
              // đây, và chỉ cấp refresh token khi authorize xin nó
              // (cơ chế oauth-provider 1.7.12 — kiểm chứng trong
              // dist + e2e mcp-as-oauth; thiếu khai này thì DCR của
              // client xin phiên dài chết invalid_scope ngay).
              clientRegistrationAllowedScopes: ['offline_access'],
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
