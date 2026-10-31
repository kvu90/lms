import { Body, Controller, Delete, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { clientIpOf } from '../../common/client-ip';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { UsersService } from '../users/users.service';
import { changePasswordSchema, loginAsSchema, loginSchema, mfaTotpCodeSchema, mfaTotpSetupSchema, mfaVerifySchema, refreshTokenSchema, type ChangePasswordDto, type LoginAsDto, type LoginDto, type MfaTotpCodeDto, type MfaTotpSetupDto, type MfaVerifyDto, type RefreshDto } from './dto/auth.dto';
import { AuthService, type PasswordLoginOutcome } from './auth.service';
import { BetterAuthService } from './better-auth/better-auth.service';


export const SESSION_COOKIE = 'lms_session';

function sessionCookieOf(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Dựng đáp ứng đăng nhập từ kết quả bước mật khẩu: chặn MFA thì chỉ trả challenge, không kèm token nào. */
function loginResponse(outcome: PasswordLoginOutcome) {
  const { user } = outcome;
  if (outcome.mfaRequired) {
    return { mfaRequired: true as const, challengeToken: outcome.challengeToken, user: { id: user.id, username: user.username } };
  }
  return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, ...outcome.tokens };
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
/**
 * API xác thực: /auth/login, refresh, logout, đổi mật khẩu, login-as, MFA TOTP và session.
 */
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly users: UsersService, private readonly betterAuth: BetterAuthService) {}

  @Public()
  @UseGuards(AuthGuard('local'))
  @Post('login')
  /**
   * POST /auth/token — đăng nhập, trả cặp access/refresh token.
   */
  async login(@Req() req: Request & { user: { id: string; username: string } }, @Body({ schema: loginSchema }) _dto: LoginDto) {
    const user = await this.users.getUser(req.user.id);
    // validateCredentials đã chạy bên trong local strategy; bước hoàn tất
    // dùng chung sẽ cấp một family token mới — hoặc một thử thách MFA.
    return loginResponse(await this.auth.completePasswordLogin(user, { ip: clientIpOf(req), userAgent: req.headers['user-agent'] }));
  }

  @Public()
  @Post('token')
  /**
   * POST /auth/login — đăng nhập qua chiến lược local (passport), trả cặp token.
   */
  async tokenLogin(@Body({ schema: loginSchema }) dto: LoginDto, @Req() req: Request) {
    return loginResponse(await this.auth.login(dto.username, dto.password, clientIpOf(req), req.headers['user-agent']));
  }

  // --- MFA TOTP (tool_mfa factor_totp) ---------------------------------------
  @Get('mfa/status')
  /**
   * GET /auth/mfa/status — trạng thái MFA TOTP của chính user (đã bật hay chưa) để giao diện hồ sơ hiển thị đúng; không lộ secret.
   */
  async mfaStatus(@CurrentUser() actor: AuthenticatedUser) {
    return { enabled: await this.auth.isMfaEnabled(actor.id) };
  }

  @Post('mfa/totp/setup')
  /**
   * POST /auth/mfa/totp/setup — khởi tạo secret TOTP chờ xác nhận; secret + otpauth URL chỉ trả ở bước này.
   * Thân là không bắt buộc; khi tài khoản đã có factor đang bật, thân
   * phải kèm `currentCode` (mã TOTP hiện tại) để tái xác thực trước
   * khi thay factor — thiếu/sai mã thì bị từ chối và factor cũ giữ
   * nguyên (cổng thực thi ở `TotpService.setup`).
   */
  async mfaTotpSetup(@Body({ schema: mfaTotpSetupSchema }) dto: MfaTotpSetupDto, @CurrentUser() actor: AuthenticatedUser) {
    const user = await this.users.getUser(actor.id);
    return this.auth.setupTotp(user, dto?.currentCode);
  }

  @Post('mfa/totp/confirm')
  /**
   * POST /auth/mfa/totp/confirm — mã đúng ⇒ kích hoạt MFA cho chính user.
   */
  async mfaTotpConfirm(@Body({ schema: mfaTotpCodeSchema }) dto: MfaTotpCodeDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.auth.confirmTotp(actor.id, dto.code);
    return { mfaEnabled: true };
  }

  @Post('mfa/totp/disable')
  /**
   * POST /auth/mfa/totp/disable — mã đúng ⇒ tắt MFA và xoá secret của chính user.
   */
  async mfaTotpDisable(@Body({ schema: mfaTotpCodeSchema }) dto: MfaTotpCodeDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.auth.disableTotp(actor.id, dto.code);
    return { mfaEnabled: false };
  }

  @Public()
  @Post('mfa/verify')
  /**
   * POST /auth/mfa/verify — bước hai của đăng nhập: challenge token + mã TOTP ⇒ cặp token như đăng nhập thường.
   */
  async mfaVerify(@Body({ schema: mfaVerifySchema }) dto: MfaVerifyDto, @Req() req: Request) {
    const { user, tokens } = await this.auth.verifyMfa(dto.challengeToken, dto.code, clientIpOf(req), req.headers['user-agent']);
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, ...tokens };
  }

  // --- đăng nhập quản trị platform (issue #584) ---------------------------
  /**
   * Bề mặt đăng nhập quản trị platform, TÁCH khỏi bề mặt đăng nhập
   * nghiệp vụ: chỉ tài khoản quản trị platform mới qua được; token
   * trả ra mang audience `platform`, CHỈ dùng được cho route vận
   * hành mang `@PlatformRoute()` (hiện là control plane) và không
   * gọi được API nghiệp vụ — ngược lại token nghiệp vụ cũng không
   * gọi được route vận hành. Bề mặt này sống ở địa chỉ gốc; đăng
   * nhập tại địa chỉ kho riêng tra tài khoản trong kho đó nên
   * quản trị platform ở kho chung không đăng nhập được tại đó.
   * User bật MFA thì dừng ở challenge của luồng platform.
   */
  @Public()
  @Post('platform/login')
  async platformLogin(@Body({ schema: loginSchema }) dto: LoginDto, @Req() req: Request) {
    const outcome = await this.auth.platformLogin(dto.username, dto.password, clientIpOf(req), req.headers['user-agent']);
    if (outcome.mfaRequired) {
      return { mfaRequired: true as const, challengeToken: outcome.challengeToken, user: { id: outcome.user.id, username: outcome.user.username } };
    }
    return { user: { id: outcome.user.id, username: outcome.user.username, forcePasswordChange: outcome.user.forcePasswordChange }, accessToken: outcome.accessToken, expiresIn: outcome.expiresIn };
  }

  /**
   * POST /auth/platform/mfa/verify — bước hai của đăng nhập
   * platform: challenge token của luồng platform + mã TOTP ⇒
   * access token platform (không có refresh token).
   */
  @Public()
  @Post('platform/mfa/verify')
  async platformMfaVerify(@Body({ schema: mfaVerifySchema }) dto: MfaVerifyDto, @Req() req: Request) {
    const { user, accessToken, expiresIn } = await this.auth.verifyPlatformMfa(dto.challengeToken, dto.code, clientIpOf(req), req.headers['user-agent']);
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, accessToken, expiresIn };
  }

  @Post('mfa/users/:userId/reset')
  @RequireCapability('user:update')
  /**
   * POST /auth/mfa/users/:userId/reset — quản trị gỡ MFA cho user bị mất authenticator (capability user:update).
   */
  async mfaReset(@Param('userId', { schema: uuidIdSchema }) userId: string) {
    await this.auth.resetTotp(userId);
    return { reset: true, userId: userId };
  }

  @Public()
  @Post('refresh')
  /**
   * POST /auth/refresh — xoay refresh token, trả cặp token mới.
   */
  async refresh(@Body({ schema: refreshTokenSchema }) dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }

  @Post('logout')
  /**
   * POST /auth/logout — thu hồi phiên token hiện tại.
   */
  async logout(@Body({ schema: refreshTokenSchema }) dto: RefreshDto) { await this.auth.logout(dto.refreshToken); return { loggedOut: true }; }

  @Get('tenants')
  /**
   * GET /auth/tenants — các tenant user là thành viên active (cho bộ chọn tenant), kèm cờ tenant hiệu lực.
   */
  async myTenants(@CurrentUser() actor: AuthenticatedUser) {
    const user = await this.users.getUser(actor.id);
    return this.auth.myTenants(user, actor.tenantId);
  }

  @Post('switch-tenant/:tenantId')
  /**
   * POST /auth/switch-tenant/:tenantId — chuyển tenant trong phiên: thu hồi family hiện tại, cấp cặp token mới mang claim `tid` của tenant đích.
   */
  async switchTenant(
    @Param('tenantId', { schema: uuidIdSchema }) tenantId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const user = await this.users.getUser(actor.id);
    const tokens = await this.auth.switchTenant(user, tenantId, actor.sessionId, { ip: clientIpOf(req), userAgent: req.headers['user-agent'] });
    return { user: { id: user.id, username: user.username }, tenantId, ...tokens };
  }

  @Post('change-password')
  /**
   * POST /auth/change-password — đổi mật khẩu của chính user.
   */
  async changePassword(@Body({ schema: changePasswordSchema }) dto: ChangePasswordDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.auth.changePassword(actor.id, dto.currentPassword, dto.newPassword);
    return { changed: true };
  }

  @Post('login-as')
  /**
   * POST /auth/login-as/:id — đăng nhập thay user khác (cần capability).
   *
   * Theo chặng cutover (GĐ2 chặng 2.6/2.7, issue #7): chặng off trả cặp
   * token JWT như cũ; chặng bake (AUTH_CUTOVER_STAGE=bake) đặt COOKIE
   * phiên Better Auth đã ký cho danh tính đích và đáp ứng không mang
   * token — client chuyển sang danh tính đích bằng chính cookie đó.
   */
  async loginAs(@Body({ schema: loginAsSchema }) dto: LoginAsDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.auth.loginAs(actor.id, dto.userId, dto.reason, { ip: clientIpOf(req), userAgent: req.headers['user-agent'] });
    const { user, tenantId } = outcome;
    if (outcome.mode === 'better-auth') {
      res.cookie(this.betterAuth.sessionCookieName, outcome.baSession.signedCookieValue, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: this.betterAuth.sessionCookieSecure,
        expires: outcome.baSession.expiresAt,
      });
      return {
        user: { id: user.id, username: user.username },
        session: { expiresAt: outcome.baSession.expiresAt.toISOString() },
        loginAs: { byUserId: actor.id, tenantId },
      };
    }
    return { user: { id: user.id, username: user.username }, ...outcome.tokens, loginAs: { byUserId: actor.id, tenantId } };
  }

  // --- Phiên web Redis (cookie chỉ mang id opaque không ký; bản ghi nằm phía server) ---
  @Public()
  @Post('session/login')
  /**
   * POST /auth/session/login — đăng nhập đặt cookie phiên. User đã bật
   * MFA thì KHÔNG đặt cookie nào: đáp ứng là challenge của luồng session,
   * phiên chỉ sinh sau POST /auth/session/mfa/verify (đúng nghĩa chặn của
   * tool_mfa — trước đây route này đi thẳng, bỏ qua MFA).
   */
  async sessionLogin(@Body({ schema: loginSchema }) dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.auth.sessionLogin(dto.username, dto.password, sessionCookieOf(req), clientIpOf(req), req.headers['user-agent']);
    if (outcome.mfaRequired) {
      return { mfaRequired: true as const, challengeToken: outcome.challengeToken, user: { id: outcome.user.id, username: outcome.user.username } };
    }
    res.cookie(SESSION_COOKIE, outcome.sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
    return { user: { id: outcome.user.id, username: outcome.user.username, forcePasswordChange: outcome.user.forcePasswordChange }, sessionId: outcome.sessionId };
  }
  @Public()
  @Post('session/mfa/verify')
  /**
   * POST /auth/session/mfa/verify — bước hai của đăng nhập phiên cookie:
   * challenge của luồng session + mã TOTP ⇒ tạo phiên và đặt cookie.
   */
  async sessionMfaVerify(@Body({ schema: mfaVerifySchema }) dto: MfaVerifyDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { sessionId, user } = await this.auth.verifyMfaSession(dto.challengeToken, dto.code, sessionCookieOf(req), clientIpOf(req), req.headers['user-agent']);
    res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, sessionId };
  }
  @Public()
  @Get('session/me')
  /**
   * GET /auth/session/me — user của phiên cookie hiện tại.
   */
  async sessionMe(@Req() req: Request) {
    const user = await this.auth.sessionUser(sessionCookieOf(req) ?? (req.headers['x-session-id'] as string | undefined));
    return this.users.getProfileView(user.id, user.id);
  }
  @Public()
  @Post('session/logout')
  /**
   * POST /auth/session/logout — huỷ phiên cookie.
   */
  async sessionLogout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.sessionLogout(sessionCookieOf(req) ?? (req.headers['x-session-id'] as string | undefined));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  }

  // --- Phiên của tôi (report_usersessions: điều hướng hồ sơ của tôi) -------------
  @Get('sessions')
  /**
   * GET /auth/sessions — mọi phiên đang hoạt động của chính người gọi
   * (phiên web + phiên API), phiên hiện tại được đánh dấu `current`:
   * theo `sid` của access token và theo cookie phiên nếu request có mang.
   */
  async mySessions(@CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    const sessions = await this.auth.listMySessions(actor.id, { familyId: actor.sessionId, webSessionId: sessionCookieOf(req) });
    return { sessions };
  }
  @Delete('sessions/others')
  /**
   * DELETE /auth/sessions/others — thu hồi mọi phiên khác, giữ phiên hiện tại của người gọi.
   */
  async revokeMyOtherSessions(@CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return this.auth.revokeMyOtherSessions(actor.id, { familyId: actor.sessionId, webSessionId: sessionCookieOf(req) });
  }
  @Delete('sessions/:sessionId')
  /**
   * DELETE /auth/sessions/:sessionId — thu hồi một phiên khác của chính
   * người gọi (`sessionId` là id trong danh sách GET /auth/sessions: id
   * phiên web hoặc family id của phiên API).
   */
  async revokeMySession(@Param('sessionId', { schema: uuidIdSchema }) sessionId: string, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return this.auth.revokeMySession(actor.id, sessionId, { familyId: actor.sessionId, webSessionId: sessionCookieOf(req) });
  }
}
