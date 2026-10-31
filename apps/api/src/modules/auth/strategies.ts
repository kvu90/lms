import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { ExtractJwt, Strategy as JwtStrategy } from 'passport-jwt';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { resolveDedicatedSpace } from '../tenants/space-resolution';
import { TenantsService } from '../tenants/tenants.service';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';

/**
 * Yêu cầu tối thiểu của request mà hai chiến lược dưới đây cần để
 * phân giải không gian kho riêng: chỉ header `Host` (địa chỉ trung
 * tâm là tên miền con mang slug, xem `space-resolution.ts`).
 */
interface SpaceAwareRequest {
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * GĐ5 (issue #7): ngoại lệ token-qua-query cho stream SSE ĐÃ GỠ.
 * Từ cutover phiên cookie, EventSource cùng nguồn tự gửi cookie
 * phiên và chuỗi guard (BetterAuthSessionGuard → JwtAuthGuard)
 * xác thực như mọi route — không còn lý do cho token trong URL
 * (rò rỉ qua log/history). Access token chỉ còn qua header
 * Authorization Bearer, như mọi route khác.
 */

@Injectable()
/**
 * Chiến lược xác thực cục bộ (username + mật khẩu) cho các guard cần kiểm tra thông tin đăng nhập trực tiếp.
 *
 * Đường kho riêng (issue #584): chiến lược chạy ở pha guard, TRƯỚC
 * interceptor bọc ALS quanh handler — nên không thể trông vào ngữ
 * cảnh ALS để biết request thuộc kho nào. Chiến lược vì vậy tự
 * phân giải không gian từ địa chỉ request trước khi kiểm chứng:
 * địa chỉ thuộc trung tâm ở kho riêng thì kiểm chứng thông tin
 * đăng nhập CHỈ trong kho của trung tâm đó (`withSpaceDatabase`
 * vừa chuẩn bị pool vừa bọc ALS cho lần tra cứu); địa chỉ còn lại
 * giữ nguyên hành vi cũ (kho chung). Tài khoản chỉ tồn tại ở kho
 * chung vì vậy không đăng nhập được tại địa chỉ kho riêng và ngược
 * lại — không có đường "một tài khoản vào mọi trung tâm".
 */
export class LocalAuthStrategy extends PassportStrategy(LocalStrategy, 'local') {
  constructor(
    private readonly auth: AuthService,
    private readonly spaceDb: SpaceDatabaseService,
  ) {
    super({ passReqToCallback: true });
  }
  async validate(
    req: SpaceAwareRequest,
    username: string,
    password: string,
  ): Promise<{ id: string; username: string }> {
    const space = await resolveDedicatedSpace(this.spaceDb, req.headers?.host);
    const user = space
      ? await this.spaceDb.withSpaceDatabase(space.slug, () => this.auth.validateCredentials(username, password))
      : await this.auth.validateCredentials(username, password);
    return { id: user.id, username: user.username };
  }
}

export interface JwtPayload { sub: string; username: string; sid: string; scope?: string; /** Tenant hiệu lực của phiên (TENANT-0, #168). */ tid?: string; /** Định danh đăng ký của trung tâm ở kho riêng mà phiên thuộc về (issue #582); vắng mặt khi tenant hiệu lực ở kho chung. */ centre_id?: string; /** Audience của token (issue #584): `platform` cho token của bề mặt đăng nhập quản trị platform, vắng mặt cho token nghiệp vụ thường. */ aud?: string }

@Injectable()
/**
 * Chiến lược JWT: giải mã access token và dựng principal cho request (id, username, cờ site admin).
 *
 * Đường kho riêng (issue #584): cùng lý do như chiến lược local —
 * chiến lược chạy ở pha guard nên tự phân giải không gian từ địa
 * chỉ request trước khi tra tài khoản. Địa chỉ thuộc trung tâm ở
 * kho riêng thì tài khoản phải tồn tại TRONG kho của trung tâm đó
 * mới được dựng principal; tra ở kho chung sẽ từ chối oan tài
 * khoản chỉ sống ở kho riêng. Hai ngoại lệ giữ hành vi của issue
 * #582, đều kiểm TRƯỚC khi chạm vào kho đích nên không mở kết
 * nối nào tới kho đó:
 * - Token mang claim `centre_id` lệch với trung tâm tại địa chỉ
 *   bị từ chối 401 `auth.centre_mismatch` ngay (không tra kho
 *   đích để khẳng định thêm).
 * - Phiên mang `tid` của tenant platform (đường vận hành platform
 *   của quản trị viên site chính) tra ở kho chung như cũ — quản
 *   trị platform không có tài khoản trong kho riêng, và chốt
 *   chặn cuối cho đường này vẫn là `SpaceContextGuard` (miễn trừ
 *   chỉ khi user là site admin).
 * Việc đối chiếu phiên với trung tâm tại địa chỉ cho các trường
 * hợp còn lại vẫn thuộc về `SpaceContextGuard` chạy sau, như trước.
 */
export class JwtAuthStrategy extends PassportStrategy(JwtStrategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly users: UsersService,
    private readonly spaceDb: SpaceDatabaseService,
    private readonly tenants: TenantsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
      passReqToCallback: true,
    });
  }
  /** Chỉ danh tính — và tài khoản phải còn đang hoạt động: token của người dùng bị đình chỉ/đã xoá sẽ chết tại đây. */
  async validate(req: SpaceAwareRequest, payload: JwtPayload): Promise<AuthenticatedUser> {
    // Challenge token của bước MFA (scope 'mfa_challenge', không có sid
    // phiên) chỉ dùng được cho POST /auth/mfa/verify — không phải access
    // token nên bị từ chối ở mọi route thường.
    if (payload.scope !== undefined || !payload.sid) {
      throw new UnauthorizedException({ message: 'Token is not an access token', code: 'auth.unauthenticated' });
    }
    const space = await resolveDedicatedSpace(this.spaceDb, req.headers?.host);
    if (space && payload.centre_id !== undefined && payload.centre_id !== space.spaceId) {
      throw new UnauthorizedException({ message: 'Token belongs to another centre', code: 'auth.centre_mismatch' });
    }
    // Đường vận hành platform (issue #582): phiên KHÔNG mang claim
    // `centre_id` và mang `tid` của tenant platform tra ở kho chung —
    // tra trong kho riêng sẽ từ chối oan quản trị platform vốn không
    // có tài khoản ở đó. Điều kiện thiếu claim là bắt buộc: phiên của
    // site chính mang cùng `tid` (dòng tenant platform được sao sang
    // kho riêng giữ nguyên id) NHƯNG mang `centre_id` của site chính,
    // nên nó phải tra ở kho riêng, không được rơi vào nhánh này.
    // Danh tính tenant platform lấy từ cache singleton của
    // repository nên lần tra này rẻ sau lần đầu.
    const isPlatformSession =
      space !== null &&
      payload.tid !== undefined &&
      payload.centre_id === undefined &&
      payload.tid === (await this.tenants.platformTenant()).id;
    const user = space && !isPlatformSession
      ? await this.spaceDb.withSpaceDatabase(space.slug, () => this.users.getByIdOrUndefined(payload.sub))
      : await this.users.getByIdOrUndefined(payload.sub);
    if (!user || user.deleted || user.suspended) {
      throw new UnauthorizedException({ message: 'Account is not active', code: 'auth.account_inactive' });
    }
    return { id: user.id, username: user.username, sessionId: payload.sid, tenantId: payload.tid, centreId: payload.centre_id, audience: payload.aud };
  }
}
