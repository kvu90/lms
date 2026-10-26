/**
 * Cổng chặn hoàn tất OAuth khi tài khoản đã bật MFA (issue #7, chặng
 * 2.3) — kết luận spike đăng trên issue #7 (comment 6404763453), chốt
 * bằng source của better-auth@1.7.12 + better-call@1.4.4 đã ghim:
 *
 * - Plugin twoFactor chỉ tự chặn ở các endpoint credential (after-hook
 *   của chính plugin trên `/sign-in/email|username|phone-number`);
 *   callback OAuth (`/callback/:id`) tạo phiên thẳng nên mặc định lọt
 *   qua cổng — đây là lỗ hổng chặng này bịt.
 * - Cơ chế ở đây là bản sao trung thực của after-hook của plugin, áp
 *   cho đường callback: callback gọi `setSessionCookie` (→
 *   `setNewSession`) trước khi ném redirect, và tầng dispatch của
 *   better-call vẫn chạy after-hooks trên response redirect đó, nên
 *   tại hook này `ctx.context.newSession` mang đủ {session, user}.
 * - Khi user đã bật MFA: xoá cookie phiên khỏi response
 *   (`deleteSessionCookie` — scrub cả hai scope header, token phiên
 *   không rò qua header thô), xoá dòng session, `setNewSession(null)`,
 *   rồi phát dấu chờ bước hai ĐÚNG định dạng plugin tự tạo ở luồng
 *   credential (verification `2fa-<id>` → userId, `2fa-attempts-<id>`
 *   = "0", cookie ký `better-auth.two_factor` chứa id, hạn 600 giây).
 *   Nhờ vậy endpoint hoàn tất của plugin (`/two-factor/verify-totp`,
 *   `/two-factor/verify-backup-code`) dùng lại nguyên vẹn — semantics
 *   đếm lần sai/khoá là của plugin, không có hệ đếm thứ hai.
 * - Sau response của callback: KHÔNG tồn tại dòng session, KHÔNG
 *   cookie phiên được phát — chỉ có dấu chờ bước hai. Redirect gốc
 *   được thay bằng redirect về chính callbackURL của client kèm
 *   `twoFactorRedirect=true` để phía web mở màn hình bước hai (cùng
 *   họ quy ước `?oauthError=` của luồng OAuth cũ).
 * - Cookie `trust_device` hợp lệ được tôn trọng như plugin (kiểm HMAC
 *   + bản ghi verification còn hạn, có xoay vòng) thì bỏ qua cổng.
 * - Tín hiệu "đã bật MFA": cờ `twoFactorEnabled` trên user (có mặt
 *   khi chặng 2.2 merge) HOẶC bản ghi `two_factor` với `verified =
 *   true` — ở trạng thái ổn định hai tín hiệu trùng nhau (cờ chỉ bật
 *   sau khi user qua verify lúc enable; bản ghi chưa verify là trạng
 *   thái đang setup dở, KHÔNG được chặn), nên cổng không phụ thuộc
 *   thứ tự merge giữa các chặng.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createAuthMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';

/** Tên cookie chờ bước hai của plugin twoFactor (constant trong dist của plugin). */
const TWO_FACTOR_COOKIE_NAME = 'two_factor';
/** Tên cookie tin cậy thiết bị của plugin twoFactor. */
const TRUST_DEVICE_COOKIE_NAME = 'trust_device';
/** Hạn của dấu chờ bước hai — mặc định `twoFactorCookieMaxAge` của plugin (600 giây). */
const TWO_FACTOR_CHALLENGE_MAX_AGE_SECONDS = 600;
/** Hạn cookie trust device — mặc định của plugin (720 giờ = 30 ngày). */
const TRUST_DEVICE_MAX_AGE_SECONDS = 720 * 60 * 60;

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

/** User đã bật MFA chưa: cờ của plugin khi có mặt, ngược lại suy từ bản ghi two_factor đã verify. */
async function isMfaEnabled(ctx: GateContext, user: { id: string; twoFactorEnabled?: boolean | null }): Promise<boolean> {
  if (user.twoFactorEnabled === true) return true;
  const record = await ctx.context.adapter
    .findOne({
      model: 'twoFactor',
      where: [{ field: 'userId', value: user.id }],
    })
    .catch(() => null);
  return Boolean(record && (record as { verified?: boolean }).verified === true);
}

/** Đích redirect sau khi cổng kích hoạt: callbackURL gốc của client + cờ báo phía web mở bước hai; không đọc được thì về trang đăng nhập cùng cờ. */
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
 * After-hook của instance: chỉ tác động trên đường callback OAuth khi
 * callback vừa tạo một phiên mới cho user đã bật MFA. Mọi trường hợp
 * còn lại (không phải callback, callback lỗi, liên kết tường minh khi
 * đang đăng nhập — các trường hợp đó không có `newSession`) hook đi
 * qua không đổi hành vi.
 */
export function createOAuthMfaGateHook() {
  return createAuthMiddleware(async (ctx) => {
    if (!ctx.path.startsWith('/callback/')) return;
    const data = ctx.context.newSession;
    if (!data) return;
    const { session, user } = data;
    if (!(await isMfaEnabled(ctx, user))) return;
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

    throw ctx.redirect(twoFactorRedirectTarget(ctx));
  });
}
