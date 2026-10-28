/**
 * Cổng MFA cho MỌI đường đăng nhập của Better Auth (mật khẩu, email
 * OTP, callback social) — nguồn trạng thái MFA duy nhất là bảng
 * `user_totp` của hệ xác thực tự viết, nơi giao diện bật/tắt MFA ghi
 * vào. Bất biến của cổng: tài khoản có factor TOTP đã xác nhận trong
 * `user_totp` thì không đường đăng nhập nào của Better Auth được để
 * lại một phiên sống trước khi qua bước hai.
 *
 * Vì sao cổng này tồn tại thay vì chỉ dựa vào plugin twoFactor:
 *
 * - Plugin twoFactor tự gác các endpoint credential qua cờ
 *   `twoFactorEnabled` trên user — cờ đó ánh xạ tới cột
 *   `two_factor_enabled` chưa tồn tại trong cơ sở dữ liệu, và trạng
 *   thái MFA của sản phẩm sống ở `user_totp`, không ở kho của
 *   plugin. Cổng của plugin vì vậy không bao giờ kích hoạt với tài
 *   khoản bật MFA qua giao diện; đăng ký plugin một mình là vô
 *   hiệu. Cổng ở đây tra `user_totp` qua phụ thuộc do
 *   `BetterAuthService` truyền vào.
 * - Plugin cũng KHÔNG được đăng ký để làm cơ chế hoàn tất bước
 *   hai: schema của plugin khai trường user `twoFactorEnabled` kèm
 *   giá trị mặc định, tầng core chèn trường đó vào mọi payload tạo
 *   user, và adapter Drizzle từ chối trường không có trong ánh xạ
 *   user của hệ (đã kiểm chứng: bật plugin là mọi đường tạo user
 *   qua cầu nối đều ném `The field "twoFactorEnabled" does not
 *   exist in the "user" Drizzle schema`). Thêm cột thật cho plugin
 *   sẽ dựng nguồn trạng thái MFA thứ hai phải đồng bộ với
 *   `user_totp` — đúng điều thiết kế này cấm. Bước hoàn tất vì vậy
 *   nằm ở tầng Nest (`two-factor-completion.*` cùng thư mục, route
 *   `/auth/two-factor/*` được mount chừa cho Nest): nó kiểm mã
 *   TOTP thẳng vào `user_totp` qua `TotpService` và cấp phiên qua
 *   cầu nối phiên lập trình sẵn có — một nguồn trạng thái duy
 *   nhất, không kho plugin nào tham gia.
 * - Đường email OTP (`/sign-in/email-otp`, plugin emailOTP của
 *   module mail) và callback social (`/callback/:provider`) vốn
 *   không nằm trong matcher của cổng plugin — cổng này phủ cả hai.
 *
 * Cơ chế (đối chiếu source của better-auth@1.7.12 đã ghim):
 *
 * - Mọi endpoint đăng nhập đều tạo phiên qua `setSessionCookie` (→
 *   `setNewSession`) trước khi trả đáp ứng, và tầng dispatch vẫn
 *   chạy after-hooks trên đáp ứng đó, nên tại hook này
 *   `ctx.context.newSession` mang đủ {session, user} của phiên vừa
 *   tạo.
 * - Khi user đã bật MFA: xoá cookie phiên khỏi response
 *   (`deleteSessionCookie` — scrub cả hai scope header, token
 *   phiên không rò qua header thô), xoá dòng session,
 *   `setNewSession(null)`, rồi phát dấu chờ bước hai đúng định
 *   dạng plugin twoFactor tự tạo (verification `2fa-<id>` →
 *   userId, `2fa-attempts-<id>` = "0", cookie ký
 *   `better-auth.two_factor` chứa id, hạn 600 giây) — endpoint
 *   hoàn tất ở tầng Nest đọc lại đúng các dấu này (cùng bảng
 *   verification, cùng cơ chế cookie ký) và áp cùng semantics:
 *   tối đa 5 lần thử cho một challenge, hết thì challenge chết.
 * - Đáp ứng theo họ đường: đường credential/OTP trả JSON
 *   `{ twoFactorRedirect: true, twoFactorMethods: ['totp'] }` —
 *   đúng hình plugin tự trả ở luồng credential, client web dịch
 *   thành bước nhập mã; đường callback thay redirect gốc bằng
 *   redirect về callbackURL của client kèm
 *   `twoFactorRedirect=true` để phía web mở bước hai (cùng họ quy
 *   ước `?oauthError=` của luồng OAuth cũ).
 * - Cookie `trust_device` hợp lệ được tôn trọng như plugin (kiểm
 *   HMAC + bản ghi verification còn hạn, có xoay vòng) thì bỏ qua
 *   cổng.
 * - Cổng FAIL-CLOSED khi không xác minh được: tra cứu trạng thái
 *   MFA mà lỗi thì KHÔNG được hiểu là "chưa bật MFA" — cổng ghi
 *   log lỗi, huỷ phiên vừa tạo ở cả hai tầng như khi cổng kích
 *   hoạt, rồi ném lỗi dừng đăng nhập. Lỗi tra cứu không bao giờ
 *   được để lại một phiên sống.
 * - Factory không có phụ thuộc MFA (các điểm dựng instance kiểm
 *   chứng tối thiểu) thì cổng không gắn — đúng khuôn phụ thuộc
 *   lockout của instance; đường chạy thật của app luôn truyền
 *   phụ thuộc qua `BetterAuthService`.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';

/** Tên cookie chờ bước hai (constant trong dist của plugin twoFactor; endpoint hoàn tất ở tầng Nest đọc lại đúng tên này qua createAuthCookie của instance). */
const TWO_FACTOR_COOKIE_NAME = 'two_factor';
/** Tên cookie tin cậy thiết bị của plugin twoFactor. */
const TRUST_DEVICE_COOKIE_NAME = 'trust_device';
/** Hạn của dấu chờ bước hai — mặc định `twoFactorCookieMaxAge` của plugin (600 giây). */
const TWO_FACTOR_CHALLENGE_MAX_AGE_SECONDS = 600;
/** Hạn cookie trust device — mặc định của plugin (720 giờ = 30 ngày). */
const TRUST_DEVICE_MAX_AGE_SECONDS = 720 * 60 * 60;

