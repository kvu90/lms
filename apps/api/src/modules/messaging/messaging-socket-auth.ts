import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { fromNodeHeaders } from 'better-auth/node';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { BetterAuthService } from '../auth/better-auth/better-auth.service';
import { BETTER_AUTH_SESSION_COOKIE } from '../auth/better-auth/better-auth.instance';
import { tenantAls } from '../tenants/tenant-als';
import { resolveDedicatedSpace, type DedicatedSpace } from '../tenants/space-resolution';
import { UsersService } from '../users/users.service';
import { MessagingRepository } from './messaging.repository';

export interface MessagingSocketIdentity {
  userId: string;
  username: string;
  /**
   * Tenant hiệu lực của phiên (claim `tid` của token, TENANT-1 #196):
   * room + khoá presence của socket được namespace theo tenant này.
   * Token cũ không mang `tid` → null (room rơi về đoạn 'platform').
   * Phiên cookie Better Auth không mang claim: tenant được phân giải
   * là tenant mặc định của user (xem authenticateCookie).
   */
  tenantId: string | null;
}

/** Phần handshake của Socket.IO mà lớp auth cần: `auth` mang theo + headers (chứa cookie). */
export interface MessagingHandshake {
  auth?: unknown;
  headers: Record<string, string | string[] | undefined>;
}

