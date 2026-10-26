import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../../../db/database';
import { authAccount, users } from '../../../db/schema';
import { PasswordService } from '../../users/password.service';
import { AuthMailService } from '../../mail/auth-mail.service';
import { LoginLockoutService } from '../login-lockout.service';
import {
  BETTER_AUTH_SESSION_COOKIE,
  createBetterAuth,
  type BetterAuthInstance,
  type BetterAuthMcpAsConfig,
  type BetterAuthSocialConfig,
} from './better-auth.instance';

export type AuthCutoverStage = 'off' | 'bake';

/**
 * Chủ sở hữu duy nhất của Better Auth instance trong tiến trình API.
 *
 * Instance tồn tại khi MỘT trong hai cờ bật:
 * - `BETTER_AUTH_ENABLED` (Giai đoạn 1 của issue #7): phiên BA song
 *   song với hệ auth tự viết — `enabled` giữ nguyên nghĩa này, guard
 *   nhận diện cookie và bridge chỉ chạy theo nó.
 * - `MCP_AS_ENABLED` (lát MCP-1, issue #163): instance kiêm máy chủ
 *   OAuth cho MCP — factory compose thêm jwt()/mcp()/cimd() (xem
 *   better-auth.instance.ts). Cờ này KHÔNG chờ cutover GĐ2: AS chỉ cần
 *   phiên BA + bảng users chung mà GĐ1 đã có.
 *
 * Cả hai cờ đều tắt thì service không dựng instance, handler không
 * được mount (main.ts dựa vào `auth !== null`), hành vi của hệ auth
 * hiện tại không đổi. Cờ bật mà thiếu `BETTER_AUTH_SECRET` thì
 * constructor ném lỗi: app từ chối boot thay vì âm thầm chạy một hệ
 * auth thiếu secret.
 *
 * Cờ thứ ba — `AUTH_CUTOVER_STAGE` (chặng 2.7): KHÔNG dựng instance,
 * nó chỉ chọn LUỒNG CHÍNH từng phần trong cửa sổ bake ('bake' đòi hỏi
 * `BETTER_AUTH_ENABLED`, xem constructor) và bật hook đồng bộ ngược
 * mật khẩu. Mặc định 'off' — hành vi hiện tại.
 */
@Injectable()
export class BetterAuthService {
  private readonly logger = new Logger(BetterAuthService.name);

  readonly enabled: boolean;
  /** Cờ riêng của lát MCP-1: instance có compose máy chủ OAuth hay không. */
  readonly mcpAsEnabled: boolean;
  readonly auth: BetterAuthInstance | null;
  /** Cấu hình AS đã dùng dựng instance (null khi không bật) — RS ở tầng MCP lấy issuer/resource qua đây. */
  readonly mcpAs: BetterAuthMcpAsConfig | null;
  /** Provider xã hội đã đăng ký vào instance (chặng 2.3) — rỗng khi chưa cấu hình env nào. */
  readonly socialProvidersEnabled: readonly ('google' | 'facebook')[];
  /**
   * Chặng cutover của GĐ2 (env `AUTH_CUTOVER_STAGE`): 'off' = luồng
   * cũ là chính như hiện tại; 'bake' = cửa sổ bake của bước A chặng
   * 2.7 (login-as phát phiên BA; đổi mật khẩu qua BA đồng bộ ngược
   * hash về users.password_hash — xem createBetterAuth bên dưới).
   */
  readonly cutoverStage: AuthCutoverStage;
  /**
   * Tên cookie phiên như chính Better Auth đặt (thêm tiền tố
   * `__Secure-` khi baseURL là https) — các điểm tự đặt cookie phiên
   * BA ngoài handler của nó (login-as, chặng 2.6) phải dùng đúng tên
   * này, và guard nhận cả hai dạng.
   */
  readonly sessionCookieName: string;
  /** Cookie phiên có thuộc tính Secure hay không (khớp quy tắc của Better Auth theo baseURL). */
  readonly sessionCookieSecure: boolean;