/**
 * Các đường sign-in cấp phiên mà cổng phủ, ngoài callback: đăng nhập
 * mật khẩu bằng username/email và đăng nhập bằng email OTP. (Đường
 * `/sign-in/phone-number` không có mặt — hệ không đăng ký plugin số
 * điện thoại nào.)
 */
const SIGN_IN_GATE_PATHS: ReadonlySet<string> = new Set(['/sign-in/username', '/sign-in/email', '/sign-in/email-otp']);

/** Chuỗi ngẫu nhiên không đoán được cho identifier (plugin dùng generateRandomString alphanumeric; ở đây base64url cùng độ dài ký tự). */
function randomIdentifier(length: number): string {
  return randomBytes(Math.ceil((length * 3) / 4))
    .toString('base64url')
    .slice(0, length);
}

/** HMAC-SHA256 dạng base64url không đệm — đúng thuật toán `createHMAC("SHA-256", "base64urlnopad")` mà plugin dùng cho cookie trust device. */
function hmacSha256Base64Url(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** Hình tối thiểu của response redirect mà callback để lại trong `context.returned` (APIError mang header location). */
interface ReturnedRedirect {
  headers?: Headers | Record<string, string | undefined>;
}

function locationOf(returned: unknown): string | null {
  const headers = (returned as ReturnedRedirect | null)?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('location');
  return headers.location ?? headers.Location ?? null;
}

type GateContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Kiểm cookie trust device theo đúng semantics của plugin: cookie ký
 * chứa `<hmac>!<trustIdentifier>`, hmac trên `<userId>!<trustIdentifier>`,
 * và phải còn bản ghi verification tương ứng chưa hết hạn. Hợp lệ thì
 * XOAY VÒNG (huỷ dấu cũ, phát dấu mới) như plugin làm ở luồng credential.
 */
async function consumeTrustDevice(ctx: GateContext, userId: string): Promise<boolean> {
  const cookieAttrs = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE_NAME, {
    maxAge: TRUST_DEVICE_MAX_AGE_SECONDS,
  });
  const cookie = await ctx.getSignedCookie(cookieAttrs.name, ctx.context.secret);
  if (!cookie) return false;
  const [token, trustIdentifier] = cookie.split('!');
  if (!token || !trustIdentifier) return false;
  const expected = hmacSha256Base64Url(ctx.context.secret, `${userId}!${trustIdentifier}`);
  if (!safeEqual(token, expected)) return false;
  const record = await ctx.context.internalAdapter.findVerificationValue(trustIdentifier);
  if (!record || record.value !== userId || record.expiresAt <= new Date()) return false;

  await ctx.context.internalAdapter.deleteVerificationByIdentifier(trustIdentifier);
  const newIdentifier = `trust-device-${randomIdentifier(32)}`;
  const newToken = hmacSha256Base64Url(ctx.context.secret, `${userId}!${newIdentifier}`);
  await ctx.context.internalAdapter.createVerificationValue({
    value: userId,
    identifier: newIdentifier,
    expiresAt: new Date(Date.now() + TRUST_DEVICE_MAX_AGE_SECONDS * 1000),
  });
  await ctx.setSignedCookie(cookieAttrs.name, `${newToken}!${newIdentifier}`, ctx.context.secret, cookieAttrs.attributes);
  return true;
}

