import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { OAuthIssuer } from '@lms/contracts';
import { SessionCacheService } from '../../infra/cache/session-cache.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';
import { AuthRepository, type UserOauthLinkRow } from './auth.repository';
import { AuthService, type SessionClientInfo } from './auth.service';
import { SessionService } from './session.service';

/**
 * Lỗi nghiệp vụ của luồng OAuth được mang theo `code` ổn định để callback
 * chuyển hướng về trang login kèm mã lỗi (`/login?oauthError=<code>`) thay
 * vì trả JSON giữa chừng — trình duyệt đang ở ngoài SPA tại thời điểm đó.
 */
export class OAuthFlowException extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Hồ sơ danh tính đã chuẩn hoá từ userinfo của nhà cung cấp. */
interface ProviderProfile {
  /** Định danh chủ thể ổn định phía provider (`sub` của Google, `id` của Facebook). */
  subject: string;
  email: string;
  /** Provider có khẳng định email đã xác thực không (Google: `email_verified`; Facebook không công bố cờ này — email trả về từ Graph API được coi là đã xác thực, giống issuer dựng sẵn của Moodle). */
  emailVerified: boolean;
  firstName: string;
  lastName: string;
}

/** Định nghĩa một issuer dựng sẵn: điểm cuối mặc định (URL thật của provider) + scope xin tối thiểu để lấy email và họ tên. */
interface ProviderDefinition {
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  /** Tiền tố biến môi trường cho phép ghi đè từng điểm cuối (dùng cho kiểm thử mock ở biên HTTP). */
  envPrefix: 'OAUTH_GOOGLE' | 'OAUTH_FACEBOOK';
}

const PROVIDER_DEFINITIONS: Record<OAuthIssuer, ProviderDefinition> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userinfoUrl: 'https://www.googleapis.com/oauth2/v3/userinfo',
    scope: 'openid email profile',
    envPrefix: 'OAUTH_GOOGLE',
  },
  facebook: {
    // Graph API bắt buộc gắn phiên bản vào đường dẫn; v21.0 là phiên bản
    // ổn định đang được Meta hỗ trợ cho dialog/oauth và /me.
    authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
    userinfoUrl: 'https://graph.facebook.com/v21.0/me?fields=id,email,first_name,last_name',
    scope: 'email public_profile',
    envPrefix: 'OAUTH_FACEBOOK',
  },
};

/** Nội dung state OAuth đã ký: chống CSRF, gắn issuer và đích hoàn tất (đăng nhập thường hoặc liên kết cho user đang đăng nhập). */
interface OAuthState {
  scope: 'oauth_state';
  issuer: OAuthIssuer;
  redirectUri: string;
  linkUserId?: string;
  nonce: string;
}

