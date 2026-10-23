import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { SESSION_COOKIE } from './auth.controller';
import { oauthHandoffSchema, oauthIssuerSchema, type OAuthHandoffDto, type OAuthIssuerParam } from './dto/auth.dto';
import { OAuthFlowException, OAuthService } from './oauth.service';

@ApiTags('auth')
@Controller({ path: 'auth/oauth', version: '1' })
/**
 * API đăng nhập xã hội (plugin lõi auth_oauth2 của Moodle): cấu hình
 * issuer công khai, khởi tạo luồng authorize, callback của nhà cung cấp,
 * đổi mã bàn giao, và quản lý liên kết của chính user (Linked logins).
 */
export class OAuthController {
  constructor(private readonly oauth: OAuthService, private readonly config: ConfigService) {}

  /** URL callback tuyệt đối của issuer theo origin của request hiện tại — redirect_uri phải khớp nguyên vẹn giữa bước authorize và bước đổi code nên nó được nhúng vào state đã ký. */
  private callbackUrl(req: Request, issuer: string): string {
    return `${req.protocol}://${req.get('host')}/api/v1/auth/oauth/${issuer}/callback`;
  }

  /** Đích chuyển hướng phía web sau callback: WEB_APP_URL khi tách origin, ngược lại cùng origin với API. */
  private webUrl(path: string): string {
    const base = this.config.get<string>('WEB_APP_URL') ?? '';
    return `${base}${path}`;
  }

  @Public()
  @Get('providers')
  /**
   * GET /auth/oauth/providers — issuer dựng sẵn nào đang bật (trang login chỉ hiện nút của issuer đã bật, đúng hành vi Moodle).
   */
  async providers() {
    return { providers: this.oauth.listProviders() };
  }

  @Public()
  @Get(':issuer/authorize')
  /**
   * GET /auth/oauth/:issuer/authorize — URL authorize cho luồng đăng nhập (khách chưa đăng nhập).
   */
  async authorize(@Param('issuer', { schema: oauthIssuerSchema }) issuer: OAuthIssuerParam, @Req() req: Request) {
    return { authorizeUrl: await this.oauth.buildAuthorizeUrl(issuer, this.callbackUrl(req, issuer)) };
  }

  @Get(':issuer/link')
  /**
   * GET /auth/oauth/:issuer/link — URL authorize cho luồng liên kết: user đang đăng nhập gắn thêm tài khoản provider vào tài khoản của mình.
   */
  async link(@Param('issuer', { schema: oauthIssuerSchema }) issuer: OAuthIssuerParam, @CurrentUser() actor: AuthenticatedUser, @Req() req: Request) {
    return { authorizeUrl: await this.oauth.buildAuthorizeUrl(issuer, this.callbackUrl(req, issuer), actor.id) };
  }

  @Public()
  @Get(':issuer/callback')
  /**
   * GET /auth/oauth/:issuer/callback — điểm về của nhà cung cấp. Thành
   * công: đặt cookie phiên như đăng nhập thường rồi chuyển hướng về SPA
   * kèm mã bàn giao một lần. Thất bại nghiệp vụ: về trang login kèm mã
   * lỗi để giao diện dịch ra thông báo (không trả JSON giữa luồng duyệt).
   */
  async callback(
    @Param('issuer', { schema: oauthIssuerSchema }) issuer: OAuthIssuerParam,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!code || !state) {
      return res.redirect(this.webUrl('/login?oauthError=auth.oauth_callback_invalid'));
    }
    try {
      const { sessionId, handoffCode } = await this.oauth.handleCallback(issuer, code, state, {
        ip: req.ip, userAgent: req.headers['user-agent'],
      });
      res.cookie(SESSION_COOKIE, sessionId, { httpOnly: true, sameSite: 'lax', path: '/' });
      return res.redirect(this.webUrl(`/oauth/callback?handoff=${encodeURIComponent(handoffCode)}`));
    } catch (err) {
      const errorCode = err instanceof OAuthFlowException ? err.code : 'auth.oauth_failed';
      return res.redirect(this.webUrl(`/login?oauthError=${encodeURIComponent(errorCode)}`));
    }
  }

  @Public()
  @Post('handoff')
  /**
   * POST /auth/oauth/handoff — SPA đổi mã bàn giao một lần lấy cặp token như đáp ứng đăng nhập thường.
   */
  async handoff(@Body({ schema: oauthHandoffSchema }) dto: OAuthHandoffDto, @Req() req: Request) {
    const { user, tokens } = await this.oauth.exchangeHandoff(dto.code, { ip: req.ip, userAgent: req.headers['user-agent'] });
    return { user: { id: user.id, username: user.username, forcePasswordChange: user.forcePasswordChange }, ...tokens };
  }

  @Get('links')
  /**
   * GET /auth/oauth/links — các liên kết đăng nhập ngoài của chính người gọi (trang Linked logins).
   */
  async links(@CurrentUser() actor: AuthenticatedUser) {
    const { links, hasPassword } = await this.oauth.listLinks(actor.id);
    return {
      links: links.map((link) => ({
        id: link.id, issuer: link.issuer, email: link.email, createdAt: link.createdAt.toISOString(),
      })),
      hasPassword,
    };
  }

  @Delete('links/:linkId')
  /**
   * DELETE /auth/oauth/links/:linkId — gỡ một liên kết của chính người gọi; bị chặn khi đó là đường đăng nhập duy nhất của tài khoản chưa có mật khẩu.
   */
  async unlink(@Param('linkId', { schema: uuidIdSchema }) linkId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.oauth.unlink(actor.id, linkId);
    return { unlinked: true };
  }
}
