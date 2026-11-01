import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { BetterAuthService } from '../modules/auth/better-auth/better-auth.service';
import { BETTER_AUTH_SESSION_COOKIE } from '../modules/auth/better-auth/better-auth.instance';
import { SpaceDatabaseService } from '../db/routing/space-database.service';
import { resolveDedicatedSpace } from '../modules/tenants/space-resolution';
import { UsersService } from '../modules/users/users.service';
import type { AuthenticatedUser } from './current-user.decorator';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Dấu hiệu trên request: danh tính đã được guard này xác lập từ phiên
 * Better Auth — JwtAuthGuard nhìn thấy dấu này thì bỏ qua, không đòi
 * Bearer token nữa (xem jwt-auth.guard.ts).
 */
export const AUTHENTICATED_VIA_BETTER_AUTH = 'authenticatedViaBetterAuth';

interface BetterAuthRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  [AUTHENTICATED_VIA_BETTER_AUTH]?: boolean;
}

const SESSION_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)(?:__Secure-)?${BETTER_AUTH_SESSION_COOKIE}=`);

/**
 * Guard mỏng của Better Auth (issue #7, Giai đoạn 1) — chạy toàn cục
 * TRƯỚC JwtAuthGuard và chỉ làm một việc: dịch cookie phiên Better Auth
 * thành đúng interface `AuthenticatedUser { id, username, sessionId }`
 * mà tầng authz và mọi service nghiệp vụ đang dùng, nên không một dòng
 * authz nào phải sửa.
 *
 * Nguyên tắc không đổi hành vi cũ:
 * - Cờ Better Auth tắt → trả true ngay, như không tồn tại.
 * - Request không mang cookie phiên Better Auth → trả true, JwtAuthGuard
 *   xử lý như hiện tại (kể cả việc ném 401).
 * - Cookie có nhưng phiên không hợp lệ/hết hạn → cũng trả true và KHÔNG
 *   đặt danh tính: quyết định từ chối vẫn thuộc về JwtAuthGuard như cũ.
 * - Phiên hợp lệ nhưng tài khoản bị suspended/deleted → không đặt danh
 *   tính (chặn dù phiên còn hạn, cùng semantics với JwtStrategy).
 *
 * `sessionId` ở đây là id của dòng phiên trong bảng `session` của
 * Better Auth — cùng vai trò `sid` của hệ JWT hiện tại.
 *
 * Đường kho riêng (Phần A, issue #587 — A2): guard chạy TRƯỚC mọi
 * guard ghim trung tâm nên tự phân giải không gian từ địa chỉ
 * request như `JwtAuthStrategy`: địa chỉ thuộc trung tâm ở kho
 * riêng thì phiên VÀ tài khoản đều phải đọc từ CHÍNH kho của trung
 * tâm đó (`withSpaceDatabase` chuẩn bị pool + bọc ALS cho cả hai
 * lượt đọc — handle định tuyến của app uỷ thác theo slug của ngữ
 * cảnh nên cùng một lời gọi `getSession`/`getByIdOrUndefined` đọc
 * đúng kho đích). Tài khoản chỉ tồn tại ở kho riêng vì vậy qua
 * được guard này tại địa chỉ của chính trung tâm đó, với cùng tập
 * bảo đảm như đường JWT (phiên/tài khoản tra trong kho riêng,
 * `TenantGuard` kiểm membership trong kho riêng,
 * `SpaceContextGuard` đối chiếu slug cho đường cookie). Địa chỉ
 * còn lại giữ nguyên hành vi cũ (kho chung). Phiên cookie của
 * trung tâm này mang sang địa chỉ khác không đọc được ở kho đó
 * nên rơi về quyết định của đường JWT như phiên không hợp lệ.
 */
@Injectable()
export class BetterAuthSessionGuard {
  constructor(
    private readonly reflector: Reflector,
    private readonly betterAuth: BetterAuthService,
    private readonly users: UsersService,
    private readonly spaceDb: SpaceDatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.betterAuth.enabled) return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<BetterAuthRequest>();
    const cookie = req.headers['cookie'];
    if (typeof cookie !== 'string' || !SESSION_COOKIE_PATTERN.test(cookie)) return true;

    const auth = this.betterAuth.requireAuth();
    let resolved: Awaited<ReturnType<typeof auth.api.getSession>>;
    // Phân giải không gian MỘT lần rồi dùng cho cả hai lượt đọc —
    // cùng khuôn với `JwtAuthStrategy`: địa chỉ không thuộc trung
    // tâm kho riêng nào (địa chỉ thường, trung tâm kho chung, tầng
    // định tuyến chưa cấu hình) trả `null` và giữ nguyên đường kho
    // chung.
    let space: Awaited<ReturnType<typeof resolveDedicatedSpace>>;
    try {
      space = await resolveDedicatedSpace(this.spaceDb, req.headers['host']);
      const readSession = () => auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      resolved = space
        ? await this.spaceDb.withSpaceDatabase(space.slug, readSession)
        : await readSession();
    } catch {
      // Cookie hỏng chữ ký/định dạng, hoặc kho riêng không mở
      // được: coi như không có phiên Better Auth, để đường JWT
      // hiện tại quyết định như trước đến nay (route có bảo vệ
      // vẫn 401 khi không có Bearer — không rò rỉ danh tính).
      return true;
    }
    if (!resolved) return true;
    const sessionUserId = resolved.session.userId;

    // Tài khoản đọc từ CÙNG kho với phiên: phiên ở kho riêng mà
    // tra tài khoản ở kho chung sẽ từ chối oan tài khoản chỉ sống
    // ở kho riêng — đúng lỗi A2 đặt ra phải sửa.
    let user: Awaited<ReturnType<typeof this.users.getByIdOrUndefined>>;
    try {
      user = space
        ? await this.spaceDb.withSpaceDatabase(space.slug, () =>
            this.users.getByIdOrUndefined(sessionUserId),
          )
        : await this.users.getByIdOrUndefined(sessionUserId);
    } catch {
      return true;
    }
    if (!user || user.deleted || user.suspended) return true;

    req.user = { id: user.id, username: user.username, sessionId: resolved.session.id };
    req[AUTHENTICATED_VIA_BETTER_AUTH] = true;
    return true;
  }
}
