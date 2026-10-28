/**
 * Endpoint hooks gắn chính sách lockout vào các đường sign-in
 * credential của Better Auth (điểm 2.4 trong hồ sơ Giai đoạn 2 của
 * issue #7): cùng một `LoginLockoutService`, cùng một bảng
 * `login_attempts` với hệ legacy — không tồn tại hai hệ đếm.
 *
 * - `before`: với `/sign-in/username` và `/sign-in/email`, tài khoản
 *   đang bị khoá thì từ chối TRƯỚC khi endpoint kiểm mật khẩu, bằng
 *   đúng mã lỗi `auth.locked_out` của hệ legacy (kể cả khi mật khẩu
 *   gửi lên là đúng — semantics của cổng legacy trong
 *   `AuthService.validateCredentials`).
 * - `after`: ghi lần thử vào `login_attempts`, phân biệt thành
 *   công/thất bại qua `ctx.context.returned`: là `APIError` 401 của
 *   chính endpoint (sai mật khẩu / không có credential) thì ghi thất
 *   bại; đáp ứng thường (endpoint đã cấp phiên) thì ghi thành công.
 *   Lỗi do chính cổng `before` ném (mã `auth.locked_out`) và mọi lỗi
 *   không phải kiểm chứng danh tính (400 thiếu trường, 403 Origin…)
 *   KHÔNG ghi — khớp legacy: lần bị khoá không tự ghi thêm attempt,
 *   và username không tồn tại cũng không ghi (phân giải định danh
 *   không ra user thì tầng service tự bỏ qua).
 *
 * Việc ghi attempt không bao giờ được làm hỏng luồng đăng nhập: lỗi
 * ở đường ghi chỉ được log, không ném ngược vào đáp ứng.
 *
 * IP ghi kèm lấy theo đúng quy ước của dự án (common/client-ip): IP
 * khách thật là phần tử PHẢI NHẤT của `X-Forwarded-For` (chặng proxy
 * ở biên nối thêm vào phía phải), chuẩn hoá qua `normalizeIpAddress`.
 */
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { normalizeIpAddress } from '../../../common/client-ip';
import {
  AUTH_LOCKED_OUT_CODE,
  AUTH_LOCKED_OUT_MESSAGE,
  type LockoutGuardPort,
  type LoginIdentifier,
} from '../login-lockout.service';

const CREDENTIAL_SIGN_IN_PATHS: ReadonlySet<string> = new Set(['/sign-in/username', '/sign-in/email']);

function identifierOf(path: string, body: unknown): LoginIdentifier | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (path === '/sign-in/username') {
    return typeof record.username === 'string' && record.username.length > 0
      ? { username: record.username }
      : null;
  }
  return typeof record.email === 'string' && record.email.length > 0
    ? { email: record.email }
    : null;
}

function clientIpOf(headers: Headers | undefined): string | undefined {
  const forwarded = headers?.get('x-forwarded-for');
  if (!forwarded) return undefined;
  const parts = forwarded
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;
  return normalizeIpAddress(parts[parts.length - 1]);
}

/** Đáp ứng của endpoint có phải là thất bại kiểm chứng danh tính (sai mật khẩu / không có credential) hay không. */
function isCredentialFailure(returned: unknown): boolean {
  if (!(returned instanceof APIError)) return false;
  if (returned.body?.code === AUTH_LOCKED_OUT_CODE) return false;
  return returned.statusCode === 401;
}

export function lockoutHooks(lockout: LockoutGuardPort) {
  const before = createAuthMiddleware(async (ctx) => {
    if (!CREDENTIAL_SIGN_IN_PATHS.has(ctx.path)) return;
    const identifier = identifierOf(ctx.path, ctx.body);
    if (!identifier) return;
    if (await lockout.isLoginLocked(identifier)) {
      throw new APIError('UNAUTHORIZED', {
        message: AUTH_LOCKED_OUT_MESSAGE,
        code: AUTH_LOCKED_OUT_CODE,
      });
    }
  });

  const after = createAuthMiddleware(async (ctx) => {
    if (!CREDENTIAL_SIGN_IN_PATHS.has(ctx.path)) return;
    const identifier = identifierOf(ctx.path, ctx.body);
    if (!identifier) return;
    const returned = ctx.context.returned;
    const success = !(returned instanceof APIError);
    if (!success && !isCredentialFailure(returned)) return;
    try {
      await lockout.recordLoginAttempt(identifier, success, clientIpOf(ctx.headers));
    } catch (err) {
      ctx.context.logger?.error(
        `login attempt not recorded for sign-in (path ${ctx.path}): ${String(err)}`,
      );
    }
  });

  return { before, after };
}
