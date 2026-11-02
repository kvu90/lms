/**
 * Factory dựng Better Auth instance (issue #7, Giai đoạn 1) — hàm thuần,
 * không phụ thuộc Nest, để cả `BetterAuthService` (đường chạy của app)
 * lẫn script/test kiểm chứng dùng chung một định nghĩa duy nhất.
 *
 * Các điểm đã chốt trong issue và kiểm chứng ở Giai đoạn 0 (4/4 cổng đạt):
 * - ghim exact `better-auth@1.7.12` + `@better-auth/kysely-adapter@1.7.12`
 *   (khai trong package.json, không dùng dải ^);
 * - adapter Kysely `transaction: true`, ánh xạ lên bảng `users` hiện hữu
 *   với `generateId: "uuid"` — xem ghi chú tại `advanced.database`
 *   bên dưới (BA-1): id thường vẫn do PostgreSQL tự sinh UUIDv7, chỉ
 *   các id tất định (verification lock) mới đổi sang dạng UUID;
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
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { mcp } from '@better-auth/mcp';
import { APIError, betterAuth } from 'better-auth';
import { createAuthMiddleware, type AuthMiddleware } from 'better-auth/api';
import { jwt, username } from 'better-auth/plugins';
import type { CentreDb } from '@lms/db';
import { PasswordService } from '../../users/password.service';
import { createEmailOtpPlugin, type AuthMailPort } from '../../mail/email-otp.plugin';
import { createMfaGateHook, type MfaGateDeps } from './mfa-gate';
import type { LockoutGuardPort } from '../login-lockout.service';
import { lockoutHooks } from './lockout.hooks';

/** Đường dẫn gốc mà handler của Better Auth được mount tại (xem better-auth.mount.ts). */
export const BETTER_AUTH_BASE_PATH = '/api/v1/auth';

/**
 * Khai báo `supportsArrays` thật cho Postgres (issue #654, D2).
 *
 * Vấn đề: adapter Kysely chính thức ghim `supportsArrays: false`
 * (không có tuỳ chọn đổi — vì adapter đa dialect nên chọn cách lưu
 * mảng an toàn chung là chuỗi JSON). Lõi Better Auth vì vậy JSON-hoá
 * mọi giá trị `string[]` khi ghi (core `db/adapter/factory.mjs`:
 * `supportsArrays === false` → `JSON.stringify`); cột vật lý của hệ
 * là `text[]` nên chuỗi JSON `["a","b"]` bị Postgres từ chối bằng
 * `malformed array literal` (đã bắt tại e2e mcp-as-oauth: DCR +
 * authorize 500). Adapter bộ máy cũ không lộ vấn đề này vì nó khai
 * `supportsArrays: true` cho pg.
 *
 * Cách sửa (giữ nguyên schema vật lý, không migration): factory
 * `database` lật cờ `supportsArrays` thành `true` trên chính đối
 * tượng cấu hình mà adapter của lõi đang dùng
 * (`adapter.options.adapterConfig` — cùng tham chiếu mà
 * `transformInput`/`transformOutput` của lõi đọc, kiểm chứng tại
 * `factory.mjs`). Khai báo này là ĐÚNG với DB thật: Postgres `text[]`
 * hỗ trợ mảng nguyên sinh, đúng như adapter bộ máy cũ đã khai cho pg;
 * chiều đọc cũng đối xứng (pg trả `text[]` thành mảng JS, lõi không
 * còn phân tích JSON). Phải lật cả hai đường: adapter ngoài (ghi
 * thường) và adapter giao dịch (luồng OAuth chạy ghi client trong
 * `runWithTransaction`, vd `persistOAuthClientRegistration`) — adapter
 * giao dịch được dựng từ một bản sao cấu hình riêng nên lật ngoài
 * không lan vào trong; bọc `transaction` để lật cờ trên adapter giao
 * dịch ngay trước khi callback chạy.
 *
 * Đường bọc phương thức `create`/`update`/`updateMany` đã thử trước
 * đó KHÔNG sửa được: JSON-hoá xảy ra BÊN TRONG `create` của lõi
 * (sau `transformInput`, trước khi gọi adapter thô) nên mọi điểm chặn
 * ở tầng adapter của lõi đều ở sai phía của điểm JSON-hoá — chỉ lật
 * cờ mới tới được đúng điểm. Ghi chú này giữ lại để lần sau không
 * quay lại đường bọc.
 */
