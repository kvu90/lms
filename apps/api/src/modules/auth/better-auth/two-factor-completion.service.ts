/**
 * Hoàn tất bước hai của đăng nhập Better Auth (endpoint
 * `/auth/two-factor/verify-totp` và `/auth/two-factor/verify-backup-code`
 * ở tầng Nest — mount chừa segment `two-factor` cho Nest, xem
 * `better-auth.mount.ts`).
 *
 * Vì sao bước hoàn tất nằm ở đây thay vì plugin twoFactor của Better
 * Auth: xem khối plugins trong `better-auth.instance.ts` (plugin đòi
 * trường user `twoFactorEnabled` không có trong ánh xạ của hệ và sẽ
 * dựng nguồn trạng thái MFA thứ hai). Ở đây trạng thái MFA và việc
 * kiểm mã đều đi qua MỘT nguồn duy nhất là `user_totp` qua
 * `TotpService` của module auth — cùng cơ chế verify mà các luồng
 * đăng nhập tự viết dùng.
 *
 * Giao thức với cổng MFA (`mfa-gate.ts`) — cổng phát, nơi này tiêu
 * thụ, đúng định dạng plugin twoFactor của better-auth@1.7.12 tự
 * dùng nên semantics hai phía khớp nhau:
 *
 * - Cookie ký `better-auth.two_factor` (tên lấy từ createAuthCookie
 *   của chính instance) chứa identifier của challenge; chữ ký HMAC
 *   kiểm bằng secret của instance (`makeSignature` +
 *   `constantTimeEqual` của `better-auth/crypto`).
 * - Dòng verification `2fa-<id>` → userId, hạn 600 giây; dòng
 *   `2fa-attempts-<id>` đếm số lần thử SAI của challenge đó, ngân
 *   sách 5 lần: mỗi lần verify đều TIÊU THỤ cả hai dòng trước;
 *   sai mã thì dựng lại dòng attempts với đếm +1 (cùng hạn của
 *   challenge), hết ngân sách thì challenge bị huỷ và bị từ chối
 *   bằng `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE` — người dùng phải
 *   đăng nhập lại để có challenge mới.
 * - Mã đúng: challenge đã tiêu thụ (không chơi lại được), phiên
 *   được tạo qua cầu nối phiên lập trình (cùng cơ chế login-as tạo
 *   phiên Better Auth ngoài handler) và cookie phiên được đặt theo
 *   đúng thuộc tính cookie của instance; cookie chờ bước hai bị
 *   xoá. Người dùng bị đình chỉ vẫn nhận phiên ở bước này như
 *   semantics của Better Auth — guard phiên chặn mọi route nghiệp
 *   vụ của tài khoản đình chỉ ngay sau đó.
 * - Kiểm Origin như handler Better Auth làm với POST mang cookie:
 *   Origin có mặt mà không thuộc origins tin cậy của instance thì
 *   403 trước mọi xử lý.
 * - Mã dự phòng: sản phẩm không có khái niệm mã dự phòng (factor
 *   TOTP của hệ tự viết không phát mã dự phòng) nên endpoint
 *   verify-backup-code luôn từ chối bằng `INVALID_BACKUP_CODE` —
 *   nhưng vẫn qua cùng cửa challenge + đếm lần thử để không thành
 *   một lối dò riêng.
 * - Thiết bị tin cậy (trust device): cổng có tôn trọng cookie tin
 *   cậy nếu tồn tại, nhưng bước hoàn tất này KHÔNG phát cookie tin
 *   cậy mới — giao diện không có tuỳ chọn "tin cậy thiết bị này",
 *   phát dấu mà người dùng không hề chọn sẽ là nới lỏng âm thầm.
 */
import { forwardRef, Inject, Injectable, Optional } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { Database } from '../../../db/database';
import { users } from '../../../db/schema';
import { TotpService } from '../totp.service';
import { betterAuthVerification } from './better-auth.schema';
import { BetterAuthService } from './better-auth.service';
import { CredentialBridgeService } from './credential-bridge.service';

/** Ngân sách lần thử sai cho một challenge — khớp `beginAttempt(5)` của plugin twoFactor 1.7.12. */
const MAX_CHALLENGE_ATTEMPTS = 5;
/** Tên cookie chờ bước hai trong createAuthCookie của instance (khớp cổng MFA). */
const TWO_FACTOR_COOKIE_NAME = 'two_factor';

/** Lỗi hoàn tất mang đúng hình lỗi của Better Auth: HTTP status + thân `{ code, message }`. */
export class TwoFactorCompletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TwoFactorCompletionError';
  }
}

