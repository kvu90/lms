import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

class LoginDto { @IsString() username!: string; @IsString() password!: string }
class RefreshDto { @IsString() refreshToken!: string }
class ChangePasswordDto { @IsString() currentPassword!: string; @IsString() @MinLength(1) newPassword!: string }
class LoginAsDto { @IsInt() userid!: number }

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

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly users: UsersService) {}

  @Public()
  @UseGuards(AuthGuard('local'))
  @Post('login')
  async login(@Req() req: Request & { user: { id: number; username: string } }, @Body() _dto: LoginDto) {
    const user = await this.users.getUser(req.user.id);
    await this.users.recordLogin(user.id);
    // validateCredentials already ran inside the local strategy; issue a fresh token family here.
    const tokens = await this.auth.issueTokensFor(user);
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, ...tokens };
  }

  @Public()
  @Post('token')
  async tokenLogin(@Body() dto: LoginDto, @Req() req: Request) {
    const { user, tokens } = await this.auth.login(dto.username, dto.password, req.ip);
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, ...tokens };
  }

  @Public()
  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) { return this.auth.refresh(dto.refreshToken); }

  @Post('logout')
  async logout(@Body() dto: RefreshDto) { await this.auth.logout(dto.refreshToken); return { loggedOut: true }; }

  @Post('change-password')
  async changePassword(@Body() dto: ChangePasswordDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.auth.changePassword(actor.id, dto.currentPassword, dto.newPassword);
    return { changed: true };
  }

  @Post('login-as')
  async loginAs(@Body() dto: LoginAsDto, @CurrentUser() actor: AuthenticatedUser) {
    const { user, tokens } = await this.auth.loginAs(actor.id, dto.userid);
    return { user: { id: user.id, username: user.username }, ...tokens, loginAs: { byUserId: actor.id } };
  }

  // --- Redis web sessions (cookie carries only the signed-less opaque id; the record lives server-side) ---
  @Public()
  @Post('session/login')
  async sessionLogin(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { sessionId, user } = await this.auth.sessionLogin(dto.username, dto.password, sessionCookieOf(req), req.ip);
    res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, sessionId };
  }
  @Public()
  @Get('session/me')
  async sessionMe(@Req() req: Request) {
    const user = await this.auth.sessionUser(sessionCookieOf(req) ?? (req.headers['x-session-id'] as string | undefined));
    return this.users.getProfileView(user.id, user.id);
  }
  @Public()
  @Post('session/logout')
  async sessionLogout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.sessionLogout(sessionCookieOf(req) ?? (req.headers['x-session-id'] as string | undefined));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return { loggedOut: true };
  }
}