function withPostgresArrays<T extends {
  options?: { adapterConfig: { supportsArrays?: boolean | undefined } };
  transaction?: unknown;
}>(adapter: T): T {
  if (adapter.options) adapter.options.adapterConfig.supportsArrays = true;
  if (typeof adapter.transaction === 'function') {
    const baseTransaction = adapter.transaction as <R>(
      callback: (tx: {
        options: { adapterConfig: { supportsArrays?: boolean | undefined } };
      }) => Promise<R>,
    ) => Promise<R>;
    (adapter as {
      transaction: <R>(
        callback: (tx: {
          options: { adapterConfig: { supportsArrays?: boolean | undefined } };
        }) => Promise<R>,
      ) => Promise<R>;
    }).transaction = <R>(
      callback: (tx: {
        options: { adapterConfig: { supportsArrays?: boolean | undefined } };
      }) => Promise<R>,
    ) =>
      baseTransaction((tx) => {
        tx.options.adapterConfig.supportsArrays = true;
        return callback(tx);
      });
  }
  return adapter;
}

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
  /** Handle Kysely định tuyến theo trung tâm (facade `routedKysely` của khung; dùng chung pool kết nối, không mở pool riêng). */
  db: CentreDb;
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
   * Đồng bộ ngược hash mật khẩu trong cửa sổ bake (GĐ2 chặng 2.7
   * bước A): mỗi khi phía Better Auth ghi mật khẩu credential mới
   * cho một user, factory gọi callback này để tầng service ĐỌC hash
   * hiện hành từ chính dòng `account` rồi chép về
   * `users.password_hash`. Đây là điều kiện để rollback về hệ cũ
   * trước bước B còn đúng: mật khẩu hiện hành luôn đăng nhập được ở
   * cả hai hệ. `null`/thiếu = không hook (mọi giai đoạn ngoài cửa sổ
   * bake — hành vi hiện tại).
   *
   * Ba điểm nối (đủ mọi đường ghi mật khẩu của 1.7.12, đã đối chiếu
   * dist): (1) `databaseHooks.account.create.after` — tạo credential
   * mới (set-password của user chưa có credential, cầu nối tạo cặp);
   * (2) after-hook endpoint cho `/change-password` và `/set-password`
   * — userId lấy từ phiên trong context; (3) callback
   * `emailAndPassword.onPasswordReset` — phủ cả reset bằng link lẫn
   * reset bằng email OTP (plugin email-otp cũng gọi callback này).
   * KHÔNG dùng `databaseHooks.account.update.after` cho đường cập
   * nhật: `internalAdapter.updatePassword` của 1.7.12 đi qua
   * `updateManyWithHooks`, mà adapter Kysely trả về SỐ DÒNG bị ảnh
   * hưởng cho updateMany — hook `update.after` nhận một con số chứ
   * không phải bản ghi account, không cách nào biết user/hash nào
   * vừa đổi (đã kiểm chứng trong dist của @better-auth/kysely-adapter
   * 1.7.12: updateMany → numUpdatedRows).
   */
  legacyPasswordSync?: {
    syncFromCredentialAccount: (userId: string) => Promise<void>;
  } | null;
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
  /**
   * Cổng MFA thống nhất cho mọi đường đăng nhập (xem `mfa-gate.ts`):
   * trạng thái MFA đọc từ `user_totp` của hệ tự viết — nguồn duy nhất
   * mà giao diện bật/tắt MFA ghi vào — qua hàm tra cứu do
   * `BetterAuthService` truyền vào (nó giữ `TotpService`). Cùng khuôn
   * `lockout`: truyền qua deps vì factory là hàm thuần; thiếu/`null`
   * = cổng không gắn (đường kiểm chứng tối thiểu không đổi hành vi),
   * đường chạy thật của app luôn truyền.
   */
  mfa?: MfaGateDeps | null;
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
 * Chuỗi hoá các after-hook thành một middleware duy nhất (better-auth
 * chỉ nhận một `hooks.after`): `first` (lockout — ghi attempt trước,
 * dựa trên đáp ứng gốc của endpoint) chạy trước `second`. Tại điểm gọi
 * duy nhất, `second` là chuỗi cổng MFA của mọi đường đăng nhập + đồng
 * bộ ngược hash của cửa sổ bake (xem khối `hooks` trong
 * createBetterAuth): các khâu tác động lên các tập đường rời nhau
 * (lockout chỉ ghi attempt của sign-in credential; cổng MFA gác các
 * đường vừa tạo phiên; đồng bộ ngược chỉ chạm change/set-password)
 * nên thứ tự không đổi semantics; lỗi redirect của cổng MFA
 * (APIError) vẫn lan ra ngoài như khi đứng một mình vì dispatch bắt
 * APIError thành response. Giá trị trả về của `second` (đáp ứng thay
 * thế của cổng MFA cho đường sign-in) PHẢI được truyền tiếp ra
 * ngoài — nuốt nó là đáp ứng gốc của endpoint (kèm token của phiên
 * cổng vừa huỷ) lọt về client như một lần đăng nhập thành công.
 * TUYỆT ĐỐI không ghi đè `hooks` bằng spread sau khối này — spread
 * sau sẽ lặng lẽ thay cả cổng MFA (lỗi đã suýt xảy ra khi rebase
 * 2.4 lên main có cổng MFA).
 */