/** Kết quả hoàn tất thành công: thông tin đặt cookie phiên + thân đáp ứng cho client. */
export interface TwoFactorCompletionResult {
  sessionCookieName: string;
  sessionCookieValue: string;
  sessionCookieAttributes: Record<string, unknown>;
  sessionExpiresAt: Date;
  twoFactorCookieName: string;
  twoFactorCookieAttributes: Record<string, unknown>;
  body: { token: string; user: Record<string, unknown> };
}

/** Challenge đã giải từ cookie chờ: định danh, chủ sở hữu và hạn dùng. */
interface ResolvedChallenge {
  identifier: string;
  userId: string;
  expiresAt: Date;
  attempts: number;
  twoFactorCookieName: string;
  twoFactorCookieAttributes: Record<string, unknown>;
}

@Injectable()
export class TwoFactorCompletionService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly betterAuth: BetterAuthService,
    private readonly bridge: CredentialBridgeService,
    // Cùng khuôn phụ thuộc với BetterAuthService: AuthModule xuất
    // TotpService qua vòng forwardRef; thiếu phụ thuộc (chỉ xảy ra
    // khi module bị dựng dở) thì mọi verify bị từ chối fail-closed
    // ở completeTotp thay vì cho qua.
    @Optional()
    @Inject(forwardRef(() => TotpService))
    private readonly totp?: TotpService,
  ) {}

  /**
   * Kiểm mã TOTP của bước hai và cấp phiên khi mã đúng.
   *
   * @param req Request thô (đọc cookie chờ + Origin).
   * @param code Mã 6 số người dùng nhập.
   * @returns Kết quả để controller đặt cookie phiên và trả thân.
   * @throws TwoFactorCompletionError với mã lỗi theo ngữ nghĩa
   *   Better Auth khi challenge không hợp lệ/hết hạn/hết ngân sách
   *   hoặc mã sai.
   */
  async verifyTotp(req: Request, code: string): Promise<TwoFactorCompletionResult> {
    const challenge = await this.resolveChallenge(req);
    await this.beginAttempt(challenge);
    if (!this.totp) {
      throw new TwoFactorCompletionError(500, 'mfa_status_unavailable', 'Could not verify multi-factor authentication status');
    }
    let valid = false;
    try {
      valid = await this.totp.verifyForUser(challenge.userId, code);
    } catch {
      // Lỗi ở tầng kiểm mã (không phải mã sai): trả lại ngân sách
      // của lần thử này như semantics `restore()` của plugin, rồi
      // fail-closed — không kết luận được thì không cấp phiên.
      await this.rearmAttempts(challenge, challenge.attempts);
      throw new TwoFactorCompletionError(500, 'mfa_status_unavailable', 'Could not verify multi-factor authentication status');
    }
    if (!valid) {
      await this.rearmAttempts(challenge, challenge.attempts + 1);
      throw new TwoFactorCompletionError(401, 'INVALID_CODE', 'Invalid code');
    }
    return this.issueSession(challenge);
  }

  /**
   * Mã dự phòng: sản phẩm không phát mã dự phòng nên luôn từ chối;
   * vẫn đi qua cửa challenge + đếm lần thử như verify TOTP.
   */
  async verifyBackupCode(req: Request): Promise<never> {
    const challenge = await this.resolveChallenge(req);
    await this.beginAttempt(challenge);
    await this.rearmAttempts(challenge, challenge.attempts + 1);
    throw new TwoFactorCompletionError(400, 'INVALID_BACKUP_CODE', 'Invalid backup code');
  }

  /**
   * Giải challenge từ cookie chờ: kiểm Origin, chữ ký cookie, hạn
   * dùng và sự tồn tại của dòng verification. Mọi bất thường đều là
   * `INVALID_TWO_FACTOR_COOKIE` (401) như plugin — không phân biệt
   * "không có cookie" với "chữ ký sai" với "đã hết hạn" để không lộ
   * trạng thái challenge.
   */
  private async resolveChallenge(req: Request): Promise<ResolvedChallenge> {
    let auth: ReturnType<BetterAuthService['requireAuth']>;
    try {
      auth = this.betterAuth.requireAuth();
    } catch {
      throw new TwoFactorCompletionError(404, 'NOT_FOUND', 'Not found');
    }
    const ctx = await auth.$context;
    const cookieAttrs = ctx.createAuthCookie(TWO_FACTOR_COOKIE_NAME, { maxAge: 600 });
    // Kiểm Origin như handler Better Auth: Origin có mặt phải thuộc
    // origins tin cậy (gồm origin của baseURL) — chặn POST chéo
    // origin mang cookie chờ.
    const origin = req.headers.origin;
    if (origin) {
      const trustedOrigins = ctx.options.trustedOrigins ?? [];
      let baseOrigin: string | null = null;
      try {
        baseOrigin = new URL(ctx.baseURL).origin;
      } catch {
        baseOrigin = null;
      }
      if (origin !== baseOrigin && !trustedOrigins.includes(origin)) {
        throw new TwoFactorCompletionError(403, 'FORBIDDEN', 'Forbidden');
      }
    }
    const invalid = () =>
      new TwoFactorCompletionError(401, 'INVALID_TWO_FACTOR_COOKIE', 'Invalid two factor cookie');
    const rawCookie = cookieValueOf(req, cookieAttrs.name);
    if (!rawCookie) throw invalid();
    const dot = rawCookie.lastIndexOf('.');
    if (dot <= 0) throw invalid();
    const identifier = rawCookie.slice(0, dot);
    const signature = rawCookie.slice(dot + 1);
    const expected = await makeSignature(identifier, ctx.secret);
    if (!constantTimeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
    if (!identifier.startsWith('2fa-')) throw invalid();
    const [pending] = await this.db
      .select()
      .from(betterAuthVerification)
      .where(eq(betterAuthVerification.identifier, identifier))
      .limit(1);
    if (!pending || pending.expiresAt <= new Date()) throw invalid();
    const [attemptsRow] = await this.db
      .select()
      .from(betterAuthVerification)
      .where(eq(betterAuthVerification.identifier, `2fa-attempts-${identifier}`))
      .limit(1);
    const parsed = attemptsRow ? Number(attemptsRow.value) : Number.NaN;
    return {
      identifier,
      userId: pending.value,
      expiresAt: pending.expiresAt,
      attempts: Number.isInteger(parsed) && parsed >= 0 ? parsed : MAX_CHALLENGE_ATTEMPTS,
      twoFactorCookieName: cookieAttrs.name,
      twoFactorCookieAttributes: cookieAttrs.attributes as Record<string, unknown>,
    };
  }

  /**
   * Mở một lần thử: TIÊU THỤ cả hai dòng của challenge (đúng
   * semantics consume của plugin). Hết ngân sách (đếm đã đạt trần)
   * thì challenge chết hẳn tại đây: từ chối bằng
   * `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE` và không dựng lại dòng nào.
   */
  private async beginAttempt(challenge: ResolvedChallenge): Promise<void> {
    await this.db
      .delete(betterAuthVerification)
      .where(eq(betterAuthVerification.identifier, challenge.identifier));
    await this.db
      .delete(betterAuthVerification)
      .where(eq(betterAuthVerification.identifier, `2fa-attempts-${challenge.identifier}`));
    if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
      throw new TwoFactorCompletionError(
        400,
        'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
        'Too many attempts. Please request a new code.',
      );
    }
  }

  /** Dựng lại dòng đếm lần thử sau một lần verify không thành công (cùng hạn với challenge). */
  private async rearmAttempts(challenge: ResolvedChallenge, count: number): Promise<void> {
    await this.db.insert(betterAuthVerification).values({
      identifier: `2fa-attempts-${challenge.identifier}`,
      value: String(count),
      expiresAt: challenge.expiresAt,
    });
    // Dòng challenge phải sống lại cùng dòng đếm: beginAttempt đã
    // tiêu thụ cả hai, lần verify kế tiếp cần tìm thấy challenge.
    await this.db.insert(betterAuthVerification).values({
      identifier: challenge.identifier,
      value: challenge.userId,
      expiresAt: challenge.expiresAt,
    });
  }

  /**
   * Cấp phiên sau khi qua bước hai: phiên lập trình qua cầu nối
   * (cùng cơ chế login-as), thân đáp ứng theo hình plugin trả
   * (`{ token, user }` ở dạng đã lược bỏ trường nhạy cảm).
   */
  private async issueSession(challenge: ResolvedChallenge): Promise<TwoFactorCompletionResult> {
    const ctx = await this.betterAuth.requireAuth().$context;
    const [user] = await this.db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        firstName: users.firstName,
        lastName: users.lastName,
        emailVerified: users.emailVerified,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(and(eq(users.id, challenge.userId)))
      .limit(1);
    if (!user) {
      throw new TwoFactorCompletionError(401, 'INVALID_TWO_FACTOR_COOKIE', 'Invalid two factor cookie');
    }
    const session = await this.bridge.createProgrammaticSession(user.id);
    return {
      sessionCookieName: ctx.authCookies.sessionToken.name,
      sessionCookieValue: session.signedCookieValue,
      sessionCookieAttributes: ctx.authCookies.sessionToken.attributes as Record<string, unknown>,
      sessionExpiresAt: session.expiresAt,
      twoFactorCookieName: challenge.twoFactorCookieName,
      twoFactorCookieAttributes: challenge.twoFactorCookieAttributes,
      body: {
        token: session.token,
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          name: `${user.firstName} ${user.lastName}`.trim(),
          emailVerified: user.emailVerified,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        },
      },
    };
  }
}

/** Đọc một cookie theo tên từ header Cookie thô (giá trị đã decode URI). */
function cookieValueOf(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