/**
 * Đăng nhập xã hội theo mẫu plugin lõi `auth_oauth2` của Moodle: issuer
 * dựng sẵn Google/Facebook chạy luồng authorization code; callback khớp
 * tài khoản theo thứ tự (1) liên kết đã có theo tài khoản provider,
 * (2) liên kết đích danh khi user đang đăng nhập xin liên kết, (3) email
 * đã xác thực trùng một tài khoản sẵn có ⇒ tạo liên kết, (4) chưa có ⇒
 * tạo tài khoản mới đã xác nhận (`create_new_confirmed_account`).
 * Hoàn tất đăng nhập dùng ĐÚNG cơ chế sẵn có: phiên web cookie được tạo
 * như đăng nhập thường và SPA nhận cặp token qua mã bàn giao một lần —
 * không tồn tại cơ chế phiên thứ hai.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
    private readonly repo: AuthRepository,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly store: SessionCacheService,
  ) {}

  /** Client id của issuer từ biến môi trường (rỗng = chưa cấu hình). */
  private clientId(issuer: OAuthIssuer): string | undefined {
    return this.config.get<string>(`${PROVIDER_DEFINITIONS[issuer].envPrefix}_CLIENT_ID`);
  }

  /** Client secret của issuer từ biến môi trường — chỉ đọc lúc gọi provider, không bao giờ ghi log/trả về. */
  private clientSecret(issuer: OAuthIssuer): string | undefined {
    return this.config.get<string>(`${PROVIDER_DEFINITIONS[issuer].envPrefix}_CLIENT_SECRET`);
  }

  /** Issuer có bật không: cả client id lẫn secret đều đã cấu hình (Moodle: issuer chưa bật thì nút đăng nhập không hiện). */
  isEnabled(issuer: OAuthIssuer): boolean {
    return Boolean(this.clientId(issuer) && this.clientSecret(issuer));
  }

  /**
   * Trạng thái bật/tắt của mọi issuer dựng sẵn cho endpoint cấu hình công khai của trang login.
   */
  listProviders(): { issuer: OAuthIssuer; enabled: boolean }[] {
    return (Object.keys(PROVIDER_DEFINITIONS) as OAuthIssuer[]).map((issuer) => ({ issuer, enabled: this.isEnabled(issuer) }));
  }

  /** Điểm cuối hiệu lực của issuer: biến môi trường ghi đè thắng mặc định trong code. */
  private endpoint(issuer: OAuthIssuer, kind: 'AUTHORIZE_URL' | 'TOKEN_URL' | 'USERINFO_URL'): string {
    const def = PROVIDER_DEFINITIONS[issuer];
    const override = this.config.get<string>(`${def.envPrefix}_${kind}`);
    if (override) return override;
    return kind === 'AUTHORIZE_URL' ? def.authorizeUrl : kind === 'TOKEN_URL' ? def.tokenUrl : def.userinfoUrl;
  }

  /**
   * Dựng URL authorize để trình duyệt chuyển hướng sang provider. State
   * là JWT ký bằng khoá của hệ (hạn ngắn), mang issuer, redirect_uri sẽ
   * dùng lại nguyên vẹn ở bước đổi code và — khi user đang đăng nhập xin
   * liên kết — định danh user đích.
   */
  async buildAuthorizeUrl(issuer: OAuthIssuer, redirectUri: string, linkUserId?: string): Promise<string> {
    if (!this.isEnabled(issuer)) {
      throw new NotFoundException({ message: 'OAuth issuer is not configured', code: 'auth.oauth_issuer_not_configured' });
    }
    const ttl = this.config.get<number>('OAUTH_STATE_TTL_SECONDS') ?? 600;
    const state = await this.jwt.signAsync(
      { scope: 'oauth_state', issuer, redirectUri, linkUserId, nonce: randomUUID() } satisfies OAuthState,
      { expiresIn: ttl },
    );
    const url = new URL(this.endpoint(issuer, 'AUTHORIZE_URL'));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.clientId(issuer)!);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', PROVIDER_DEFINITIONS[issuer].scope);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Kiểm state ở callback: chữ ký, hạn, scope và issuer phải khớp đường dẫn; sai bất cứ điểm nào đều là `auth.oauth_state_invalid`. */
  private async verifyState(issuer: OAuthIssuer, stateToken: string): Promise<OAuthState> {
    let payload: OAuthState;
    try {
      payload = await this.jwt.verifyAsync<OAuthState>(stateToken);
    } catch {
      throw new OAuthFlowException('auth.oauth_state_invalid');
    }
    if (payload.scope !== 'oauth_state' || payload.issuer !== issuer || !payload.redirectUri) {
      throw new OAuthFlowException('auth.oauth_state_invalid');
    }
    return payload;
  }

  /** Đổi authorization code lấy access token tại token endpoint của provider (gọi HTTP thật; kiểm thử mock ở chính biên này). */
  private async exchangeCode(issuer: OAuthIssuer, code: string, redirectUri: string): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: this.clientId(issuer)!,
      client_secret:
        this.clientSecret(issuer)!,
    });
    const res = await fetch(this.endpoint(issuer, 'TOKEN_URL'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (!res.ok) throw new OAuthFlowException('auth.oauth_token_exchange_failed');
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new OAuthFlowException('auth.oauth_token_exchange_failed');
    return data.access_token;
  }

  /** Lấy hồ sơ từ userinfo endpoint và chuẩn hoá về một hình dạng chung; thiếu email là lỗi nghiệp vụ riêng (`auth.oauth_email_missing`). */
  private async fetchProfile(issuer: OAuthIssuer, accessToken: string): Promise<ProviderProfile> {
    let url = this.endpoint(issuer, 'USERINFO_URL');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (issuer === 'facebook') {
      // Graph API nhận access token qua query string thay vì header Bearer.
      url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(accessToken)}`;
    } else {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    const res = await fetch(url, { headers });
    if (!res.ok) throw new OAuthFlowException('auth.oauth_userinfo_failed');
    const raw = (await res.json()) as Record<string, unknown>;
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    if (!email) throw new OAuthFlowException('auth.oauth_email_missing');
    if (issuer === 'google') {
      return {
        subject: String(raw.sub ?? ''),
        email,
        emailVerified: raw.email_verified === true,
        firstName: typeof raw.given_name === 'string' ? raw.given_name : '',
        lastName: typeof raw.family_name === 'string' ? raw.family_name : '',
      };
    }
    return {
      subject: String(raw.id ?? ''),
      email,
      emailVerified: true,
      firstName: typeof raw.first_name === 'string' ? raw.first_name : '',
      lastName: typeof raw.last_name === 'string' ? raw.last_name : '',
    };
  }

  /**
   * Tạo liên kết provider → user, chịu được cuộc đua hai callback đồng
   * thời: nếu ràng buộc duy nhất ở DB đã chặn thì đọc lại liên kết thắng
   * cuộc và dùng nó (chỉ khi nó trỏ về đúng user này).
   */
  private async ensureLink(user: UserRow, issuer: OAuthIssuer, profile: ProviderProfile): Promise<UserOauthLinkRow> {
    const existing = await this.repo.getOauthLinkBySubject(issuer, profile.subject);
    if (existing) {
      if (existing.userId !== user.id) throw new OAuthFlowException('auth.oauth_link_conflict');
      return existing;
    }
    try {
      return await this.repo.createOauthLink({ userId: user.id, issuer, issuerUserId: profile.subject, email: profile.email });
    } catch {
      const raced = await this.repo.getOauthLinkBySubject(issuer, profile.subject);
      if (raced && raced.userId === user.id) return raced;
      throw new OAuthFlowException('auth.oauth_link_conflict');
    }
  }

  /**
   * Xử lý callback của provider: kiểm state → đổi code → lấy hồ sơ (bắt
   * buộc email đã xác thực) → khớp/tạo tài khoản như `complete_login` của
   * Moodle → ghi nhận đăng nhập, tạo phiên web và cấp mã bàn giao một
   * lần cho SPA đổi lấy cặp token.
   */
  async handleCallback(
    issuer: OAuthIssuer,
    code: string,
    stateToken: string,
    client: { ip?: string; userAgent?: string },
  ): Promise<{ user: UserRow; sessionId: string; handoffCode: string }> {
    if (!this.isEnabled(issuer)) throw new OAuthFlowException('auth.oauth_issuer_not_configured');
    const state = await this.verifyState(issuer, stateToken);
    const accessToken = await this.exchangeCode(issuer, code, state.redirectUri);
    const profile = await this.fetchProfile(issuer, accessToken);
    if (!profile.subject) throw new OAuthFlowException('auth.oauth_userinfo_failed');
    if (!profile.emailVerified) throw new OAuthFlowException('auth.oauth_email_unverified');

    let user: UserRow;
    const linked = await this.repo.getOauthLinkBySubject(issuer, profile.subject);
    if (linked) {
      user = await this.users.getUser(linked.userId);
    } else if (state.linkUserId) {
      // User đang đăng nhập xin liên kết: chính họ vừa chứng minh quyền
      // sở hữu tài khoản provider qua luồng authorize, nên liên kết được
      // xác nhận ngay (Moodle: confirmtoken rỗng sau bước xác nhận).
      user = await this.users.getUser(state.linkUserId);
      await this.ensureLink(user, issuer, profile);
    } else {
      const byEmail = await this.users.getByEmail(profile.email);
      if (byEmail) {
        user = byEmail;
        await this.ensureLink(user, issuer, profile);
      } else {
        user = await this.users.createExternalUser({
          email: profile.email, firstName: profile.firstName, lastName: profile.lastName,
        });
        await this.ensureLink(user, issuer, profile);
      }
    }
    if (user.deleted || user.suspended) throw new OAuthFlowException('auth.account_inactive');

    await this.users.recordLogin(user.id);
    const sessionId = await this.sessions.create({ userId: user.id, username: user.username, ip: client.ip, userAgent: client.userAgent });
    const handoffCode = randomUUID();
    const handoffTtlMs = (this.config.get<number>('OAUTH_HANDOFF_TTL_SECONDS') ?? 120) * 1000;
    await this.store.set(`oauthhandoff:${handoffCode}`, user.id, handoffTtlMs);
    return { user, sessionId, handoffCode };
  }

  /**
   * Đổi mã bàn giao một lần lấy cặp token như đăng nhập thường. Mã bị
   * xoá ngay khi đổi (dù thành công hay tài khoản đã mất hiệu lực) nên
   * không dùng lại được lần hai.
   */
  async exchangeHandoff(code: string, client?: SessionClientInfo): Promise<{ user: UserRow; tokens: Awaited<ReturnType<AuthService['issueTokensFor']>> }> {
    const key = `oauthhandoff:${code}`;
    const userId = await this.store.get<string>(key);
    if (!userId) {
      throw new UnauthorizedException({ message: 'OAuth handoff code is invalid or expired', code: 'auth.oauth_handoff_invalid' });
    }
    await this.store.delete(key);
    const user = await this.users.getByIdOrUndefined(userId);
    if (!user || user.deleted || user.suspended) {
      throw new UnauthorizedException({ message: 'Account is not active', code: 'auth.account_inactive' });
    }
    const tokens = await this.auth.issueTokensFor(user, client);
    return { user, tokens };
  }

  /**
   * Danh sách liên kết của chính user cho trang Linked logins, kèm cờ
   * `hasPassword` để giao diện giải thích ràng buộc gỡ liên kết.
   */
  async listLinks(userId: string): Promise<{ links: UserOauthLinkRow[]; hasPassword: boolean }> {
    const user = await this.users.getUser(userId);
    const links = await this.repo.listOauthLinksByUser(userId);
    return { links, hasPassword: Boolean(user.passwordHash) };
  }

  /**
   * Gỡ một liên kết của chính user. Chặn gỡ khi đó là đường đăng nhập
   * DUY NHẤT còn lại của một tài khoản không có mật khẩu (gỡ xong user
   * sẽ không còn cách nào vào lại) — cùng lý lẽ Moodle không để user tự
   * cắt đường đăng nhập cuối cùng; user đặt mật khẩu trước thì gỡ được.
   */
  async unlink(userId: string, linkId: string): Promise<void> {
    const link = await this.repo.getOauthLinkById(linkId);
    if (!link || link.userId !== userId) {
      throw new NotFoundException({ message: 'Linked login not found', code: 'auth.oauth_link_not_found' });
    }
    const user = await this.users.getUser(userId);
    if (!user.passwordHash) {
      const links = await this.repo.listOauthLinksByUser(userId);
      if (links.length <= 1) {
        throw new BadRequestException({
          message: 'Cannot remove the only remaining sign-in method of an account without a password; set a password first',
          code: 'auth.last_login_method',
        });
      }
    }
    await this.repo.deleteOauthLink(linkId);
  }
}