function composeAfterHooks(
  first: AuthMiddleware | undefined,
  second: AuthMiddleware,
) {
  if (!first) return second;
  return createAuthMiddleware(async (ctx) => {
    await invokeChainedHook(first, ctx);
    return invokeChainedHook(second, ctx);
  });
}

/**
 * Gọi một after-hook NGAY BÊN TRONG một after-hook khác (chuỗi hoá
 * thủ công) và hợp nhất kết quả vào context hiện tại, bắt chước
 * đúng việc dispatch của Better Auth làm khi hook đứng một mình:
 *
 * - Tầng middleware của better-call tạo `responseHeaders` RIÊNG cho
 *   mỗi lần gọi và trả kết quả dạng `{ headers, response }` khi
 *   context mang `returnHeaders` (đúng context dispatch truyền cho
 *   hooks): cookie/header hook ghi (cookie chờ bước hai của cổng
 *   MFA, xoá cookie phiên…) nằm trong `headers` đó — không hợp nhất
 *   vào context ngoài thì chúng biến mất lặng lẽ; còn trả nguyên
 *   lớp bọc ra ngoài thì dispatch hiểu lầm nó là đáp ứng của
 *   endpoint và làm hỏng cả luồng hook đi qua.
 * - Phần `response` là đáp ứng thay thế thật của hook (hoặc
 *   `undefined` khi hook đi qua) — đó là giá trị hàm này trả về.
 * - Lỗi APIError (redirect của cổng MFA ở đường callback) mang
 *   header của hook theo cơ chế riêng của better-call và dispatch
 *   tự hợp nhất khi bắt lỗi — đường ném không qua hàm này.
 */
type ChainedHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

async function invokeChainedHook(hook: AuthMiddleware, ctx: ChainedHookContext): Promise<unknown> {
  const result: unknown = await hook(ctx as never);
  if (
    result !== null &&
    typeof result === 'object' &&
    'response' in result &&
    'headers' in result &&
    (result as { headers: unknown }).headers instanceof Headers
  ) {
    const headers = (result as { headers: Headers }).headers;
    for (const cookie of headers.getSetCookie()) {
      ctx.responseHeaders.append('set-cookie', cookie);
    }
    for (const [key, value] of headers.entries()) {
      if (key !== 'set-cookie') ctx.responseHeaders.set(key, value);
    }
    return (result as { response: unknown }).response;
  }
  return result;
}

