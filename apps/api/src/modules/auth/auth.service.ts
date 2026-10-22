import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ContextsService } from '../access/contexts.service';
import { PasswordService } from '../users/password.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';
import { AuthRepository } from './auth.repository';
import { SessionService } from './session.service';

export interface TokenPair { accessToken: string; refreshToken: string; expiresIn: number }

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
  ) {}

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
    await this.repo.recordAttempt({ userid: user.id, username: user.username, success: ok, ip });
    if (!ok) throw new UnauthorizedException({ message: 'Invalid username or password', code: 'auth.invalid_credentials' });
    if (user.suspended) throw new ForbiddenException({ message: 'Account is suspended', code: 'auth.account_suspended' });
    if (user.isGuest) throw new ForbiddenException({ message: 'The guest account cannot log in with a password', code: 'auth.guest_login_denied' });
    return user;
  }

  /**
   * Đăng nhập bằng mật khẩu: kiểm lockout, ghi attempt, phát hành cặp token.
   */
  async login(username: string, password: string, ip?: string): Promise<{ user: UserRow; tokens: TokenPair }> {
    const user = await this.validateCredentials(username, password, ip);
    await this.users.recordLogin(user.id);
    const tokens = await this.issueTokens(user);
    return { user, tokens };
  }

  /** Issue a fresh refresh-token family + access token (used after the local strategy validated credentials). */
  /**
   * Phát hành access token (JWT) + refresh token mới trong một family.
   */
  async issueTokensFor(user: UserRow): Promise<TokenPair> { return this.issueTokens(user); }

  private async issueTokens(user: UserRow): Promise<TokenPair> {
    const familyId = randomUUID();
    const refreshToken = randomBytes(48).toString('base64url');
    const ttlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS') ?? 30;
    await this.repo.createFamily({
      familyId, userid: user.id, currentTokenHash: hashToken(refreshToken),
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
    const user = await this.users.getUser(family.userid);
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
    if (family) await this.repo.revokeFamily(family.id);
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
  async loginAs(adminId: string, targetUserId: string): Promise<{ user: UserRow; tokens: TokenPair }> {
    const system = await this.contexts.ensureSystemContext();
    await this.evaluator.requireCapability(adminId, 'moodle/user:loginas', system.id);
    const target = await this.users.getUser(targetUserId);
    if (target.deleted || target.suspended) throw new ForbiddenException({ message: 'Target account is not active', code: 'auth.account_inactive' });
    if (await this.evaluator.isSiteAdmin(target.id)) throw new ForbiddenException({ message: 'Cannot log in as a site administrator', code: 'auth.loginas_admin_denied' });
    const tokens = await this.issueTokens(target);
    return { user: target, tokens };
  }

  // --- web sessions -----------------------------------------------------------
  /**
   * Đăng nhập kiểu session-cookie cho các luồng cần cookie (tương đương token login nhưng đặt cookie).
   */
  async sessionLogin(username: string, password: string, oldSessionId?: string, ip?: string): Promise<{ sessionId: string; user: UserRow }> {
    const user = await this.validateCredentials(username, password, ip);
    await this.users.recordLogin(user.id);
    const sessionId = await this.sessions.rotate(oldSessionId, { userId: user.id, username: user.username });
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
    return user;
  }
  /**
   * Huỷ session hiện tại.
   */
  async sessionLogout(sessionId: string | undefined): Promise<void> { if (sessionId) await this.sessions.destroy(sessionId); }
}