  constructor(
    config: ConfigService,
    @InjectDrizzle() db: Database,
    passwordService: PasswordService,
    // Cổng mail auth (chặng 2.5): Nest chích từ MailModule. Phải là
    // @Optional tường minh và KHÔNG khai union `| null` ở chữ ký —
    // union làm metadata phản chiếu thành Object khiến Nest không
    // phân giải được tham số. Các nơi dựng service tay (unit spec,
    // script) không truyền thì instance chạy không có đường mail —
    // đúng nghĩa "chưa nối mail" của factory, không phải lỗi.
    @Optional() authMail?: AuthMailService,
    // Cổng lockout theo tài khoản (điểm 2.4): cùng khuôn @Optional
    // như authMail — nơi dựng tay không truyền thì instance chạy
    // không gắn hooks lockout (đúng nghĩa "thiếu = không gắn" của
    // factory); app thật luôn có LoginLockoutService từ AuthModule.
    @Optional() lockout?: LoginLockoutService,
  ) {
    this.enabled = config.get<boolean>('BETTER_AUTH_ENABLED') ?? false;
    this.mcpAsEnabled = config.get<boolean>('MCP_AS_ENABLED') ?? false;
    const socialProviders = readSocialConfig(config);
    this.socialProvidersEnabled = [
      ...(socialProviders.google ? (['google'] as const) : []),
      ...(socialProviders.facebook ? (['facebook'] as const) : []),
    ];
    this.cutoverStage = config.get<AuthCutoverStage>('AUTH_CUTOVER_STAGE') ?? 'off';
    // Cửa sổ bake phát phiên Better Auth làm luồng chính từng phần —
    // nó vô nghĩa khi chính Better Auth không bật: fail-fast như
    // thiếu secret, thay vì chạy một cấu hình nửa vời.
    if (this.cutoverStage === 'bake' && !this.enabled) {
      throw new Error(
        'AUTH_CUTOVER_STAGE=bake requires BETTER_AUTH_ENABLED=true (the bake window runs on Better Auth sessions)',
      );
    }
    if (!this.enabled && !this.mcpAsEnabled) {
      this.auth = null;
      this.mcpAs = null;
      this.sessionCookieName = BETTER_AUTH_SESSION_COOKIE;
      this.sessionCookieSecure = false;
      return;
    }
    const secret = config.get<string>('BETTER_AUTH_SECRET');
    if (!secret) {
      throw new Error(
        'BETTER_AUTH_SECRET is required when BETTER_AUTH_ENABLED or MCP_AS_ENABLED is true',
      );
    }
    const baseURL =
      config.get<string>('BETTER_AUTH_URL') ?? `http://localhost:${config.get<number>('PORT') ?? 3000}`;
    // Quy tắc cookie của chính Better Auth: baseURL https ⇒ cookie
    // Secure + tiền tố `__Secure-` trong tên.
    this.sessionCookieSecure = baseURL.startsWith('https://');
    this.sessionCookieName = this.sessionCookieSecure
      ? `__Secure-${BETTER_AUTH_SESSION_COOKIE}`
      : BETTER_AUTH_SESSION_COOKIE;
    const extraOrigins = (config.get<string>('BETTER_AUTH_TRUSTED_ORIGINS') ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);

    // Resource của MCP phải là URI công khai mà client nhìn thấy (nó
    // trở thành `aud` của access token và đích của PRM): ưu tiên
    // MCP_PUBLIC_BASE_URL — cùng một origin mà mount MCP quảng bá —
    // rồi rơi về origin của BA, cuối cùng là baseURL.
    const mcpPublicBase = (
      config.get<string>('MCP_PUBLIC_BASE_URL') ??
      config.get<string>('BETTER_AUTH_URL') ??
      baseURL
    ).replace(/\/+$/, '');
    this.mcpAs = this.mcpAsEnabled
      ? {
          resource: `${mcpPublicBase}/mcp`,
          loginPage: '/mcp-login',
          consentPage: '/mcp-consent',
        }
      : null;

    this.auth = createBetterAuth({
      // Adapter của Better Auth chỉ dùng core query builder trên instance
      // Drizzle (đã kiểm chứng ở Giai đoạn 0) — ép kiểu ở biên DI này là
      // an toàn: instance thật là của app với relations đầy đủ, adapter
      // không chạm tới phần relations.
      db: db as unknown as Parameters<typeof createBetterAuth>[0]['db'],
      secret,
      baseURL,
      trustedOrigins: [...new Set([baseURL, ...extraOrigins])],
      passwordService,
      authMail: authMail ?? null,
      mcpAs: this.mcpAs,
      socialProviders,
      // Lockout theo tài khoản (điểm 2.4): instance gắn hooks khi
      // có cổng — chính sách khoá là của tài khoản, không phải của cờ.
      lockout: lockout ?? null,
      // Cửa sổ bake (chặng 2.7 bước A): mọi lần Better Auth ghi mật
      // khẩu credential mới (đổi mật khẩu, đặt lại qua reset, tạo
      // credential) đều đồng bộ ngược hash hiện hành về
      // `users.password_hash` — điều kiện để tắt AUTH_CUTOVER_STAGE
      // về 'off' là quay lại luồng cũ trọn vẹn (rollback trước bước
      // B). Ngoài cửa sổ bake: không hook, hành vi như hiện tại.
      legacyPasswordSync:
        this.cutoverStage === 'bake'
          ? {
              syncFromCredentialAccount: async (userId: string): Promise<void> => {
                // Hash nguồn là hash ĐANG NẰM ở dòng credential —
                // đọc tại thời điểm gọi (sau khi phía Better Auth đã
                // ghi xong) nên không cần biết đường nào vừa ghi.
                // Lỗi đồng bộ không được làm hỏng thao tác auth vừa
                // thành công (mật khẩu mới đã là sự thật ở phía BA)
                // — nhưng phải kêu to trong log thay vì âm thầm để
                // hai hệ lệch mật khẩu trong cửa sổ bake.
                try {
                  const [row] = await db
                    .select({ password: authAccount.password })
                    .from(authAccount)
                    .where(and(eq(authAccount.userId, userId), eq(authAccount.providerId, 'credential')))
                    .limit(1);
                  if (!row?.password) return;
                  await db.update(users).set({ passwordHash: row.password }).where(eq(users.id, userId));
                } catch (err) {
                  this.logger.warn(`legacy password sync failed for user ${userId}: ${String(err)}`);
                }
              },
            }
          : null,
    });
  }

