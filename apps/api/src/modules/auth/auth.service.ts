import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { OutboxService } from '../../infra/events/outbox.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';
import { AuthRepository } from './auth.repository';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

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
 * AuthModule facade (report §3.7). Authentication is NOT enrolment and NOT a
 * role assignment: a successful login only proves identity; what the user may
 * do is decided by PermissionEvaluator, and course access by Enrol.
 * Refresh tokens are opaque, stored hashed, grouped in families, rotated on
 * every use; replaying a rotated-out token revokes the whole family.
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

  // --- lockout (authlib_test::test_lockout semantics) -----------------------
  /**
   * Username có đang bị khoá tạm thời do quá nhiều lần thất bại hay không.
   */
  async isLockedOut(userId: string): Promise<boolean> {
    const threshold = this.config.get<number>('LOCKOUT_THRESHOLD') ?? 5;
    if (threshold <= 0) return false; // lockout disabled when threshold is 0 (Moodle behaviour)
    const windowMin = this.config.get<number>('LOCKOUT_WINDOW_MINUTES') ?? 20;
    const durationMin = this.config.get<number>('LOCKOUT_DURATION_MINUTES') ?? 30;
    const since = new Date(Date.now() - windowMin * 60_000);
    const failures = await this.repo.recentFailedAttempts(userId, since);
    if (failures.length < threshold) return false;
    const lastSuccess = await this.repo.lastSuccessfulAttemptAt(userId);
    const relevant = lastSuccess ? failures.filter((f) => f.attemptedAt > lastSuccess) : failures;
    if (relevant.length < threshold) return false;
    const thresholdHitAt = relevant[threshold - 1]!.attemptedAt.getTime();
    return Date.now() < thresholdHitAt + durationMin * 60_000;
  }

  /**
   * Kiểm tra username/mật khẩu và trạng thái tài khoản; trả user khi hợp lệ.
   */
  async validateCredentials(username: string, password: string, ip?: string): Promise<UserRow> {
    const user = await this.users.getByUsername(username);
    if (!user || user.deleted) {
      throw new UnauthorizedException({ message: 'Invalid username or password', code: 'auth.invalid_credentials' });
    }
    if (await this.isLockedOut(user.id)) {
      throw new UnauthorizedException({ message: 'Account is locked out due to failed login attempts', code: 'auth.locked_out' });
    }
    const ok = await this.users.verifyPassword(user, password);
    await this.repo.recordAttempt({ userId: user.id, username: user.username, success: ok, ip });
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
   * (tạo phiên cookie) — challenge của luồng này không dùng chéo sang
   * luồng kia được.
   */
  private async signMfaChallenge(user: UserRow, flow: 'token' | 'session'): Promise<string> {
    const ttl = this.config.get<number>('MFA_CHALLENGE_TTL_SECONDS') ?? 300;
    return this.jwt.signAsync(
      { sub: user.id, username: user.username, scope: 'mfa_challenge', flow },
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
   * Khởi tạo MFA TOTP cho chính user (chỉ trả secret ở bước này).
   */
  async setupTotp(user: UserRow): Promise<{ secret: string; otpauthUrl: string }> {
    return this.totp.setup(user.id, user.username);
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

  /**
   * Lõi dùng chung của bước hai MFA cho cả hai luồng hoàn tất: kiểm
   * challenge token (chữ ký, hạn, scope và đúng `flow` đích), trạng thái
   * tài khoản, lockout, rồi kiểm mã TOTP. Mã sai bị ghi như một lần đăng
   * nhập thất bại nên dùng chung cơ chế lockout sẵn có. Trả user đã qua
   * thử thách; việc ghi nhận đăng nhập + cấp phiên/token thuộc về từng
   * luồng hoàn tất phía trên.
   */
  private async passMfaChallenge(challengeToken: string, code: string, ip: string | undefined, flow: 'token' | 'session'): Promise<UserRow> {
    let payload: { sub?: string; scope?: string; flow?: string };
    try {
      payload = await this.jwt.verifyAsync<{ sub?: string; scope?: string; flow?: string }>(challengeToken);
    } catch {
      throw new UnauthorizedException({ message: 'MFA challenge is invalid or expired', code: 'auth.mfa_challenge_invalid' });
    }
    // Challenge ký trước khi có claim `flow` được hiểu là của luồng token.
    const challengeFlow = payload.flow ?? 'token';
    if (payload.scope !== 'mfa_challenge' || !payload.sub || challengeFlow !== flow) {
      throw new UnauthorizedException({ message: 'MFA challenge is invalid or expired', code: 'auth.mfa_challenge_invalid' });
    }
    const user = await this.users.getByIdOrUndefined(payload.sub);
    if (!user || user.deleted || user.suspended) {
      throw new UnauthorizedException({ message: 'Account is not active', code: 'auth.account_inactive' });
    }
    if (await this.isLockedOut(user.id)) {
      throw new UnauthorizedException({ message: 'Account is locked out due to failed login attempts', code: 'auth.locked_out' });
    }
    const ok = await this.totp.verifyForUser(user.id, code);
    await this.repo.recordAttempt({ userId: user.id, username: user.username, success: ok, ip });
    if (!ok) {
      throw new UnauthorizedException({ message: 'Invalid two-factor authentication code', code: 'auth.mfa_invalid_code' });
    }
    return user;
  }

  /** Issue a fresh refresh-token family + access token (used after the local strategy validated credentials). */
  /**
   * Phát hành access token (JWT) + refresh token mới trong một family.
   */
  async issueTokensFor(user: UserRow, client?: SessionClientInfo): Promise<TokenPair> { return this.issueTokens(user, client); }

  private async issueTokens(user: UserRow, client?: SessionClientInfo): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30;
    await this.repo.createFamily({
      familyId, userId: user.id, currentTokenHash: hashToken(refreshToken),
      ip: client?.ip ?? null, userAgent: client?.userAgent ?? null,
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    });
    const accessTtl = this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS') ?? 900;
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, username: user.username, sid: familyId },
      { expiresIn: accessTtl },
    );
    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  /** Rotation: the presented token must be the family's current token. Presenting the previous (rotated-out) token = reuse ⇒ revoke family. */
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
    const newRefresh = randomBytes(48).toString('base64url');
    await this.repo.rotateFamily(family.id, hashToken(newRefresh), family.currentTokenHash);
    const accessTtl = this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS') ?? 900;
    const accessToken = await this.jwt.signAsync({ sub: user.id, username: user.username, sid: family.familyId }, { expiresIn: accessTtl });
    return { accessToken, refreshToken: newRefresh, expiresIn: accessTtl };
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

  /** Password change honours the policy; clearing forcePasswordChange is part of the first-login flow. */
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
   * "Login as" (Moodle): an admin holding moodle/user:loginas acts as another
   * user. The session records who logged in as whom; role assignments of the
   * admin are NOT carried over — evaluation always uses the target identity.
   */
  /**
   * Đăng nhập thay (login-as) cho quản trị/giáo viên có capability; phiên mang dấu vết người mạo danh.
   */
  async loginAs(adminId: string, targetUserId: string, client?: SessionClientInfo): Promise<{ user: UserRow; tokens: TokenPair }> {
    const system = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(adminId, 'moodle/user:loginas', system.id);
    const target = await this.users.getUser(targetUserId);
    if (target.deleted || target.suspended) throw new ForbiddenException({ message: 'Target account is not active', code: 'auth.account_inactive' });
    if (await this.evaluator.isSiteAdmin(target.id)) throw new ForbiddenException({ message: 'Cannot log in as a site administrator', code: 'auth.loginas_admin_denied' });
    const tokens = await this.issueTokens(target, client);
    await this.recordAuthEvent('user_logged_in', { userId: target.id, actorId: adminId, relatedUserId: target.id, method: 'login-as', ip: client?.ip ?? null });
    return { user: target, tokens };
  }

  // --- web sessions -----------------------------------------------------------
  /**
   * Đăng nhập kiểu session-cookie: bước mật khẩu dùng chung
   * `validateCredentials`; user đã bật MFA thì dừng ở challenge của
   * luồng session (bản sửa lỗ hổng cũ — route này từng đi thẳng qua MFA),
   * phiên chỉ được tạo sau khi POST /auth/session/mfa/verify qua được.
   */
  async sessionLogin(username: string, password: string, oldSessionId?: string, ip?: string, userAgent?: string): Promise<SessionLoginOutcome> {
    const user = await this.validateCredentials(username, password, ip);
    if (await this.totp.isEnabled(user.id)) {
      const challengeToken = await this.signMfaChallenge(user, 'session');
      return { mfaRequired: true, user, challengeToken };
    }
    await this.users.recordLogin(user.id);
    const sessionId = await this.sessions.rotate(oldSessionId, { userId: user.id, username: user.username, ip, userAgent });
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'session', ip: ip ?? null });
    return { mfaRequired: false, sessionId, user };
  }
  /**
   * Bước hai của đăng nhập phiên cookie: qua thử thách MFA (dùng chung
   * lõi với luồng token) mới ghi nhận đăng nhập và tạo phiên — phiên
   * được xoay từ id cũ như đăng nhập trực tiếp để chống fixation.
   */
  async verifyMfaSession(challengeToken: string, code: string, oldSessionId?: string, ip?: string, userAgent?: string): Promise<{ sessionId: string; user: UserRow }> {
    const user = await this.passMfaChallenge(challengeToken, code, ip, 'session');
    await this.users.recordLogin(user.id);
    const sessionId = await this.sessions.rotate(oldSessionId, { userId: user.id, username: user.username, ip, userAgent });
    await this.recordAuthEvent('user_logged_in', { userId: user.id, actorId: user.id, method: 'session-totp', ip: ip ?? null });
    return { sessionId, user };
  }
  /**
   * User của session hiện tại; null nếu session không hợp lệ.
   */
  async sessionUser(sessionId: string | undefined): Promise<UserRow> {
    if (!sessionId) throw new UnauthorizedException({ message: 'No session', code: 'auth.unauthenticated' });
    const session = await this.sessions.get(sessionId);
    if (!session) throw new UnauthorizedException({ message: 'Session expired', code: 'auth.session_expired' });
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

  // --- my sessions (report_usersessions) --------------------------------------
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
