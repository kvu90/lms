import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { fromNodeHeaders } from 'better-auth/node';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingError } from '../../db/routing/space-connection-resolver';
import { BetterAuthService } from '../auth/better-auth/better-auth.service';
import { BETTER_AUTH_SESSION_COOKIE } from '../auth/better-auth/better-auth.instance';
import { tenantAls } from '../tenants/tenant-als';
import {
  extractSpaceSlugFromHost,
  resolveDedicatedSpace,
  type DedicatedSpace,
} from '../tenants/space-resolution';
import { TenantsService } from '../tenants/tenants.service';
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
  /**
   * Slug của trung tâm ở kho riêng mà danh tính này đã được phân
   * giải TRONG kho của trung tâm đó; `null` khi danh tính thuộc
   * đường kho chung (địa chỉ thường, trung tâm kho chung, hoặc
   * phiên vận hành platform được tra ở kho chung ngay tại địa chỉ
   * kho riêng). Gateway gắn slug này lên kết nối để mọi lượt đọc
   * dữ kiện theo kết nối (vào room lúc nối, join/sync/typing)
   * chạy trong đúng kho của trung tâm qua `withSpaceDatabase` —
   * danh tính đã phân giải ở kho riêng mà các lượt đọc đó rơi về
   * kho chung thì hội thoại/membership của trung tâm vô hình với
   * socket dù xác thực đã qua.
   */
  spaceSlug: string | null;
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
 * Phân giải không gian theo địa chỉ (tiền điều kiện Phần B của
 * issue #587, hạng mục 1): handshake mang header `Host` như request
 * HTTP, nên lớp này phân giải không gian từ Host MỘT lần cho cả hai
 * đường, đúng khuôn `BetterAuthSessionGuard`/`JwtAuthStrategy` phía
 * HTTP: địa chỉ thuộc trung tâm ở kho riêng thì mọi lượt đọc danh
 * tính của handshake đó — phiên, tài khoản và tenant mặc định của
 * đường cookie; lượt tra tài khoản của đường token — đều chạy
 * trong CHÍNH kho của trung tâm qua `withSpaceDatabase`. Sau khi
 * một trung tâm lật định tuyến, phiên/tài khoản của thành viên chỉ
 * còn tồn tại ở kho riêng: đọc ở kho chung sẽ không thấy gì và
 * realtime chết lặng trong khi REST vẫn chạy trên kho riêng. Lỗi
 * phân giải/chuẩn bị kho đích ném ra nguyên trạng để gateway ngắt
 * kết nối kèm log — fail-closed, tuyệt đối không rơi lặng về đường
 * kho chung; đây là điểm khác guard HTTP, vì guard còn lớp JWT phía
 * sau quyết định lại còn kênh socket thì không có lớp thứ hai.
 *
 * Một tổ hợp mà hàm phân giải dùng chung cố ý trả `null` cần chốt
 * riêng ở lớp này: tầng định tuyến CHƯA CẤU HÌNH
 * (`space_routing.not_configured`) được `resolveDedicatedSpace` xếp
 * vào đường kho chung cùng slug chưa đăng ký và trung tâm kho
 * chung, theo hợp đồng "chưa cấu hình thì app chạy như trước" của
 * tầng chiến lược xác thực. Phía HTTP, `SpaceContextGuard` là lớp
 * thứ hai phân biệt tổ hợp đó bằng `resolveTarget` trực tiếp:
 * phiên mang claim `centre_id` mà định tuyến chưa cấu hình thì
 * fail-closed, phiên không mang claim thì cho qua. Kênh socket
 * không có lớp thứ hai đó, nên `authenticateHandshake` tự phân
 * biệt lại bằng `resolveTarget` trên slug ứng viên và mang cờ
 * "chưa cấu hình" vào đường token: token mang claim `centre_id`
 * bị từ chối TRƯỚC mọi lượt đọc tài khoản ở kho chung; token
 * không claim và đường cookie giữ nguyên hành vi cho qua như cũ.
 *
 * Gateway, consumer và tầng phân phối không biết gì về cơ chế bên
 * dưới — chúng chỉ nhận `MessagingSocketIdentity | null`.
 */
@Injectable()
export class MessagingSocketAuth {
  private readonly jwt: JwtService;

  constructor(
    @Inject(ConfigService) config: ConfigService,
    private readonly users: UsersService,
    private readonly betterAuth: BetterAuthService,
    private readonly repo: MessagingRepository,
    private readonly spaceDb: SpaceDatabaseService,
    private readonly tenants: TenantsService,
  ) {
    this.jwt = new JwtService({ secret: config.getOrThrow<string>('JWT_SECRET') });
  }

  /**
   * Xác thực toàn bộ handshake: phân giải không gian từ `Host`
   * trước, rồi thử cookie phiên Better Auth, không chốt được danh
   * tính thì thử token mang theo handshake. Null nghĩa là cả hai
   * đường đều không dùng được — gateway ngắt kết nối ngay, không
   * lộ lý do ra client.
   *
   * Bước chuẩn bị kho đích (`getDatabaseForSpace`) chạy tại đây,
   * trước cả hai đường, đúng bước PREPARE của khung định tuyến:
   * lỗi phân giải/chuẩn bị ném ra ngoài (gateway ngắt kết nối kèm
   * log) thay vì được nuốt thành null — một handshake thuộc trung
   * tâm kho riêng không bao giờ được phục vụ lặng lẽ từ kho chung.
   *
   * Khi phân giải trả `null` nhưng địa chỉ vẫn mang slug ứng
   * viên, bước này phân biệt lại lý do qua `resolveTarget` (xem
   * `isRoutingNotConfiguredForHost`): chỉ tổ hợp "tầng định tuyến
   * chưa cấu hình" mới sinh cờ truyền xuống đường token; slug
   * chưa đăng ký và trung tâm kho chung giữ nguyên đường kho
   * chung như cũ.
   */
  async authenticateHandshake(handshake: MessagingHandshake): Promise<MessagingSocketIdentity | null> {
    const space = await resolveDedicatedSpace(this.spaceDb, handshake.headers['host']);
    if (space) await this.spaceDb.getDatabaseForSpace(space.slug);
    const routingNotConfigured = space ? false : await this.isRoutingNotConfiguredForHost(handshake.headers['host']);
    const viaCookie = await this.authenticateCookie(handshake.headers, space);
    if (viaCookie) return viaCookie;
    return this.authenticate(extractHandshakeToken(handshake), space, routingNotConfigured);
  }

  /**
   * Phân biệt lý do phân giải không gian trả `null` cho một địa
   * chỉ mang slug ứng viên: tầng định tuyến chưa cấu hình
   * (`space_routing.not_configured`) hay các trường hợp đường kho
   * chung thông thường (slug chưa đăng ký, trung tâm ở chế độ kho
   * chung).
   *
   * `resolveDedicatedSpace` cố ý gộp cả ba trường hợp thành
   * `null` cho tầng chiến lược xác thực dùng chung với HTTP, nên
   * lớp này gọi lại `resolveTarget` trực tiếp trên slug ứng viên
   * — đúng cách `SpaceContextGuard` phía HTTP phân biệt — thay vì
   * đổi hành vi của helper dùng chung (đổi helper sẽ phá hợp đồng
   * "chưa cấu hình thì app chạy như trước" của mọi đường HTTP
   * trên deployment chưa cấu hình control plane). Lỗi phân giải
   * ngoài hai mã đã biết ném ra nguyên trạng, fail-closed như
   * mọi lỗi phân giải khác của lớp này.
   *
   * @param host - Giá trị header `Host` của handshake.
   * @returns `true` chỉ khi bộ phân giải báo tầng định tuyến chưa
   *   cấu hình cho slug ứng viên của địa chỉ này.
   */
  private async isRoutingNotConfiguredForHost(host: string | string[] | undefined): Promise<boolean> {
    const header = Array.isArray(host) ? host[0] : host;
    const slug = extractSpaceSlugFromHost(header);
    if (!slug) return false;
    try {
      await this.spaceDb.resolveTarget(slug);
      return false;
    } catch (err) {
      if (err instanceof SpaceRoutingError && err.code === 'space_routing.not_configured') return true;
      if (err instanceof SpaceRoutingError && err.code === 'space_routing.space_not_found') return false;
      throw err;
    }
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
   * Khi địa chỉ thuộc trung tâm ở kho riêng (`space` khác null),
   * cả ba lượt đọc — phiên, tài khoản, tenant mặc định — chạy
   * trong kho của trung tâm đó qua `withSpaceDatabase`: phiên
   * Better Auth của thành viên chỉ tồn tại ở kho riêng nên đọc ở
   * kho chung trả rỗng, và phiên chỉ tồn tại ở kho chung mang tới
   * địa chỉ này cũng không được phục vụ lặng lẽ từ kho chung.
   * Lượt suy tenant mặc định vẫn chạy trong ngữ cảnh platform
   * nhưng store ALS PHẢI giữ `spaceSlug` của trung tâm: thay toàn
   * bộ store bằng `{ platform: true }` trần sẽ đánh rơi slug và
   * handle định tuyến rơi về kho chung (đúng lớp lỗi A4 của Phần A
   * đã sửa ở các wrapper phía service).
   */
  async authenticateCookie(
    headers: Record<string, string | string[] | undefined>,
    space?: DedicatedSpace | null,
  ): Promise<MessagingSocketIdentity | null> {
    if (!this.betterAuth.enabled) return null;
    const cookie = headers['cookie'];
    if (typeof cookie !== 'string' || !SESSION_COOKIE_PATTERN.test(cookie)) return null;
    const auth = this.betterAuth.requireAuth();
    const readSession = () => auth.api.getSession({ headers: fromNodeHeaders(headers) });
    let resolved: Awaited<ReturnType<typeof readSession>> = null;
    try {
      resolved = space ? await this.spaceDb.withSpaceDatabase(space.slug, readSession) : await readSession();
    } catch {
      // Cookie hỏng chữ ký/định dạng: coi như không có phiên Better
      // Auth, để đường token quyết định — như BetterAuthSessionGuard.
      return null;
    }
    if (!resolved) return null;
    const readUser = () => this.users.getByIdOrUndefined(resolved.session.userId);
    let user: Awaited<ReturnType<typeof readUser>>;
    try {
      user = space ? await this.spaceDb.withSpaceDatabase(space.slug, readUser) : await readUser();
    } catch {
      // Tài khoản không đọc được trong kho của phiên: không đặt
      // danh tính từ cookie, để đường token quyết định — như
      // BetterAuthSessionGuard phía HTTP.
      return null;
    }
    if (!user || user.suspended || user.deleted) return null;
    const tenantId = space
      ? await this.spaceDb.withSpaceDatabase(space.slug, () =>
          tenantAls.run({ platform: true, spaceSlug: space.slug }, () =>
            this.repo.getUserDefaultTenantId(user.id),
          ),
        )
      : await tenantAls.run({ platform: true }, () => this.repo.getUserDefaultTenantId(user.id));
    return { userId: user.id, username: user.username, tenantId, spaceSlug: space?.slug ?? null };
  }

  /**
   * Xác thực một access token lấy từ handshake của socket. Trả null
   * cho mọi trường hợp không hợp lệ (thiếu token, sai chữ ký, hết hạn,
   * token có scope, thiếu sid, user không còn active) — gateway ngắt
   * kết nối ngay, không lộ lý do ra client.
   *
   * Khi địa chỉ thuộc trung tâm ở kho riêng (`space` khác null),
   * đường token áp đúng nguyên tắc cổng 1a/1b của Phần A như
   * `JwtAuthStrategy` + `SpaceContextGuard` phía HTTP:
   * - Token mang claim `centre_id` lệch định danh của trung tâm
   *   tại địa chỉ → từ chối TRƯỚC khi chạm vào kho đích (không tra
   *   kho nào để khẳng định thêm); claim khớp thì tài khoản tra
   *   trong CHÍNH kho của trung tâm đó.
   * - Token KHÔNG mang claim `centre_id` là phiên cấp trước khi
   *   trung tâm tách kho → từ chối fail-closed, chủ phiên phải
   *   đăng nhập lại tại địa chỉ của trung tâm để nhận phiên mang
   *   claim. Ngoại lệ duy nhất giữ nguyên khuôn chiến lược JWT:
   *   phiên vận hành platform (mang `tid` của tenant platform,
   *   không mang claim) tra ở kho chung như cũ — quản trị viên
   *   platform không có tài khoản trong kho riêng, và danh tính
   *   của đường này thuộc kho chung nên `spaceSlug` trả về null.
   *
   * Khi `routingNotConfigured` bật (địa chỉ mang slug ứng viên
   * nhưng tầng định tuyến chưa cấu hình — xem
   * `isRoutingNotConfiguredForHost`), token mang claim
   * `centre_id` là bằng chứng phiên thuộc trung tâm kho riêng:
   * deployment đang phục vụ mà không tra được sổ đăng ký là lỗi
   * vận hành, nên từ chối TRƯỚC mọi lượt đọc tài khoản ở kho
   * chung, đúng chốt của `SpaceContextGuard` phía HTTP. Token
   * không mang claim giữ nguyên đường kho chung như cũ.
   */
  async authenticate(
    token: string | undefined,
    space?: DedicatedSpace | null,
    routingNotConfigured = false,
  ): Promise<MessagingSocketIdentity | null> {
    if (!token) return null;
    let payload: { sub?: string; username?: string; scope?: unknown; sid?: unknown; tid?: unknown; centre_id?: unknown };
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      return null;
    }
    // Cùng luật với JwtAuthStrategy phía REST: chỉ access token đăng
    // nhập (không scope) gắn với một phiên (sid) mới được chấp nhận.
    if (!payload.sub || payload.scope !== undefined || typeof payload.sid !== 'string') return null;
    // Chốt fail-closed cho tổ hợp "định tuyến chưa cấu hình +
    // claim centre_id" (khớp SpaceContextGuard): claim là bằng
    // chứng phiên thuộc trung tâm kho riêng, không được rơi
    // xuống lượt tra tài khoản ở kho chung ngay dưới đây.
    if (routingNotConfigured && payload.centre_id !== undefined) return null;
    const sub = payload.sub;
    const tid = typeof payload.tid === 'string' ? payload.tid : undefined;
    let user: Awaited<ReturnType<typeof this.users.getByIdOrUndefined>>;
    let resolvedInSpace = false;
    if (space) {
      if (payload.centre_id !== undefined) {
        if (payload.centre_id !== space.spaceId) return null;
        user = await this.spaceDb.withSpaceDatabase(space.slug, () => this.users.getByIdOrUndefined(sub));
        resolvedInSpace = true;
      } else if (tid !== undefined && tid === (await this.tenants.platformTenant()).id) {
        user = await this.users.getByIdOrUndefined(sub);
      } else {
        return null;
      }
    } else {
      user = await this.users.getByIdOrUndefined(sub);
    }
    if (!user || user.suspended || user.deleted) return null;
    return {
      userId: user.id,
      username: user.username,
      tenantId: tid ?? null,
      spaceSlug: resolvedInSpace ? space!.slug : null,
    };
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