/** Phụ thuộc của cổng do instance truyền vào — đọc qua nguồn trạng thái MFA duy nhất `user_totp`. */
export interface MfaGateDeps {
  /**
   * User đã bật MFA chưa, theo `user_totp.confirmed` (nơi giao diện
   * bật MFA ghi vào). Thiếu phụ thuộc này = cổng không gắn (xem đầu
   * file). Lỗi tra cứu phải LAN ra ngoài để cổng xử lý fail-closed —
   * tuyệt đối không nuốt thành "chưa bật MFA".
   */
  isMfaEnabled?: (userId: string) => Promise<boolean>;
}

/** Đích redirect sau khi cổng kích hoạt ở đường callback: callbackURL gốc của client + cờ báo phía web mở bước hai; không đọc được thì về trang đăng nhập cùng cờ. */
function twoFactorRedirectTarget(ctx: GateContext): string {
  const location = locationOf(ctx.context.returned);
  const fallback = `${ctx.context.baseURL}/login`;
  let url: URL;
  try {
    url = new URL(location ?? fallback, ctx.context.baseURL);
  } catch {
    url = new URL(fallback);
  }
  url.searchParams.set('twoFactorRedirect', 'true');
  return url.toString();
}

/**
 * After-hook của instance: tác động trên mọi đường đăng nhập vừa tạo
 * một phiên mới (callback social, sign-in mật khẩu, sign-in email
 * OTP) khi user đã bật MFA. Mọi trường hợp còn lại (đường khác,
 * endpoint không tạo phiên, liên kết tường minh khi đang đăng nhập —
 * các trường hợp đó không có `newSession`, user chưa bật MFA, thiết
 * bị đã tin cậy) hook đi qua không đổi hành vi.
 */
export function createMfaGateHook(deps: MfaGateDeps = {}) {
  return createAuthMiddleware(async (ctx) => {
    const isCallback = ctx.path.startsWith('/callback/');
    if (!isCallback && !SIGN_IN_GATE_PATHS.has(ctx.path)) return;
    const data = ctx.context.newSession;
    if (!data) return;
    // Không có phụ thuộc tra cứu = cổng không gắn (điểm dựng instance
    // kiểm chứng tối thiểu); đường chạy thật luôn truyền qua service.
    if (!deps.isMfaEnabled) return;
    const { session, user } = data;
    let mfaEnabled: boolean;
    try {
      mfaEnabled = await deps.isMfaEnabled(user.id);
    } catch (err) {
      // FAIL-CLOSED: không xác minh được trạng thái MFA thì phiên
      // vừa tạo không được sống — huỷ ở cả hai tầng như khi cổng
      // kích hoạt (cookie trên response + dòng session), ghi log,
      // rồi ném lỗi dừng đăng nhập. Cho đăng nhập đi qua ở đây sẽ
      // là bỏ qua bước hai lặng lẽ mỗi khi tra cứu lỗi.
      ctx.context.logger?.error(
        `MFA gate could not verify MFA status for user ${user.id}: ${String(err)}`,
      );
      deleteSessionCookie(ctx, true);
      await ctx.context.internalAdapter.deleteSession(session.token);
      ctx.context.setNewSession(null);
      throw new APIError('INTERNAL_SERVER_ERROR', {
        message: 'Could not verify multi-factor authentication status',
        code: 'mfa_status_unavailable',
      });
    }
    if (!mfaEnabled) return;
    if (await consumeTrustDevice(ctx, user.id)) return;

    // Xoá phiên vừa tạo ở cả hai tầng như plugin làm: cookie trên
    // response (kèm scrub header thô) và dòng session trong DB.
    deleteSessionCookie(ctx, true);
    await ctx.context.internalAdapter.deleteSession(session.token);
    ctx.context.setNewSession(null);

    // Phát dấu chờ bước hai đúng định dạng của plugin.
    const identifier = `2fa-${randomIdentifier(20)}`;
    const expiresAt = new Date(Date.now() + TWO_FACTOR_CHALLENGE_MAX_AGE_SECONDS * 1000);
    await ctx.context.internalAdapter.createVerificationValue({
      value: user.id,
      identifier,
      expiresAt,
    });
    await ctx.context.internalAdapter.createVerificationValue({
      value: '0',
      identifier: `2fa-attempts-${identifier}`,
      expiresAt,
    });
    const twoFactorCookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE_NAME, {
      maxAge: TWO_FACTOR_CHALLENGE_MAX_AGE_SECONDS,
    });
    await ctx.setSignedCookie(twoFactorCookie.name, identifier, ctx.context.secret, twoFactorCookie.attributes);

    if (isCallback) {
      throw ctx.redirect(twoFactorRedirectTarget(ctx));
    }
    // Đường credential/OTP: đáp ứng JSON đúng hình plugin tự trả —
    // client web (twoFactorClient) dịch thành bước nhập mã.
    return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
  });
}
