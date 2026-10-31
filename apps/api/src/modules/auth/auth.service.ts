import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';
import { AuthRepository } from './auth.repository';
import {
  AUTH_LOCKED_OUT_CODE,
  AUTH_LOCKED_OUT_MESSAGE,
  LoginLockoutService,
} from './login-lockout.service';
import { BetterAuthService } from './better-auth/better-auth.service';
import { CredentialBridgeService } from './better-auth/credential-bridge.service';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';
import { tenantAls } from '../tenants/tenant-als';
import { TenantsService } from '../tenants/tenants.service';

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }

/**
 * Thông tin máy khách của request đang cấp phiên/token: địa chỉ IP và
 * chuỗi User-Agent lấy từ request ở controller (`clientIpOf(req)` —
 * điểm lấy IP khách duy nhất ở common/client-ip, đã gồm cấu hình
 * proxy tin cậy và chuẩn hoá địa chỉ; `req.headers['user-agent']`).
 * Được ghi một lần lên họ refresh token lúc tạo họ để danh sách
 * phiên hiển thị đúng máy khách của phiên.
 */
export interface SessionClientInfo { ip?: string; userAgent?: string }

/**
 * Kết quả sau bước mật khẩu: hoặc đã đủ điều kiện cấp token, hoặc bị chặn
 * ở bước MFA với một challenge token ngắn hạn (scope `mfa_challenge` — chỉ
 * dùng được cho POST /auth/mfa/verify, JwtAuthStrategy từ chối nó ở mọi
 * route thường).
 */
export type PasswordLoginOutcome =
  | { mfaRequired: false; user: UserRow; tokens: TokenPair }
  | { mfaRequired: true; user: UserRow; challengeToken: string };

/**
 * Kết quả đăng nhập phiên cookie: hoặc phiên đã tạo xong, hoặc bị chặn ở
 * bước MFA với challenge của luồng session (chưa tạo phiên nào).
 */
export type SessionLoginOutcome =
  | { mfaRequired: false; user: UserRow; sessionId: string }
  | { mfaRequired: true; user: UserRow; challengeToken: string };

/**
 * Đích hoàn tất của một challenge MFA: mỗi luồng đăng nhập có đích
 * riêng và challenge của luồng này KHÔNG dùng chéo sang luồng khác
 * được (kiểm ở `passMfaChallenge`): `token` → POST /auth/mfa/verify
 * (cấp cặp token), `session` → POST /auth/session/mfa/verify (tạo
 * phiên cookie), `oauth` → POST /auth/oauth/mfa/verify (tạo phiên web
 * + mã bàn giao của luồng OAuth), `platform` → POST
 * /auth/platform/mfa/verify (cấp access token platform).
 * Challenge còn mang không gian kho riêng của lần đăng nhập đã cấp
 * nó (claim `space`, issue #584): bước hai chỉ hoàn tất khi request
 * đang ở đúng địa chỉ của không gian đó — challenge của trung tâm
 * này không đổi được thành phiên của trung tâm khác.
 */
export type MfaChallengeFlow = 'token' | 'session' | 'oauth' | 'platform';

/**
 * Kết quả đăng nhập quản trị platform: hoặc đã đủ điều kiện cấp
 * access token platform, hoặc bị chặn ở bước MFA với một challenge
 * token ngắn hạn của luồng platform. Token platform CHỈ có access
 * token (không có refresh family): hết hạn thì đăng nhập lại —
 * bề mặt vận hành không dùng cơ chế xoay refresh của đường
 * nghiệp vụ.
 */
export type PlatformLoginOutcome =
  | { mfaRequired: false; user: UserRow; accessToken: string; expiresIn: number }
  | { mfaRequired: true; user: UserRow; challengeToken: string };

/**
 * Kết quả login-as theo chặng cutover (GĐ2 chặng 2.6/2.7, issue #7):
 * `legacy` = cặp token JWT của hệ cũ (chặng `AUTH_CUTOVER_STAGE=off`,
 * hiện trạng); `better-auth` = phiên lập trình của Better Auth
 * (`AUTH_CUTOVER_STAGE=bake`) — controller đặt cookie phiên đã ký,
 * đáp ứng KHÔNG mang token JWT nào. Cổng kiểm tra (capability, lý do
 * bắt buộc, chặn đích không hoạt động/admin) và audit `user_loginas`
 * là CHUNG cho cả hai chặng.
 */
export type LoginAsOutcome =
  | { mode: 'legacy'; user: UserRow; tokens: TokenPair; tenantId: string }
  | { mode: 'better-auth'; user: UserRow; tenantId: string; baSession: { signedCookieValue: string; expiresAt: Date } };

/** Định danh các phiên "hiện tại" theo ngữ cảnh của người gọi: `familyId` là `sid` trong access token, `webSessionId` là id phiên trong cookie. */
export interface CurrentSessionRefs { familyId?: string; webSessionId?: string }

/** Một phiên đang hoạt động trong danh sách quản lý phiên của chính user (report_usersessions). */
export interface MySessionView {
  id: string;
  kind: 'web' | 'api';
  createdAt: string;
  lastActivityAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }

/**
 * Facade của AuthModule (report §3.7). Xác thực KHÔNG phải ghi danh và KHÔNG phải
 * gán role: một lần đăng nhập thành công chỉ chứng minh danh tính; người dùng được
 * làm gì do PermissionEvaluator quyết định, còn quyền vào khoá học do Enrol quyết định.
 * Refresh token là opaque, được lưu dưới dạng đã băm, nhóm theo family, được xoay vòng ở
 * mỗi lần dùng; phát lại một token đã bị xoay vòng sẽ thu hồi toàn bộ family.
 */
