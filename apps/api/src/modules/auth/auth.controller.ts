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
import { changePasswordSchema, loginAsSchema, loginSchema, mfaTotpCodeSchema, mfaVerifySchema, refreshTokenSchema, type ChangePasswordDto, type LoginAsDto, type LoginDto, type MfaTotpCodeDto, type MfaVerifyDto, type RefreshDto } from './dto/auth.dto';
import { AuthService, type PasswordLoginOutcome } from './auth.service';


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
  constructor(private readonly auth: AuthService, private readonly users: UsersService) {}

  @Public()
  @UseGuards(AuthGuard('local'))
  @Post('login')
  /**
   * POST /auth/token — đăng nhập, trả cặp access/refresh token.
   */
  async login(@Req() req: Request & { user: { id: string; username: string } }, @Body({ schema: loginSchema }) _dto: LoginDto) {
    const user = await this.users.getUser(req.user.id);
    // validateCredentials already ran inside the local strategy; the shared
    // completion step issues a fresh token family — or an MFA challenge.
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
   */
  async mfaTotpSetup(@CurrentUser() actor: AuthenticatedUser) {
    const user = await this.users.getUser(actor.id);
    return this.auth.setupTotp(user);
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
   */
  async loginAs(@Body({ schema: loginAsSchema }) dto: LoginAsDto, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    const { user, tokens } = await this.auth.loginAs(actor.id, dto.userId, { ip: clientIpOf(req), userAgent: req.headers['user-agent'] });
    return { user: { id: user.id, username: user.username }, ...tokens, loginAs: { byUserId: actor.id } };
  }

  // --- Redis web sessions (cookie carries only the signed-less opaque id; the record lives server-side) ---
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

  // --- My sessions (report_usersessions: my profile navigation) -------------
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