export function createBetterAuth(deps: BetterAuthFactoryDeps) {
  const mcpAs = deps.mcpAs ?? null;
  const lockoutHookSet = deps.lockout ? lockoutHooks(deps.lockout) : null;
  // Cổng MFA cho mọi đường đăng nhập (mật khẩu, email OTP, callback
  // social) — xem mfa-gate.ts; trạng thái đọc từ `user_totp` qua phụ
  // thuộc `deps.mfa` do service truyền vào, hook tự đi qua ở mọi
  // đường không cấp phiên mới.
  const mfaGate = createMfaGateHook({
    isMfaEnabled: deps.mfa?.isMfaEnabled,
  });
  return betterAuth({
    secret: deps.secret,
    baseURL: deps.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    trustedOrigins: deps.trustedOrigins,
    socialProviders: buildSocialProviders(deps.socialProviders),
    // ── Ánh xạ model → bảng/cột (issue #654, D2) ─────────────────────
    // Schema bóng bộ máy cũ đã xoá: ánh xạ sống ở chính options này theo
    // cơ chế chính thức của Better Auth (core `db/get-tables`: đọc
    // `options.<model>.modelName` + `options.<model>.fields.<field>`).
    // Chỉ override các cột camelCase → snake_case; cột một từ và bảng
    // đã khớp tên mặc định (`session`, `account`, `verification`)
    // không cần khai. Bảng vật lý + default cột sống ở migration/DDL
    // thật; kiểm chứng lúc chạy do adapter bật validateSchema mặc
    // định (sai ánh xạ ném SchemaMismatchError ngay lần dùng đầu).
    user: {
      modelName: 'users',
      fields: {
        name: 'first_name',
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
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
    verification: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    hooks: {
      // Chuỗi after-hook DUY NHẤT của instance: `hooks.after` của
      // 1.7.12 chỉ nhận MỘT handler (dispatch bọc nó bằng matcher luôn
      // đúng — đã đối chiếu dist), nên cả ba khâu after phải chuỗi vào
      // đây qua composeAfterHooks — không phía nào ghi đè phía nào:
      // (1) lockout ghi attempt (điểm 2.4, dựa trên đáp ứng gốc của
      // endpoint); (2) cổng MFA của mọi đường đăng nhập (tự đi qua ở
      // mọi đường không cấp phiên mới; ném redirect cho đường
      // callback, trả JSON twoFactorRedirect cho đường sign-in);
      // (3) đồng bộ ngược hash của cửa sổ bake ở hai endpoint đổi/đặt
      // mật khẩu. Ba khâu tác động ba tập đường rời nhau nên thứ tự
      // không đổi semantics của nhau.
      ...(lockoutHookSet?.before ? { before: lockoutHookSet.before } : {}),
      after: composeAfterHooks(lockoutHookSet?.after, createAuthMiddleware(async (ctx) => {
        // Cổng MFA có thể trả đáp ứng thay thế (JSON twoFactorRedirect
        // cho đường sign-in) — gọi qua invokeChainedHook để header
        // của cổng (cookie chờ, xoá cookie phiên) được hợp nhất, rồi
        // truyền đáp ứng thay thế ra ngoài ngay, không chạy khâu sau
        // trên một đáp ứng đã bị thay.
        const gateResult = await invokeChainedHook(mfaGate, ctx);
        if (gateResult !== undefined) return gateResult;
        // Đồng bộ ngược hash trong cửa sổ bake (xem
        // `legacyPasswordSync` ở deps): hai endpoint đổi/đặt mật
        // khẩu của chính user mang phiên trong context — sau khi
        // endpoint chạy, hash hiện hành đã nằm ở dòng credential,
        // service chép nó về users.password_hash. Endpoint lỗi (sai
        // mật khẩu hiện tại…) thì hash không đổi, lần chép này là
        // no-op vô hại — cơ chế đồng bộ theo trạng thái, không theo
        // sự kiện thành công.
        if (!deps.legacyPasswordSync) return;
        if (ctx.path !== '/change-password' && ctx.path !== '/set-password') return;
        const userId = ctx.context.session?.user?.id;
        if (!userId) return;
        await deps.legacyPasswordSync.syncFromCredentialAccount(userId);
      })),
    },
    // Khi compose AS: tắt endpoint `/token` của plugin jwt() theo tài
    // liệu OAuth Provider (token chỉ phát qua `/oauth2/token`).
    ...(mcpAs ? { disabledPaths: ['/token'] } : {}),
    database: ((options) => {
      const baseAdapter = kyselyAdapter(deps.db, {
        type: 'postgres',
        transaction: true,
      });
      return withPostgresArrays(baseAdapter(options));
    }) as ReturnType<typeof kyselyAdapter>,
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
      // Đồng bộ ngược hash trong cửa sổ bake (xem `legacyPasswordSync`
      // ở deps): callback này của 1.7.12 chạy SAU khi mật khẩu mới đã
      // ghi vào credential — ở cả endpoint reset bằng link lẫn đường
      // reset bằng email OTP của plugin (cả hai đều gọi
      // onPasswordReset, đã đối chiếu dist) — nên một điểm nối phủ đủ
      // mọi đường reset; service tự đọc hash hiện hành từ dòng
      // credential rồi chép về users.password_hash.
      ...(deps.legacyPasswordSync
        ? {
            onPasswordReset: async ({ user }: { user: { id: string } }): Promise<void> => {
              await deps.legacyPasswordSync!.syncFromCredentialAccount(user.id);
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
      // Plugin twoFactor của Better Auth CHỦ ĐÍCH không đăng ký:
      // (1) cổng tự động của nó quyết định theo cờ `twoFactorEnabled`
      // và kho `two_factor`, trong khi trạng thái MFA của sản phẩm
      // sống ở `user_totp` — đăng ký một mình không gác được gì;
      // (2) schema của plugin khai trường user `twoFactorEnabled`
      // kèm giá trị mặc định, tầng core chèn trường đó vào mọi
      // payload tạo user và adapter bộ máy cũ từ chối vì ánh xạ user
      // của hệ không có trường này — bật plugin là hỏng mọi đường
      // tạo user (đã kiểm chứng trên bản 1.7.12 đã ghim). Thêm cột
      // thật sẽ dựng nguồn trạng thái MFA thứ hai phải đồng bộ với
      // `user_totp`. Vì vậy: quyết định gác nằm ở cổng riêng
      // (mfa-gate.ts) tra `user_totp`, còn bước hoàn tất nằm ở tầng
      // Nest (`two-factor-completion.*`) kiểm mã thẳng vào
      // `user_totp` — chi tiết ở đầu file của hai nơi đó.
      // Lát BA-2 (issue #7 chặng 2.5): đăng nhập bằng email OTP — plugin dựng từ factory trong module mail, mã gửi qua cổng mail (outbox → Resend).
      ...(deps.authMail ? [createEmailOtpPlugin(deps.authMail)] : []),
      // ── Lát MCP-1 (issue #163): máy chủ OAuth cho MCP ──────────────
      // Chỉ compose khi cờ MCP_AS_ENABLED bật (service truyền mcpAs).
      // CIMD (client_id là URL tài liệu metadata, hồ sơ
      // mcp-2026-07-28) là đường đăng ký chính; DCR để lại cho client
      // legacy nên bật tường minh cả ba tuỳ chọn theo addendum §2.
      ...(mcpAs
        ? [
            jwt({
              disableSettingJwtHeader: true,
              // Ánh xạ jwks → cột snake_case (issue #654, D2): schema
              // gốc của plugin jwt không khai fieldName nên adapter
              // hỏi đúng tên field; bảng vật lý dùng snake_case nên
              // override tại đây qua `mergeSchema` (cùng cơ chế như
              // schema của plugin oauth-provider). Không override thì
              // lần dùng đầu tiên của JWKS ném lỗi cột không tồn tại
              // (adapter bật validateSchema mặc định nên lỗi lộ ngay,
              // không truy vấn sai lặng lẽ).
              schema: {
                jwks: {
                  fields: {
                    publicKey: 'public_key',
                    privateKey: 'private_key',
                    createdAt: 'created_at',
                    expiresAt: 'expires_at',
                  },
                },
              },
            }),
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
              // ── Ánh xạ bảng OAuth → bảng vật lý (issue #654, D2) ──
              // Cơ chế chính thức: plugin oauth-provider đọc
              // `opts.schema?.<model>.modelName/fields` qua `mergeSchema`
              // (chỉ override field đã có trong schema gốc). Bảng vật lý
              // có tiền tố `oauth_` + tên cột snake_case; `usePlural`
              // không dùng được vì nó số nhiều hoá cả `session` →
              // `sessions`. Bảng `jwks` của plugin jwt được override
              // riêng tại khối `jwt()` bên dưới (không thuộc schema
              // của plugin oauth-provider).
              schema: {
                oauthClient: {
                  modelName: 'oauth_client',
                  fields: {
                    clientId: 'client_id',
                    clientSecret: 'client_secret',
                    clientDiscoveryId: 'client_discovery_id',
                    skipConsent: 'skip_consent',
                    enableEndSession: 'enable_end_session',
                    subjectType: 'subject_type',
                    clientCredentialsScopes: 'client_credentials_scopes',
                    userId: 'user_id',
                    createdAt: 'created_at',
                    updatedAt: 'updated_at',
                    softwareId: 'software_id',
                    softwareVersion: 'software_version',
                    softwareStatement: 'software_statement',
                    redirectUris: 'redirect_uris',
                    postLogoutRedirectUris: 'post_logout_redirect_uris',
                    backchannelLogoutUri: 'backchannel_logout_uri',
                    backchannelLogoutSessionRequired:
                      'backchannel_logout_session_required',
                    tokenEndpointAuthMethod: 'token_endpoint_auth_method',
                    applicationType: 'application_type',
                    jwksUri: 'jwks_uri',
                    grantTypes: 'grant_types',
                    responseTypes: 'response_types',
                    requirePKCE: 'require_pkce',
                    dpopBoundAccessTokens: 'dpop_bound_access_tokens',
                    referenceId: 'reference_id',
                  },
                },
                oauthResource: {
                  modelName: 'oauth_resource',
                  fields: {
                    accessTokenTtl: 'access_token_ttl',
                    refreshTokenTtl: 'refresh_token_ttl',
                    signingAlgorithm: 'signing_algorithm',
                    signingKeyId: 'signing_key_id',
                    allowedScopes: 'allowed_scopes',
                    customClaims: 'custom_claims',
                    dpopBoundAccessTokensRequired:
                      'dpop_bound_access_tokens_required',
                    createdAt: 'created_at',
                    updatedAt: 'updated_at',
                    policyVersion: 'policy_version',
                  },
                },
                oauthClientResource: {
                  modelName: 'oauth_client_resource',
                  fields: {
                    clientId: 'client_id',
                    resourceId: 'resource_id',
                    createdAt: 'created_at',
                  },
                },
                oauthAccessToken: {
                  modelName: 'oauth_access_token',
                  fields: {
                    clientId: 'client_id',
                    sessionId: 'session_id',
                    userId: 'user_id',
                    referenceId: 'reference_id',
                    authorizationCodeId: 'authorization_code_id',
                    requestedUserInfoClaims: 'requested_user_info_claims',
                    refreshId: 'refresh_id',
                    expiresAt: 'expires_at',
                    createdAt: 'created_at',
                  },
                },
                oauthRefreshToken: {
                  modelName: 'oauth_refresh_token',
                  fields: {
                    clientId: 'client_id',
                    sessionId: 'session_id',
                    userId: 'user_id',
                    referenceId: 'reference_id',
                    authorizationCodeId: 'authorization_code_id',
                    requestedUserInfoClaims: 'requested_user_info_claims',
                    expiresAt: 'expires_at',
                    createdAt: 'created_at',
                    rotatedAt: 'rotated_at',
                    rotationReplayResponse: 'rotation_replay_response',
                    rotationReplayExpiresAt: 'rotation_replay_expires_at',
                    authTime: 'auth_time',
                  },
                },
                oauthConsent: {
                  modelName: 'oauth_consent',
                  fields: {
                    clientId: 'client_id',
                    userId: 'user_id',
                    referenceId: 'reference_id',
                    requestedUserInfoClaims: 'requested_user_info_claims',
                    createdAt: 'created_at',
                    updatedAt: 'updated_at',
                  },
                },
                oauthClientAssertion: {
                  modelName: 'oauth_client_assertion',
                  fields: {
                    expiresAt: 'expires_at',
                  },
                },
              },
            }),
            cimd({
              fetchClientMetadataResource: mcpAs.cimdFetch ?? defaultCimdFetch,
              metadataProfile: 'mcp-2026-07-28',
            }),
          ]
        : []),
    ],
    // Đồng bộ ngược trong cửa sổ bake (xem `legacyPasswordSync` ở
    // deps): database hook chỉ nối ở chiều TẠO credential — hook
    // create.after nhận đúng bản ghi vừa tạo nên biết chắc user. Các
    // đường CẬP NHẬT mật khẩu (change-password, reset) nối ở tầng
    // endpoint/callback như ghi ở deps, KHÔNG nối ở database hook
    // update: `updatePassword` của 1.7.12 đi qua updateMany mà
    // adapter trả số dòng bị ảnh hưởng — hook update.after sẽ nhận
    // một con số và im lặng không làm gì (bẫy đã kiểm chứng trong
    // dist, xem tài liệu của `legacyPasswordSync`).
    ...(deps.legacyPasswordSync
      ? {
          databaseHooks: {
            account: {
              create: {
                after: async (account: { providerId: string; userId: string }) => {
                  if (account.providerId === 'credential') {
                    await deps.legacyPasswordSync!.syncFromCredentialAccount(account.userId);
                  }
                },
              },
            },
          },
        }
      : {}),
    session: {
      // Ánh xạ session → cột snake_case (issue #654, D2): cùng khối
      // với cookieCache — KHÔNG tách thành khối `session` riêng vì
      // khóa trùng trong object literal sẽ bị khối sau ghi đè (khuyết
      // tật đã bắt tại e2e: adapter báo thiếu cột session.expiresAt…).
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        userId: 'user_id',
      },
      cookieCache: { enabled: false },
    },
    advanced: {
      disableOriginCheck: false,
      // BA-1 (chốt blocker của BA-2, comment 6405565755 trên #7):
      // `generateId: "uuid"` thay cho `false` trước đây. Đã đối chiếu
      // mã nguồn 1.7.12 (`@better-auth/core` get-id-field + adapter
      // Kysely `dist/index.mjs`):
      // - id tất định (SHA-256 của identifier) chỉ định dạng thành
      //   UUID khi generateId là "uuid" — với `false` nó thành chuỗi
      //   base64url và Postgres ném 22P02 khi chèn vào cột
      //   `verification.id` kiểu uuid (đường revokeUnprovenAccountAccess
      //   khi user chưa xác minh đăng nhập OTP → HTTP 500);
      // - id thường vẫn do PostgreSQL tự sinh UUIDv7 như trước: với
      //   "uuid" và adapter Kysely khai `supportsUUIDs: true` khi
      //   `type: 'postgres'`, `shouldGenerateId` = false nên field id
      //   không có defaultValue phía ứng dụng, default uuidv7() của
      //   cột vẫn thắng. Cơ chế này thay thế cơ chế phía bộ máy cũ
      //   (đã kiểm chứng lại bằng ca DB thật ở issue #654: bản ghi
      //   user/session/account/verification đều mang id UUIDv7 do DB
      //   sinh, id tất định dạng UUID không ném 22P02).
      // Thay đổi bề mặt hẹp nhưng đã kiểm chứng lại toàn bề mặt auth
      // (xem spec better-auth-mail-flow + better-auth-flow).
      database: { generateId: 'uuid' },
    },
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