@Injectable()
/**
 * Xác thực và vòng đời token: đăng nhập, refresh xoay vòng, đăng xuất, đổi mật khẩu, login-as.
 * Đối chiếu Moodle: lib/moodlelib.php (authenticate_user_login, login_attempt_failed) và cơ chế session.
 * Chính sách: khoá tạm thời sau nhiều lần thất bại liên tiếp (auth.locked_out); suspended/deleted không đăng nhập được;
 * refresh token xoay theo family — tái sử dụng token cũ sẽ thu hồi cả family.
 */
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: SessionService,
    private readonly evaluator: PermissionEvaluator,
    private readonly contexts: ContextsService,
    private readonly totp: TotpService,
    private readonly outbox: OutboxService,
    private readonly tenants: TenantsService,
    private readonly lockout: LoginLockoutService,
    private readonly betterAuth: BetterAuthService,
    private readonly credentialBridge: CredentialBridgeService,
    private readonly spaceDb: SpaceDatabaseService,
  ) {}

  private readonly logger = new Logger(AuthService.name);

  /**
   * Phát sự kiện vòng đời phiên (user_logged_in / user_logged_out) vào
   * outbox: relay sẽ phản chiếu sang event_log (logstore). Ghi sự kiện
   * không bao giờ được làm hỏng luồng đăng nhập — lỗi chỉ ghi cảnh báo.
   */
  private async recordAuthEvent(type: 'user_logged_in' | 'user_logged_out', payload: Record<string, unknown>): Promise<void> {
    await this.outbox
      .enqueueStandalone({ aggregate: 'auth', type, payload })
      .catch((err) => this.logger.warn(`auth event ${type} not recorded: ${String(err)}`));
  }

  /**
   * Ghi sự kiện đăng nhập cho các luồng hoàn tất nằm ngoài AuthService
   * (OAuth handoff): cùng một điểm ghi user_logged_in như các luồng nội bộ.
   */
  async recordLoginEvent(user: UserRow, method: string, client?: SessionClientInfo): Promise<void> {
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method, ip: client?.ip ?? null });
  }

  // --- lockout: chính sách nằm ở LoginLockoutService (dùng chung với
  // Better Auth qua endpoint hooks, điểm 2.4 của issue #7) -------------

  /**
   * Kiểm tra username/mật khẩu và trạng thái tài khoản; trả user khi hợp lệ.
   */
  async validateCredentials(username: string, password: string, ip?: string): Promise<UserRow> {
    const user = await this.users.getByUsername(username);
    if (!user || user.deleted) {
      throw new UnauthorizedException({ message: 'Invalid username or password', code: 'auth.invalid_credentials' });
    }
    if (await this.lockout.isLockedOut(user.id)) {
      throw new UnauthorizedException({ message: AUTH_LOCKED_OUT_MESSAGE, code: AUTH_LOCKED_OUT_CODE });
    }
    const ok = await this.users.verifyPassword(user, password);
    await this.lockout.recordAttempt({ userId: user.id, username: user.username, success: ok, ip });
    if (!ok) throw new UnauthorizedException({ message: 'Invalid username or password', code: 'auth.invalid_credentials' });
    if (user.suspended) throw new ForbiddenException({ message: 'Account is suspended', code: 'auth.account_suspended' });
    if (user.isGuest) throw new ForbiddenException({ message: 'The guest account cannot log in with a password', code: 'auth.guest_login_denied' });
    return user;
  }

  /**
   * Đăng nhập bằng mật khẩu: kiểm lockout, ghi attempt; nếu user đã bật
   * MFA thì dừng ở challenge (chưa ghi nhận đăng nhập, chưa cấp token),
   * ngược lại phát hành cặp token như cũ.
   */
  async login(username: string, password: string, ip?: string, userAgent?: string): Promise<PasswordLoginOutcome> {
    const user = await this.validateCredentials(username, password, ip);
    return this.completePasswordLogin(user, { ip, userAgent });
  }

  /**
   * Hoàn tất bước mật khẩu cho một user đã qua `validateCredentials`:
   * user bật MFA ⇒ trả challenge token; còn lại ghi nhận đăng nhập và
   * phát hành cặp token. Dùng chung cho cả hai route đăng nhập.
   */
  async completePasswordLogin(user: UserRow, client?: SessionClientInfo): Promise<PasswordLoginOutcome> {
    if (await this.totp.isEnabled(user.id)) {
      const challengeToken = await this.signMfaChallenge(user, 'token');
      return { mfaRequired: true, user, challengeToken };
    }
    await this.users.recordLogin(user.id);
    const tokens = await this.issueTokens(user, client);
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'password', ip: client?.ip ?? null });
    return { mfaRequired: false, user, tokens };
  }

  /**
   * Ký challenge token cho bước MFA: JWT ngắn hạn mang `scope:
   * 'mfa_challenge'` và KHÔNG mang `sid` phiên — JwtAuthStrategy từ chối
   * nó nên không thể dùng để gọi bất kỳ API thường nào. Claim `flow` phân
   * biệt đích hoàn tất: `token` chỉ đổi được ở POST /auth/mfa/verify (cấp
   * cặp token), `session` chỉ đổi được ở POST /auth/session/mfa/verify
   * (tạo phiên cookie), `oauth` chỉ đổi được ở POST /auth/oauth/mfa/verify
   * (tạo phiên web + mã bàn giao), `platform` chỉ đổi được ở POST
   * /auth/platform/mfa/verify (cấp access token platform) — challenge
   * của luồng này không dùng chéo sang luồng kia được. Claim `space`
   * (issue #584) ghim không gian kho riêng của lần đăng nhập đã cấp
   * challenge — có khi request đang ở địa chỉ kho riêng, vắng khi ở
   * địa chỉ gốc — để bước hoàn tất kiểm lại đúng địa chỉ đó.
   */
  private async signMfaChallenge(user: UserRow, flow: MfaChallengeFlow): Promise<string> {
    const ttl = this.config.get<number>('MFA_CHALLENGE_TTL_SECONDS') ?? 300;
    const spaceSlug = tenantAls.getStore()?.spaceSlug;
    return this.jwt.signAsync(
      { sub: user.id, username: user.username, scope: 'mfa_challenge', flow, ...(spaceSlug ? { space: spaceSlug } : {}) },
      { expiresIn: ttl },
    );
  }

  // --- MFA TOTP (tool_mfa factor_totp) ---------------------------------------
  /**
   * User đã bật MFA TOTP hay chưa (đã có secret được confirm) — trạng
   * thái duy nhất giao diện hồ sơ cần để hiện mục xác thực hai lớp.
   */
  async isMfaEnabled(userId: string): Promise<boolean> { return this.totp.isEnabled(userId); }

  /**
   * Khởi tạo MFA TOTP cho chính user (chỉ trả secret ở bước này). Khi
   * user đã có factor đang bật, `currentCode` là mã TOTP hiện tại để
   * tái xác thực trước khi thay factor — cổng nằm ở `TotpService.setup`.
   */
  async setupTotp(user: UserRow, currentCode?: string): Promise<{ secret: string; otpauthUrl: string }> {
    return this.totp.setup(user.id, user.username, currentCode);
  }

  /**
   * Xác nhận setup bằng mã authenticator ⇒ bật MFA cho user.
   */
  async confirmTotp(userId: string, code: string): Promise<void> { await this.totp.confirm(userId, code); }

  /**
   * Tắt MFA bằng mã authenticator hiện tại ⇒ xoá secret.
   */
  async disableTotp(userId: string, code: string): Promise<void> { await this.totp.disable(userId, code); }

  /**
   * Quản trị gỡ MFA cho user bị mất authenticator (route đã chặn bằng
   * capability quản trị người dùng ở controller).
   */
  async resetTotp(userId: string): Promise<void> { await this.totp.resetForUser(userId); }

  /**
   * Bước hai của đăng nhập: kiểm challenge token (chữ ký, hạn, scope) rồi
   * kiểm mã TOTP. Mã sai bị ghi như một lần đăng nhập thất bại nên dùng
   * chung cơ chế lockout sẵn có; mã đúng mới ghi nhận đăng nhập và cấp
   * cặp token + phiên như đăng nhập thường.
   */
  async verifyMfa(challengeToken: string, code: string, ip?: string, userAgent?: string): Promise<{ user: UserRow; tokens: TokenPair }> {
    const user = await this.passMfaChallenge(challengeToken, code, ip, 'token');
    await this.users.recordLogin(user.id);
    const tokens = await this.issueTokens(user, { ip, userAgent });
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'totp', ip: ip ?? null });
    return { user, tokens };
  }

  // --- đăng nhập quản trị platform (issue #584) ---------------------------
  /**
   * Bề mặt đăng nhập QUẢN TRỊ PLATFORM, tách khỏi bề mặt đăng nhập
   * nghiệp vụ của trung tâm: chỉ tài khoản quản trị platform (ghi
   * trong cấu hình `siteadmins` của kho chung) mới qua được cổng
   * này; tài khoản thường — kể cả quản trị của một trung tâm —
   * bị 403 `auth.platform_admin_required`. Đăng nhập ở địa chỉ kho
   * riêng tra tài khoản trong kho đó nên quản trị platform ở kho
   * chung không đăng nhập được tại đó — bề mặt vận hành sống ở
   * địa chỉ gốc. Token cấp ra mang audience `platform` (không có
   * refresh family) nên `AudienceGuard` chỉ cho nó gọi route vận
   * hành mang `@PlatformRoute()`; user bật MFA thì dừng ở challenge
   * của luồng platform như luồng token.
   */
  async platformLogin(username: string, password: string, ip?: string, userAgent?: string): Promise<PlatformLoginOutcome> {
    const user = await this.validateCredentials(username, password, ip);
    if (!(await this.evaluator.isSiteAdmin(user.id))) {
      throw new ForbiddenException({ message: 'Only platform administrators may use this login surface', code: 'auth.platform_admin_required' });
    }
    if (await this.totp.isEnabled(user.id)) {
      const challengeToken = await this.signMfaChallenge(user, 'platform');
      return { mfaRequired: true, user, challengeToken };
    }
    await this.users.recordLogin(user.id);
    const issued = await this.issuePlatformToken(user);
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'platform-password', ip: ip ?? null });
    return { mfaRequired: false, user, accessToken: issued.accessToken, expiresIn: issued.expiresIn };
  }

  /**
   * Bước hai của đăng nhập platform: qua thử thách MFA của luồng
   * platform rồi cấp access token platform như `platformLogin`.
   */
  async verifyPlatformMfa(challengeToken: string, code: string, ip?: string, userAgent?: string): Promise<{ user: UserRow; accessToken: string; expiresIn: number }> {
    const user = await this.passMfaChallenge(challengeToken, code, ip, 'platform');
    if (!(await this.evaluator.isSiteAdmin(user.id))) {
      throw new ForbiddenException({ message: 'Only platform administrators may use this login surface', code: 'auth.platform_admin_required' });
    }
    await this.users.recordLogin(user.id);
    const issued = await this.issuePlatformToken(user);
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'platform-totp', ip: ip ?? null });
    return { user, accessToken: issued.accessToken, expiresIn: issued.expiresIn };
  }

  /**
   * Cấp access token platform: claim `tid` là tenant platform của
   * kho chung, claim `aud` là `platform`, `sid` là UUID mới sinh
   * KHÔNG gắn với family refresh nào — token này không refresh và
   * không logout theo cơ chế family được; hết hạn thì đăng nhập
   * lại. `JwtAuthStrategy` chỉ kiểm `sid` có mặt nên token qua
   * được khâu xác thực, và `AudienceGuard` quyết định bề mặt gọi.
   */
  private async issuePlatformToken(user: UserRow): Promise<{ accessToken: string; expiresIn: number }> {
    const platformTenant = await this.tenants.platformTenant();
    const accessTtl = this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS') ?? 900;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, sid: randomUUID(), tid: platformTenant.id, aud: 'platform' },
      { expiresIn: accessTtl },
    );
    return { accessToken, expiresIn: accessTtl };
  }

  /**
   * Ký challenge MFA cho luồng OAuth: callback OAuth thấy user đã bật
   * MFA thì dừng ở đây (chưa tạo phiên, chưa phát mã bàn giao) và
   * chuyển hướng về trang đăng nhập kèm challenge này; bước hoàn tất
   * là `verifyOAuthMfa` qua POST /auth/oauth/mfa/verify.
   */
  async createOAuthMfaChallenge(user: UserRow): Promise<string> {
    return this.signMfaChallenge(user, 'oauth');
  }

  /**
   * Bước hai của đăng nhập OAuth: qua thử thách MFA (dùng chung lõi
   * với hai luồng còn lại — lockout + ghi attempt như nhau) và trả
   * user đã qua thử thách. Việc ghi nhận đăng nhập, tạo phiên web và
   * phát mã bàn giao thuộc về `OAuthService`, chủ của luồng đó.
   */
  async verifyOAuthMfa(challengeToken: string, code: string, ip?: string): Promise<UserRow> {
    return this.passMfaChallenge(challengeToken, code, ip, 'oauth');
  }

  /**
   * Lõi dùng chung của bước hai MFA cho cả ba luồng hoàn tất: kiểm
   * challenge token (chữ ký, hạn, scope và đúng `flow` đích), trạng thái
   * tài khoản, lockout, rồi kiểm mã TOTP. Mã sai bị ghi như một lần đăng
   * nhập thất bại nên dùng chung cơ chế lockout sẵn có. Trả user đã qua
   * thử thách; việc ghi nhận đăng nhập + cấp phiên/token thuộc về từng
   * luồng hoàn tất phía trên.
   *
   * Gắn không gian (issue #584): claim `space` của challenge phải khớp
   * slug kho riêng của request hoàn tất — lệch nhau theo bất kỳ chiều
   * nào (challenge cấp ở trung tâm A mà hoàn tất ở trung tâm B, hoặc
   * cấp ở địa chỉ gốc mà hoàn tất ở địa chỉ kho riêng và ngược lại)
   * đều bị từ chối bằng mã challenge không hợp lệ, không để lộ thêm
   * thông tin. Challenge ký trước khi có claim này (không mang
   * `space`) chỉ hoàn tất được ở địa chỉ gốc.
   */
  private async passMfaChallenge(challengeToken: string, code: string, ip: string | undefined, flow: MfaChallengeFlow): Promise<UserRow> {
    let payload: { sub?: string; scope?: string; flow?: string; space?: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: string; scope?: string; flow?: string; space?: string }>(challengeToken);
    } catch {
      throw new UnauthorizedException({ message: 'MFA challenge is invalid or expired', code: 'auth.mfa_challenge_invalid' });
    }
    // Challenge ký trước khi có claim `flow` được hiểu là của luồng token.
    const challengeFlow = payload.flow ?? 'token';
    if (payload.scope !== 'mfa_challenge' || !payload.sub || challengeFlow !== flow) {
      throw new UnauthorizedException({ message: 'MFA challenge is invalid or expired', code: 'auth.mfa_challenge_invalid' });
    }
    if (payload.space !== tenantAls.getStore()?.spaceSlug) {
      throw new UnauthorizedException({ message: 'MFA challenge is invalid or expired', code: 'auth.mfa_challenge_invalid' });
    }
    const user = await this.users.getByIdOrUndefined(payload.sub);
    if (!user || user.deleted || user.suspended) {
      throw new UnauthorizedException({ message: 'Account is not active', code: 'auth.account_inactive' });
    }
    if (await this.lockout.isLockedOut(user.id)) {
      throw new UnauthorizedException({ message: AUTH_LOCKED_OUT_MESSAGE, code: AUTH_LOCKED_OUT_CODE });
    }
    const ok = await this.totp.verifyForUser(user.id, code);
    await this.lockout.recordAttempt({ userId: user.id, username: user.username, success: ok, ip });
    if (!ok) {
      throw new UnauthorizedException({ message: 'Invalid two-factor authentication code', code: 'auth.mfa_invalid_code' });
    }
    return user;
  }

  /** Cấp một family refresh-token mới + access token (dùng sau khi local strategy đã kiểm chứng thông tin đăng nhập). */
  /**
   * Phát hành access token (JWT) + refresh token mới trong một family.
   */
  async issueTokensFor(user: UserRow, client?: SessionClientInfo): Promise<TokenPair> { return this.issueTokens(user, client); }

  /**
   * Không gian kho riêng của request hiện tại, suy từ slug trung tâm
   * mà interceptor đã ghim vào ALS (do `SpaceContextGuard` chuẩn bị
   * trước handler). Trả `null` khi request không ở địa chỉ kho riêng
   * nào (địa chỉ gốc, trung tâm kho chung, hoặc tầng định tuyến
   * chưa cấu hình/lỗi thoáng qua — các trường hợp đó rơi về luồng
   * kho chung cũ, và `SpaceContextGuard` vẫn là chốt chặn cuối cho
   * phiên ở địa chỉ kho riêng nên không có đường nới lỏng nào).
   */
  private async requestDedicatedSpace(): Promise<{ slug: string; spaceId: string } | null> {
    const slug = tenantAls.getStore()?.spaceSlug;
    if (!slug) return null;
    try {
      const target = await this.spaceDb.resolveTarget(slug);
      return target.mode === 'dedicated' ? { slug, spaceId: target.spaceId } : null;
    } catch {
      return null;
    }
  }

  /**
   * Phát hành cặp token: claim `tid` ghi tenant hiệu lực của phiên
   * (TENANT-0, #168) — không truyền `tenantId` thì phân giải tenant mặc
   * định xác định của user; family refresh lưu lại tid để refresh giữ
   * đúng tenant, switch-tenant cấp family mới. Khi tenant hiệu lực là
   * một trung tâm ở kho riêng, access token còn mang claim `centre_id`
   * (định danh đăng ký của trung tâm — issue #582) để
   * `SpaceContextGuard` đối chiếu phiên với trung tâm tại địa chỉ
   * request ở mọi request sau đó.
   *
   * Đường kho riêng (issue #584): request đang ở địa chỉ kho riêng
   * thì `tid` KHÔNG phân giải từ kho chung nữa — nó là id của dòng
   * tenant trong CHÍNH kho của trung tâm (tra bằng slug của địa
   * chỉ), và `centre_id` là định danh đăng ký của trung tâm đó.
   * Kho riêng chưa có dòng tenant của chính nó là trạng thái chưa
   * cấp phát xong: từ chối cấp token thay vì cấp token mang tenant
   * sai (tenant-zero chung) rồi để guard chặn sau.
   */
  private async issueTokens(user: UserRow, client?: SessionClientInfo, tenantId?: string): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30;
    const space = await this.requestDedicatedSpace();
    let tid: string;
    let centreId: string | undefined;
    if (space) {
      const spaceTenant = await this.tenants.getTenantInSpace(space.slug);
      if (!spaceTenant) {
        throw new UnauthorizedException({ message: 'Space tenant is not ready in its own store', code: 'space.tenant_missing' });
      }
      tid = spaceTenant.id;
      centreId = space.spaceId;
    } else {
      tid = tenantId ?? (await this.tenants.resolveDefaultTenant(user.id)).id;
      centreId = await this.centreClaimForTenant(tid);
    }
    await this.repo.createFamily({
      familyId, userId: user.id, currentTokenHash: hashToken(refreshToken),
      ip: client?.ip ?? null, userAgent: client?.userAgent ?? null,
      tenantId: tid,
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    });
    const accessTtl = this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS') ?? 900;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, sid: familyId, tid, ...(centreId ? { centre_id: centreId } : {}) },
      { expiresIn: accessTtl },
    );
    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  /**
   * Định danh đăng ký của trung tâm cho claim `centre_id` của access
   * token sắp cấp cho một phiên thuộc tenant `tenantId` (issue #582):
   * chỉ phiên của trung tâm ở KHO RIÊNG mới mang claim — định danh là
   * khoá chính của dòng đăng ký trong sổ control plane, lấy qua bộ
   * phân giải của khung định tuyến từ slug của tenant (slug của
   * tenant và slug đăng ký của trung tâm là một, xem SeedService).
   * Tenant ở kho chung, tenant chưa có dòng đăng ký, hoặc tầng định
   * tuyến chưa cấu hình/không đọc được lúc cấp token → không mang
   * claim: việc cấp token không bao giờ được hỏng vì tầng định tuyến,
   * và phiên thiếu claim vẫn bị `SpaceContextGuard` đối chiếu bằng
   * slug của tenant hiệu lực ở địa chỉ kho riêng, nên thiếu claim
   * không nới lỏng được việc gắn phiên vào trung tâm.
   */
  private async centreClaimForTenant(tenantId: string): Promise<string | undefined> {
    try {
      const tenant = await tenantAls.run({ platform: true }, () => this.tenants.getTenant(tenantId));
      const target = await this.spaceDb.resolveTarget(tenant.slug);
      return target.mode === 'dedicated' ? target.spaceId : undefined;
    } catch {
      return undefined;
    }
  }

  /** Xoay vòng: token được trình ra phải là token hiện tại của family. Trình ra token trước đó (đã bị xoay vòng) = dùng lại ⇒ thu hồi family. */
  /**
   * Xoay refresh token: token cũ chỉ dùng được một lần; tái sử dụng → thu hồi family (auth.token_reuse).
   */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = hashToken(refreshToken);
    const family = await this.repo.getFamilyByHash(tokenHash);
    if (!family || family.revoked || family.expiresAt < new Date()) {
      throw new UnauthorizedException({ message: 'Refresh token is invalid or expired', code: 'auth.refresh_invalid' });
    }
    if (family.previousTokenHash === tokenHash) {
      await this.repo.revokeFamily(family.id);
      throw new UnauthorizedException({ message: 'Refresh token reuse detected; token family revoked', code: 'auth.refresh_reuse_detected' });
    }
    if (family.currentTokenHash !== tokenHash) {
      throw new UnauthorizedException({ message: 'Refresh token is invalid', code: 'auth.refresh_invalid' });
    }
    const user = await this.users.getUser(family.userId);
    if (user.deleted || user.suspended) {
      await this.repo.revokeFamily(family.id);
      throw new UnauthorizedException({ message: 'Account is not active', code: 'auth.account_inactive' });
    }
    // Đường kho riêng (issue #584): family của phiên kho riêng sống
    // trong chính kho đó, nên refresh tại địa chỉ kho riêng phân
    // giải lại tenant từ kho riêng (dòng tenant mang slug của địa
    // chỉ) thay vì kiểm lại bằng kho chung — kiểm bằng kho chung
    // sẽ kết luận tenant không tồn tại rồi ghi đè family về
    // tenant-zero chung. Family chỉ tra được ở kho của nó nên
    // refresh ở địa chỉ khác vốn đã 401 từ bước tra family.
    //
    // Các chốt fail-closed của đường kho riêng chạy TRƯỚC khi xoay
    // family: kho riêng chưa có dòng tenant của chính nó thì từ
    // chối `space.tenant_missing` — cùng kết luận với `issueTokens`
    // khi cấp phiên mới; rơi về phân giải kho chung tại đây sẽ cấp
    // token mang tenant của kho khác. Tenant trong kho đã bị đình
    // chỉ, hoặc membership của user trong kho đã kết thúc, cũng bị
    // từ chối thay vì gia hạn một phiên lẽ ra đã chết. Lần từ chối
    // ở bước này không xoay và không thu hồi family: trạng thái
    // được khôi phục (tenant được kích hoạt lại, membership được
    // gắn lại) thì phiên làm mới lại được bằng chính token cũ.
    const space = await this.requestDedicatedSpace();
    const spaceTenant = space ? await this.tenants.getTenantInSpace(space.slug) : undefined;
    if (space) {
      if (!spaceTenant) {
        throw new UnauthorizedException({ message: 'Space tenant is not ready in its own store', code: 'space.tenant_missing' });
      }
      if (spaceTenant.status !== 'active') {
        throw new UnauthorizedException({ message: `Tenant ${spaceTenant.slug} is ${spaceTenant.status}`, code: 'tenant.not_active' });
      }
      // Tenant kiểu platform là không gian công cộng — mọi tài
      // khoản đã đăng nhập đều thuộc về nó, theo đúng quy định của
      // `resolveSwitchTarget` — nên không gác bằng membership;
      // tenant trung tâm/trường học thì membership còn hiệu lực
      // trong kho là điều kiện giữ phiên.
      if (spaceTenant.kind !== 'platform') {
        const membership = await this.tenants.getMembershipInSpace(space.slug, spaceTenant.id, user.id);
        if (!membership || membership.status !== 'active') {
          throw new UnauthorizedException({ message: 'User is not an active member of this tenant', code: 'tenant.not_member' });
        }
      }
    }
    const newRefresh = randomBytes(48).toString('base64url');
    await this.repo.rotateFamily(family.id, hashToken(newRefresh), family.currentTokenHash);
    let tid: string | undefined;
    let centreId: string | undefined;
    if (space && spaceTenant) {
      tid = spaceTenant.id;
      centreId = space.spaceId;
      if (tid !== family.tenantId) await this.repo.setFamilyTenant(family.id, tid);
    } else {
      // Giữ `tid` của family; tenant đã khoá hoặc membership đã kết thúc
      // thì phân giải lại tenant mặc định thay vì cấp token vào ngõ cụt.
      tid = family.tenantId ?? undefined;
      if (tid) {
        try {
          await this.tenants.resolveSwitchTarget(user.id, tid);
        } catch {
          tid = undefined;
        }
      }
      if (!tid) {
        tid = (await this.tenants.resolveDefaultTenant(user.id)).id;
        if (tid !== family.tenantId) await this.repo.setFamilyTenant(family.id, tid);
      }
      centreId = await this.centreClaimForTenant(tid);
    }
    const accessTtl = this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS') ?? 900;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, sid: family.familyId, tid, ...(centreId ? { centre_id: centreId } : {}) },
      { expiresIn: accessTtl },
    );
    return { accessToken, refreshToken: newRefresh, expiresIn: accessTtl };
  }

  /**
   * Danh sách tenant của chính user (cho bộ chọn tenant) — membership
   * active, tenant đang active, kèm cờ tenant hiệu lực của phiên.
   */
  async myTenants(user: UserRow, currentTenantId?: string) {
    return this.tenants.listMyTenants(user.id, currentTenantId);
  }

  /**
   * Chuyển tenant trong phiên (TENANT-0, #168): kiểm chứng đích qua
   * TenantsService (tenant active + membership active), thu hồi family
   * hiện tại và cấp cặp token mới mang `tid` của tenant đích — vai trò
   * ở mỗi tenant độc lập vì evaluator luôn tính theo cây của tenant
   * hiệu lực, không mang vai từ tenant này sang tenant khác.
   */
  async switchTenant(user: UserRow, tenantId: string, currentFamilyId?: string, client?: SessionClientInfo): Promise<TokenPair> {
    // Đường kho riêng (issue #584): phiên của trung tâm ở kho riêng
    // không có khái niệm chuyển tenant — tài khoản của trung tâm đó
    // không tồn tại ở trung tâm khác nên không có đích chuyển hợp lệ.
    // Chặn tại service (không chỉ tại controller) vì mọi đường vào
    // switch đều phải qua đây.
    if (await this.requestDedicatedSpace()) {
      throw new ForbiddenException({
        message: 'Tenant switching does not apply to dedicated-store centres',
        code: 'auth.switch_tenant_not_in_space',
      });
    }
    const target = await this.tenants.resolveSwitchTarget(user.id, tenantId);
    if (currentFamilyId) {
      const family = await this.repo.getFamilyById(currentFamilyId);
      if (family && !family.revoked && family.userId === user.id) {
        await this.repo.revokeFamily(family.id);
      }
    }
    const tokens = await this.issueTokens(user, client, target.id);
    await this.recordAuthEvent('user_logged_in', {
      userId: user.id,
      actorId: user.id,
      method: 'switch-tenant',
      tenantId: target.id,
      ip: client?.ip ?? null,
    });
    return tokens;
  }

  /**
   * Đăng xuất: thu hồi family của refresh token hiện tại.
   */
  async logout(refreshToken: string): Promise<void> {
    const family = await this.repo.getFamilyByHash(hashToken(refreshToken));
    if (family) {
      await this.repo.revokeFamily(family.id);
      await this.recordAuthEvent('user_logged_out', { userId: family.userId, actorId: family.userId, method: 'token' });
    }
  }

  /** Đổi mật khẩu phải tuân thủ chính sách; việc xoá forcePasswordChange là một phần của luồng đăng nhập lần đầu. */
  /**
   * Đổi mật khẩu: kiểm mật khẩu cũ + chính sách, sau đó thu hồi mọi phiên khác.
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.users.getUser(userId);
    if (!(await this.users.verifyPassword(user, currentPassword))) {
      throw new UnauthorizedException({ message: 'Current password is incorrect', code: 'auth.invalid_credentials' });
    }
    const errors = this.passwords.validatePolicy(newPassword);
    if (errors.length) throw new BadRequestException({ message: errors.join('; '), code: 'user.password_policy' });
    await this.users.updateUser(userId, { password: newPassword });
    await this.repo.revokeAllForUser(userId);
  }

  /**
   * "Đăng nhập với tư cách" (Moodle): một admin nắm quyền user:loginas sẽ hành động thay một
   * người dùng khác. Phiên ghi lại ai đã đăng nhập thay ai; các assignment role của
   * admin KHÔNG được mang theo — việc đánh giá luôn dùng danh tính của người dùng đích.
   */
  /**
   * Đăng nhập thay (login-as) cho quản trị/giáo viên có capability; phiên mang dấu vết người mạo danh.
   *
   * TENANT-1 (#196, điểm N2): đây là đường DUY NHẤT để platform vào
   * danh tính trong một tenant — lý do (`reason`) là bắt buộc (thiếu/
   * rỗng → 400 `auth.loginas_reason_required`) và mỗi lần mượn danh ghi
   * một sự kiện audit riêng `user_loginas` vào outbox (được relay soi
   * vào event_log kèm tenant_id): ai mượn, mượn ai, vào tenant nào, lý
   * do, IP/UA, thời gian. Phiên cấp cho danh tính đích mang tenant mặc
   * định của chính user đích — quyền trong tenant đến từ gán vai thật
   * của user đích, không mang theo quyền của người mượn.
   */
  async loginAs(adminId: string, targetUserId: string, reason: string, client?: SessionClientInfo): Promise<LoginAsOutcome> {
    const trimmedReason = reason?.trim() ?? '';
    if (!trimmedReason) {
      throw new BadRequestException({
        message: 'Login-as requires a reason (platform access into a tenant is audited)',
        code: 'auth.loginas_reason_required',
      });
    }
    const system = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(adminId, 'user:loginas', system.id);
    const target = await this.users.getUser(targetUserId);
    if (target.deleted || target.suspended) throw new ForbiddenException({ message: 'Target account is not active', code: 'auth.account_inactive' });
    if (await this.evaluator.isSiteAdmin(target.id)) throw new ForbiddenException({ message: 'Cannot log in as a site administrator', code: 'auth.loginas_admin_denied' });
    const tenant = await this.tenants.resolveDefaultTenant(target.id);
    // Chặng 2.6/2.7 (issue #7): ở chặng bake, phiên mượn danh là PHIÊN
    // LẬP TRÌNH của Better Auth (createProgrammaticSession) — danh tính
    // đích được guard cookie nhận diện như mọi phiên BA khác, thu hồi
    // được bằng cơ chế phiên của BA. Ở chặng off vẫn cấp cặp token JWT
    // như cũ. Cả hai chặng dùng chung cổng kiểm tra + audit ở trên/dưới.
    const baSession = this.betterAuth.cutoverStage === 'bake'
      ? await this.credentialBridge.createProgrammaticSession(target.id)
      : null;
    const tokens = baSession ? null : await this.issueTokens(target, client);
    await this.recordAuthEvent('user_logged_in', { userId: target.id, actorId: adminId, relatedUserId: target.id, method: 'login-as', ip: client?.ip ?? null });
    await this.outbox
      .enqueueStandalone({
        aggregate: 'auth',
        type: 'user_loginas',
        tenantId: tenant.id,
        payload: {
          actorId: adminId,
          targetUserId: target.id,
          targetUsername: target.username,
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          reason: trimmedReason,
          ip: client?.ip ?? null,
          userAgent: client?.userAgent ?? null,
          at: new Date().toISOString(),
        },
      })
      .catch((err) => this.logger.warn(`login-as audit not recorded: ${String(err)}`));
    if (baSession) {
      return {
        mode: 'better-auth',
        user: target,
        tenantId: tenant.id,
        baSession: { signedCookieValue: baSession.signedCookieValue, expiresAt: baSession.expiresAt },
      };
    }
    return { mode: 'legacy', user: target, tokens: tokens as TokenPair, tenantId: tenant.id };
  }

  // --- phiên web -----------------------------------------------------------
  /**
   * Đăng nhập kiểu session-cookie: bước mật khẩu dùng chung
   * `validateCredentials`; user đã bật MFA thì dừng ở challenge của
   * luồng session (bản sửa lỗ hổng cũ — route này từng đi thẳng qua MFA),
   * phiên chỉ được tạo sau khi POST /auth/session/mfa/verify qua được.
   *
   * Gắn không gian (issue #584): phiên cookie ghi lại slug kho riêng
   * của địa chỉ đã đăng nhập (vắng khi đăng nhập ở địa chỉ gốc) để
   * `sessionUser` từ chối phiên bị mang sang địa chỉ khác.
   */
  async sessionLogin(username: string, password: string, oldSessionId?: string, ip?: string, userAgent?: string): Promise<SessionLoginOutcome> {
    const user = await this.validateCredentials(username, password, ip);
    if (await this.totp.isEnabled(user.id)) {
      const challengeToken = await this.signMfaChallenge(user, 'session');
      return { mfaRequired: true, user, challengeToken };
    }
    await this.users.recordLogin(user.id);
    const sessionId = await this.sessions.rotate(oldSessionId, { userId: user.id, username: user.username, ip, userAgent, spaceSlug: tenantAls.getStore()?.spaceSlug });
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'session', ip: ip ?? null });
    return { mfaRequired: false, sessionId, user };
  }
  /**
   * Bước hai của đăng nhập phiên cookie: qua thử thách MFA (dùng chung
   * lõi với luồng token) mới ghi nhận đăng nhập và tạo phiên — phiên
   * được xoay từ id cũ như đăng nhập trực tiếp để chống fixation.
   * Phiên mới cũng gắn không gian như `sessionLogin`.
   */
  async verifyMfaSession(challengeToken: string, code: string, oldSessionId?: string, ip?: string, userAgent?: string): Promise<{ sessionId: string; user: UserRow }> {
    const user = await this.passMfaChallenge(challengeToken, code, ip, 'session');
    await this.users.recordLogin(user.id);
    const sessionId = await this.sessions.rotate(oldSessionId, { userId: user.id, username: user.username, ip, userAgent, spaceSlug: tenantAls.getStore()?.spaceSlug });
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'session-totp', ip: ip ?? null });
    return { sessionId, user };
  }
  /**
   * User của session hiện tại; null nếu session không hợp lệ.
   *
   * Gắn không gian (issue #584): phiên đã ghi slug kho riêng thì
   * request phải đang ở đúng địa chỉ của kho đó — phiên của trung
   * tâm A bị mang sang địa chỉ trung tâm B hoặc sang địa chỉ gốc
   * thì bị huỷ ngay và trả 401 `auth.session_space_mismatch`.
   * Phiên cũ không ghi slug (đăng nhập ở địa chỉ gốc, trước issue
   * này) giữ hành vi cũ: tra tài khoản trong kho của địa chỉ hiện
   * tại, vắng mặt thì chết ở bước tra tài khoản như trước.
   */
  async sessionUser(sessionId: string | undefined): Promise<UserRow> {
    if (!sessionId) throw new UnauthorizedException({ message: 'No session', code: 'auth.unauthenticated' });
    const session = await this.sessions.get(sessionId);
    if (!session) throw new UnauthorizedException({ message: 'Session expired', code: 'auth.session_expired' });
    if (session.spaceSlug !== undefined && session.spaceSlug !== tenantAls.getStore()?.spaceSlug) {
      await this.sessions.destroy(sessionId);
      throw new UnauthorizedException({ message: 'Session belongs to another space', code: 'auth.session_space_mismatch' });
    }
    const user = await this.users.getByIdOrUndefined(session.userId);
    if (!user || user.deleted || user.suspended) {
      await this.sessions.destroy(sessionId);
      throw new UnauthorizedException({ message: 'Account is not active; session invalidated', code: 'auth.account_inactive' });
    }
    await this.sessions.touch(sessionId);
    return user;
  }
  /**
   * Huỷ session hiện tại.
   */
  async sessionLogout(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const session = await this.sessions.get(sessionId);
    await this.sessions.destroy(sessionId);
    if (session) {
      await this.recordAuthEvent('user_logged_out', { userId: session.userId, actorId: session.userId, method: 'session' });
    }
  }

  // --- phiên của tôi (report_usersessions) --------------------------------------
  /**
   * Mọi phiên đang hoạt động của chính user: phiên web (bản ghi trong kho
   * phiên) gộp với phiên API (họ refresh token đang hiệu lực), đánh dấu
   * phiên hiện tại theo ngữ cảnh của người gọi — `currentFamilyId` là
   * `sid` trong access token, `currentWebSessionId` là id trong cookie.
   * Sắp xếp theo hoạt động gần nhất lên đầu như bảng của Moodle.
   */
  async listMySessions(userId: string, current: CurrentSessionRefs = {}): Promise<MySessionView[]> {
    const web = await this.sessions.listForUser(userId);
    const families = await this.repo.listActiveFamiliesByUser(userId);
    const views: MySessionView[] = [
      ...web.map(({ id, session }): MySessionView => ({
        id, kind: 'web',
        createdAt: session.createdAt, lastActivityAt: session.lastActivityAt,
        ip: session.ip ?? null, userAgent: session.userAgent ?? null,
        current: current.webSessionId !== undefined && id === current.webSessionId,
      })),
      ...families.map((family): MySessionView => ({
        id: family.familyId, kind: 'api',
        createdAt: family.createdAt.toISOString(), lastActivityAt: family.rotatedAt.toISOString(),
        ip: family.ip ?? null, userAgent: family.userAgent ?? null,
        current: current.familyId !== undefined && family.familyId === current.familyId,
      })),
    ];
    return views.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }
  /**
   * Thu hồi MỘT phiên khác của chính user (phiên web bị huỷ, phiên API bị
   * thu hồi cả family). Thu hồi chính phiên hiện tại bị từ chối — muốn
   * kết thúc phiên hiện tại phải dùng đăng xuất; phiên không tồn tại
   * hoặc thuộc user khác đều trả về không tìm thấy như nhau để không lộ
   * thông tin phiên của người khác.
   */
  async revokeMySession(userId: string, sessionId: string, current: CurrentSessionRefs = {}): Promise<{ revoked: number }> {
    if (sessionId === current.webSessionId || sessionId === current.familyId) {
      throw new BadRequestException({ message: 'The current session cannot be revoked here; use logout instead', code: 'auth.cannot_revoke_current_session' });
    }
    const web = await this.sessions.get(sessionId);
    if (web) {
      if (web.userId !== userId) throw new NotFoundException({ message: 'Session not found', code: 'auth.session_not_found' });
      await this.sessions.destroy(sessionId);
      return { revoked: 1 };
    }
    const family = await this.repo.getFamilyByFamilyId(sessionId);
    if (!family || family.userId !== userId || family.revoked) {
      throw new NotFoundException({ message: 'Session not found', code: 'auth.session_not_found' });
    }
    await this.repo.revokeFamily(family.id);
    return { revoked: 1 };
  }
  /**
   * Thu hồi MỌI phiên khác, giữ lại phiên hiện tại của người gọi (cả hai
   * loại phiên); trả tổng số phiên đã thu hồi.
   */
  async revokeMyOtherSessions(userId: string, current: CurrentSessionRefs = {}): Promise<{ revoked: number }> {
    const webRevoked = await this.sessions.destroyOthersForUser(userId, current.webSessionId);
    const apiRevoked = await this.repo.revokeOthersForUser(userId, current.familyId);
    return { revoked: webRevoked + apiRevoked };
  }
}