const SESSION_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)(?:__Secure-)?${BETTER_AUTH_SESSION_COOKIE}=`);

/**
 * Lớp xác thực MỎNG cho kênh realtime của messaging — điểm chạm DUY
 * NHẤT của gateway với cơ chế auth (issue #33, chặng A1).
 *
 * Hai đường danh tính, đúng thứ tự của chuỗi guard HTTP (GĐ5 của
 * issue #7 — realtime trên cookie):
 *
 * 1. **Cookie phiên Better Auth TRƯỚC** — cùng semantics với
 *    `BetterAuthSessionGuard` phía HTTP: cờ Better Auth bật + cookie
 *    phiên có mặt + phiên hợp lệ + tài khoản còn active (không
 *    suspended/deleted) thì danh tính chốt ở đây. Cookie có nhưng
 *    phiên không dùng được (hỏng chữ ký, hết hạn, tài khoản bị khoá)
 *    thì KHÔNG kết luận từ chối — rơi xuống đường token, đúng như
 *    guard HTTP không đặt danh tính và để JwtAuthGuard quyết định.
 * 2. **Access token JWT hiện tại** làm đường dự phòng (giữ nguyên
 *    hành vi cho tới cutover GĐ2): token mang `{ sub, username, sid }`,
 *    không có `scope` (token có scope là của luồng khác, bị
 *    JwtAuthStrategy của REST từ chối), và user phải còn active. Lớp
 *    này áp đúng các kiểm đó qua cùng secret và UsersService.
 *
 * Phân giải không gian theo Host — tiền điều kiện Phần B của issue
 * #587 (PR-TĐ2), cùng khuôn `JwtAuthStrategy`/`LocalAuthStrategy`
 * phía HTTP (issue #584): handshake mang header `Host` là tên miền
 * con mang slug của trung tâm, nên lớp này tự phân giải không gian
 * TRƯỚC mọi lượt đọc danh tính, vì gateway chạy ngoài ngữ cảnh
 * request nên không có guard nào ghim slug trước cho nó:
 *
 * - Địa chỉ thuộc trung tâm ở kho riêng → toàn bộ các lượt đọc của
 *   đường đó (phiên Better Auth, tài khoản, tenant mặc định ở đường
 *   cookie; tài khoản ở đường token) chạy trong kho của trung tâm
 *   đó qua `SpaceDatabaseService.withSpaceDatabase`. Handle dữ kiện
 *   mà mọi điểm inject nhận là handle định tuyến của khung (xem
 *   `app.module.ts`): nó chọn kho theo slug trong ngữ cảnh ALS mà
 *   `withSpaceDatabase` vừa chuẩn bị vừa ghim, nên không cần đổi
 *   cách gọi của BetterAuth/UsersService/Repository — chỉ cần bọc
 *   đúng phạm vi. Riêng lượt suy tenant mặc định vẫn chạy trong
 *   ngữ cảnh platform (bypass RLS như trước) NHƯNG giữ nguyên slug
 *   trong store ALS (`{ platform: true, spaceSlug }`): bọc
 *   `tenantAls.run({ platform: true })` trần sẽ thay toàn bộ store
 *   và đánh rơi slug, khiến lượt đọc rơi về kho chung.
 * - Địa chỉ còn lại (không mang trung tâm, slug chưa đăng ký,
 *   tầng định tuyến chưa cấu hình, hoặc trung tâm ở kho chung —
 *   `resolveDedicatedSpace` trả `null`) → hành vi hiện tại giữ
 *   nguyên từng điểm, đọc ở kho chung như trước.
 * - Lỗi phân giải còn lại (bí mật/role của kho riêng lệch sổ đăng
 *   ký) và lỗi chuẩn bị kho đích (`withSpaceDatabase` mở pool
 *   thất bại) NÉM RA nguyên trạng, fail-closed: lớp này không bắt
 *   rồi rơi về đường kho chung, gateway bắt lỗi ở
 *   `handleConnection` và ngắt kết nối. Ngoại lệ duy nhất vẫn rơi
 *   xuống đường token là phiên cookie tự nó không dùng được (hỏng
 *   chữ ký/định dạng, hết hạn): lỗi đó nằm trong khối try của
 *   `getSession`, sau khi kho đích đã chuẩn bị xong, nên không
 *   phải lỗi phân giải/chuẩn bị.
 *
 * Đường token đối chiếu claim `centre_id` với không gian tại địa
 * chỉ như `JwtAuthStrategy`: claim lệch → null ngay, không tra kho
 * đích để khẳng định thêm; claim vắng thì tra trong kho của không
 * gian tại địa chỉ (token cấp trước khi claim tồn tại vẫn thuộc
 * trung tâm đó). Lớp này KHÔNG mang ngoại lệ đường vận hành
 * platform của `JwtAuthStrategy` (token không claim, `tid` của
 * tenant platform tra ở kho chung): gateway socket không phải bề
 * mặt vận hành platform như HTTP, và đặc tả tiền điều kiện §1.2
 * chỉ yêu cầu tra trong kho của trung tâm mang claim — trường hợp
 * quản trị platform nối socket tại địa chỉ trung tâm kho riêng vì
 * vậy tra trong kho đích và bị từ chối, không rơi lặng về kho
 * chung; đây là điểm khác biệt có chủ đích so với HTTP, ghi rõ để
 * đội review xác nhận.
 *
 * Gateway, consumer và tầng phân phối không biết gì về cơ chế bên
 * dưới — chúng chỉ nhận `MessagingSocketIdentity | null`, hoặc
 * lỗi phân giải/chuẩn bị kho đích khiến gateway ngắt kết nối.
 */
@Injectable()
export class MessagingSocketAuth {
  private readonly jwt: JwtService;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly users: UsersService,
    private readonly betterAuth: BetterAuthService,
    private readonly repo: MessagingRepository,
    // Khung định tuyến theo trung tâm (issue #581): module messaging
    // import SpaceRoutingModule để lấy provider này. @Optional để
    // các nơi dựng lớp tay không qua Nest (unit spec cũ) vẫn chạy
    // đúng đường kho chung khi không cấp khung — app thật luôn có
    // khung qua module, nên đường kho riêng không bao giờ thiếu nó.
    @Optional() private readonly spaceDb?: SpaceDatabaseService,
  ) {
    this.jwt = new JwtService({ secret: config.getOrThrow<string>('JWT_SECRET') });
  }

  /**
   * Xác thực toàn bộ handshake: thử cookie phiên Better Auth trước,
   * không chốt được danh tính thì thử token mang theo handshake.
   * Null nghĩa là cả hai đường đều không dùng được — gateway ngắt
   * kết nối ngay, không lộ lý do ra client. Lỗi phân giải/chuẩn bị
   * kho đích từ đường cookie NÉM RA (không rơi xuống đường token),
   * vì rơi xuống là mở đường tra cứu thứ hai ngoài kho đích.
   */
  async authenticateHandshake(handshake: MessagingHandshake): Promise<MessagingSocketIdentity | null> {
    const viaCookie = await this.authenticateCookie(handshake.headers);
    if (viaCookie) return viaCookie;
    return this.authenticate(extractHandshakeToken(handshake), handshake.headers.host);
  }

  /**
   * Danh tính từ cookie phiên Better Auth trong headers của
   * handshake (trình duyệt gửi cookie cùng nguồn kèm request bắt tay
   * khi client bật `withCredentials`). Trả null cho mọi trường hợp
   * không dùng được: cờ tắt, không có cookie phiên, phiên
   * hỏng/hết hạn, user không còn active.
   *
   * Phiên cookie không mang claim tenant như JWT: tenant hiệu lực
   * được phân giải như `TenantGuard` phía HTTP khi danh tính không
   * có `tid` — tenant mặc định của user theo membership (cùng luật
   * `TenantsService.resolveDefaultTenant`, bản gương trong repo của
   * messaging), tra cứu trong ngữ cảnh platform vì đây là đường
   * tiền-ngữ-cảnh giống hệt cách TenantGuard tự phân giải.
   *
   * Khi địa chỉ thuộc trung tâm ở kho riêng, toàn bộ ba lượt đọc
   * (phiên, tài khoản, tenant mặc định) chạy trong kho đó qua
   * `withSpaceDatabase`; khi địa chỉ không thuộc kho riêng, hành vi
   * giữ nguyên: đọc ở kho chung. Lỗi phân giải/chuẩn bị kho đích
   * ném ra, không rơi về kho chung (xem khối TSDoc của lớp).
   */
  async authenticateCookie(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<MessagingSocketIdentity | null> {
    if (!this.betterAuth.enabled) return null;
    const cookie = headers['cookie'];
    if (typeof cookie !== 'string' || !SESSION_COOKIE_PATTERN.test(cookie)) return null;
    const auth = this.betterAuth.requireAuth();
    // Phân giải TRƯỚC mọi lượt đọc: lỗi phân giải ném ra tại đây,
    // trước khi bất kỳ lượt đọc nào chạm vào kho chung hay kho đích.
    const space = await this.resolveSpace(headers.host);
    if (!space) return this.readCookieIdentity(auth, headers, null);
    // Lỗi chuẩn bị kho đích ném ra từ chính `withSpaceDatabase`
    // (trước khi callback chạy), không bị khối try của getSession
    // nuốt thành null — fail-closed như đường HTTP.
    return this.spaceDb!.withSpaceDatabase(space.slug, () =>
      this.readCookieIdentity(auth, headers, space),
    );
  }

  /**
   * Đọc danh tính từ một cookie phiên trong đúng một kho: phiên,
   * tài khoản, rồi tenant mặc định. `space` null nghĩa là đường kho
   * chung hiện tại; `space` có giá trị nghĩa là hàm này đang chạy
   * trong `withSpaceDatabase` của kho đó, và lượt suy tenant mặc
   * định phải giữ slug trong store ALS (xem khối TSDoc của lớp).
   */
  private async readCookieIdentity(
    auth: ReturnType<BetterAuthService['requireAuth']>,
    headers: Record<string, string | string[] | undefined>,
    space: DedicatedSpace | null,
  ): Promise<MessagingSocketIdentity | null> {
    let resolved: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      resolved = await auth.api.getSession({ headers: fromNodeHeaders(headers) });
    } catch {
      // Cookie hỏng chữ ký/định dạng: coi như không có phiên Better
      // Auth, để đường token quyết định — như BetterAuthSessionGuard.
      return null;
    }
    if (!resolved) return null;
    const user = await this.users.getByIdOrUndefined(resolved.session.userId);
    if (!user || user.suspended || user.deleted) return null;
    const tenantId = await tenantAls.run(
      space ? { platform: true, spaceSlug: space.slug } : { platform: true },
      () => this.repo.getUserDefaultTenantId(user.id),
    );
    return { userId: user.id, username: user.username, tenantId };
  }

  /**
   * Xác thực một access token lấy từ handshake của socket. Trả null
   * cho mọi trường hợp không hợp lệ (thiếu token, sai chữ ký, hết hạn,
   * token có scope, thiếu sid, user không còn active, claim
   * `centre_id` lệch không gian tại địa chỉ) — gateway ngắt kết nối
   * ngay, không lộ lý do ra client.
   *
   * @param token - Access token từ `auth.token` hoặc header Bearer.
   * @param host - Header `Host` của handshake: địa chỉ trung tâm để
   *   phân giải kho riêng; vắng hoặc không thuộc kho riêng thì tra
   *   ở kho chung như trước. Lỗi phân giải/chuẩn bị kho đích ném ra,
   *   không rơi về kho chung.
   */
  async authenticate(
    token: string | undefined,
    host?: string | string[],
  ): Promise<MessagingSocketIdentity | null> {
    if (!token) return null;
    let payload: {
      sub?: string;
      username?: string;
      scope?: unknown;
      sid?: unknown;
      tid?: unknown;
      centre_id?: unknown;
    };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      return null;
    }
    // Cùng luật với JwtAuthStrategy phía REST: chỉ access token đăng
    // nhập (không scope) gắn với một phiên (sid) mới được chấp nhận.
    if (!payload.sub || payload.scope !== undefined || typeof payload.sid !== 'string') return null;
    // Phân giải TRƯỚC khi tra tài khoản, cùng khuôn JwtAuthStrategy.
    const space = await this.resolveSpace(host);
    if (space && payload.centre_id !== undefined && payload.centre_id !== space.spaceId) {
      // Token của một trung tâm khác: từ chối ngay, không tra kho
      // đích để khẳng định thêm — và tuyệt đối không tra kho chung.
      return null;
    }
    const user = space
      ? await this.spaceDb!.withSpaceDatabase(space.slug, () =>
          this.users.getByIdOrUndefined(payload.sub as string),
        )
      : await this.users.getByIdOrUndefined(payload.sub);
    if (!user || user.suspended || user.deleted) return null;
    return {
      userId: user.id,
      username: user.username,
      tenantId: typeof payload.tid === 'string' ? payload.tid : null,
    };
  }

  /**
   * Phân giải địa chỉ handshake thành không gian ở kho riêng, hoặc
   * `null` khi handshake không thuộc trung tâm kho riêng nào. Lỗi
   * phân giải còn lại (bí mật/role lệch sổ) ném ra nguyên trạng —
   * hàm này không tự biến lỗi thành `null`, vì đó sẽ là đường rơi
   * lặng về kho chung mà tiền điều kiện §1.2 cấm.
   */
  private resolveSpace(host: string | string[] | undefined): Promise<DedicatedSpace | null> {
    if (!this.spaceDb) return Promise.resolve(null);
    return resolveDedicatedSpace(this.spaceDb, host);
  }
}

/** Token từ handshake: ưu tiên `auth.token` (socket.io client chính thức), dự phòng header Bearer. */
function extractHandshakeToken(handshake: MessagingHandshake): string | undefined {
  const authToken = (handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof authToken === 'string' && authToken.length > 0) return authToken;
  const header = handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  return undefined;
}