  /** Instance khi có cờ bật; ném lỗi rõ ràng nếu gọi lúc cả hai cờ tắt (lỗi lập trình, không phải lỗi người dùng). */
  requireAuth(): BetterAuthInstance {
    if (!this.auth) {
      throw new Error(
        'Better Auth is not enabled (BETTER_AUTH_ENABLED and MCP_AS_ENABLED are both off)',
      );
    }
    return this.auth;
  }
}

/**
 * Đọc cấu hình đăng nhập xã hội từ env (issue #7, chặng 2.3): provider
 * chỉ vào cấu hình khi CẢ id lẫn secret đều có mặt — thiếu một phía
 * thì provider đó tắt êm (không đăng ký, không lỗi boot), đúng luật
 * "issuer chưa cấu hình thì không có bề mặt" của hệ.
 */
function readSocialConfig(config: ConfigService): BetterAuthSocialConfig {
  const googleId = config.get<string>('GOOGLE_CLIENT_ID');
  const googleCred = config.get<string>('GOOGLE_CLIENT_SECRET');
  const facebookId = config.get<string>('FACEBOOK_APP_ID');
  const facebookCred = config.get<string>('FACEBOOK_APP_SECRET');
  return {
    ...(googleId && googleCred ? { google: { clientId: googleId, clientSecret: googleCred } } : {}),
    ...(facebookId && facebookCred
      ? { facebook: { clientId: facebookId, clientSecret: facebookCred } }
      : {}),
  };
}
