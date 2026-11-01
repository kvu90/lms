import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATED_VIA_BETTER_AUTH } from '../../common/better-auth-session.guard';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import { SpaceRoutingError, type ResolvedSpaceConnection } from '../../db/routing/space-connection-resolver';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { SKIP_SPACE_CONTEXT_KEY } from './skip-space-context.decorator';
import { extractSpaceSlugFromHost } from './space-resolution';
import { tenantAls } from './tenant-als';
import { TenantsRepository } from '@lms/db/repositories/tenants';

/**
 * SpaceContextGuard (issue #582): gắn ngữ cảnh trung tâm vào
 * request. Guard chạy ngay sau `TenantGuard` (tenant hiệu lực đã
 * được kiểm chứng và ghim ở `request.tenantId`) và trước
 * `CapabilityGuard`, theo chuỗi bước sau:
 *
 * 1. Trích slug ứng viên từ địa chỉ (`Host`) của request theo quy
 *    ước tên miền con (xem `space-resolution.ts`). Địa chỉ không
 *    mang trung tâm → request đi đúng đường hiện tại, guard không
 *    chạm gì thêm.
 * 2. Phân giải ứng viên qua khung định tuyến (bộ đệm của khung đọc
 *    sổ đăng ký control plane). Slug chưa đăng ký → địa chỉ không
 *    thuộc trung tâm nào trong sổ: request vẫn đi đường hiện tại.
 *    Tầng định tuyến chưa được cấu hình (không có control plane)
 *    thì cho qua như địa chỉ thường KHI phiên không mang claim
 *    `centre_id` — giữ hợp đồng "chưa cấu hình thì app chạy như
 *    trước" của đợt khung; NHƯNG phiên mang claim `centre_id` là
 *    bằng chứng traffic thuộc trung tâm kho riêng, nên ở trường
 *    hợp đó tầng chưa cấu hình là lỗi vận hành ở deployment đang
 *    phục vụ kho riêng và guard fail-closed (ném lỗi ra) thay vì
 *    cho qua lặng lẽ. Mọi lỗi phân giải còn lại (bí mật/role của
 *    kho riêng lệch sổ) là lỗi cấu hình vận hành: ném ra nguyên
 *    trạng, fail-closed, thay vì im lặng phục vụ request bằng kho
 *    chung.
 * 3. Đường vận hành platform tường minh được miễn toàn bộ các bước
 *    sau: request mà tenant hiệu lực là tenant platform
 *    (tenant-zero) và người dùng là quản trị viên của site chính
 *    (`isSiteAdmin`) là đường vận hành hệ thống có sẵn — nó không
 *    bị chặn bởi trạng thái trung tâm, không bị đối chiếu token,
 *    và không bị ghim vào kho của trung tâm, vì vận hành phải còn
 *    vào được trung tâm đang bị đình chỉ để xử lý.
 * 4. Trung tâm chưa ở trạng thái `active` (đang cấp phát, bị đình
 *    chỉ hoặc đã đóng) → từ chối traffic nghiệp vụ bằng 403
 *    `space.not_active` kèm trạng thái trong thông điệp; dữ kiện
 *    của trung tâm không bị đụng tới.
 * 5. Trung tâm ở kho riêng: phiên phải thuộc đúng trung tâm này.
 *    Access token của phiên ở kho riêng mang claim `centre_id`
 *    (định danh đăng ký của trung tâm mà tenant hiệu lực của phiên
 *    thuộc về — cấp ở khâu phát hành token); claim lệch định danh
 *    của trung tâm tại địa chỉ → 401 `auth.centre_mismatch`, và
 *    việc từ chối xảy ra TẠI ĐÂY — trước bước chuẩn bị ở bước 6 —
 *    nên request bị từ chối không mở bất kỳ kết nối nào tới kho
 *    của trung tâm tại địa chỉ. Hai đường không mang claim được
 *    xử lý khác nhau (Phần A, issue #587 — bất biến A1):
 *    - Đường JWT (không có dấu phiên cookie): token cấp trước khi
 *      claim `centre_id` tồn tại — tức phiên cũ phát hành trước
 *      khi trung tâm chuyển kho — bị từ chối 401
 *      `auth.centre_mismatch` ngay, KHÔNG được cho qua theo slug
 *      khớp; chủ phiên phải đăng nhập lại tại địa chỉ của trung
 *      tâm để nhận phiên mang claim.
 *    - Đường cookie Better Auth (request mang dấu
 *      `authenticatedViaBetterAuth` do `BetterAuthSessionGuard`
 *      đặt): phiên cookie không mang claim theo thiết kế, nên
 *      vẫn được đối chiếu bằng tenant hiệu lực mà `TenantGuard`
 *      đã kiểm chứng trong CHÍNH kho riêng: slug của tenant đó
 *      phải đúng slug của địa chỉ.
 * 6. Bước CHUẨN BỊ theo hợp đồng của khung (issue #581): gọi
 *    `getDatabaseForSpace(slug)` để phân giải + mở pool của kho
 *    đích TRƯỚC khi request được xử lý, rồi ghim slug lên
 *    `request.spaceSlug` — `TenantContextInterceptor` đọc lại từ
 *    đây và nạp vào ngữ cảnh ALS quanh handler, để handle định
 *    tuyến ở tầng dữ kiện chọn đúng kho cho mọi truy vấn của
 *    request. Trung tâm ở kho chung: bước chuẩn bị trả handle kho
 *    chung và hành vi của request giữ nguyên như hiện tại. Slug
 *    cũng được hợp vào ngữ cảnh ALS đang có mặt (nếu có) để các
 *    guard chạy sau trong cùng pha guard đọc dữ kiện qua đúng kho.
 */
@Injectable()
export class SpaceContextGuard implements CanActivate {
  constructor(
    private readonly spaceDb: SpaceDatabaseService,
    private readonly repo: TenantsRepository,
    private readonly evaluator: PermissionEvaluator,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    // Route tự gắn trung tâm (nhận diện công khai, kích hoạt lời
    // mời — issue #583): handler tự phân giải slug, chuẩn bị kho và
    // đọc/ghi trong ngữ cảnh ALS của kho đó, nên guard không ghim
    // thêm ở đây — nếu không, request ẩn danh ở địa chỉ trung tâm
    // đã bị 401 `auth.centre_mismatch` trước khi tới được handler
    // (trang đăng nhập không đọc được tên/logo, lời mời không kích
    // hoạt được). Bỏ qua guard KHÔNG có nghĩa là bỏ qua gắn trung
    // tâm: handler vẫn bắt buộc gắn đúng kho trước mọi truy vấn.
    if (this.reflector.getAllAndOverride<boolean>(SKIP_SPACE_CONTEXT_KEY, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      tenantId?: string;
      spaceSlug?: string;
      headers: Record<string, string | string[] | undefined>;
      [AUTHENTICATED_VIA_BETTER_AUTH]?: boolean;
    }>();
    const hostHeader = request.headers?.host;
    const slug = extractSpaceSlugFromHost(Array.isArray(hostHeader) ? hostHeader[0] : hostHeader);
    if (!slug) return true;

    let target: ResolvedSpaceConnection;
    try {
      target = await this.spaceDb.resolveTarget(slug);
    } catch (err) {
      if (err instanceof SpaceRoutingError && err.code === 'space_routing.space_not_found') {
        return true;
      }
      if (err instanceof SpaceRoutingError && err.code === 'space_routing.not_configured') {
        // Phiên mang claim `centre_id` là bằng chứng traffic thuộc
        // trung tâm kho riêng: tầng định tuyến chưa cấu hình ở
        // deployment đang phục vụ kho riêng là lỗi vận hành, phải
        // fail-closed thay vì cho qua lặng lẽ sang kho chung.
        // Phiên không mang claim giữ hợp đồng "chưa cấu hình thì
        // app chạy như trước" của đợt khung.
        if (request.user?.centreId !== undefined) {
          throw err;
        }
        return true;
      }
      throw err;
    }

    // Các tra cứu phục vụ quyết định miễn trừ chạy trong ngữ cảnh
    // platform tường minh như chính TenantGuard: ngoài ngữ cảnh
    // platform, RLS fail-closed giấu các dòng tenant/membership
    // của trung tâm khác.
    const platformExempt = await tenantAls.run({ platform: true }, async () => {
      const user = request.user;
      if (!user || !request.tenantId) return false;
      const platformTenant = await this.repo.getPlatformTenant();
      if (!platformTenant || request.tenantId !== platformTenant.id) return false;
      return this.evaluator.isSiteAdmin(user.id);
    });
    if (platformExempt) return true;

    if (target.status !== 'active') {
      throw new ForbiddenException({
        message: `Space ${slug} is ${target.status}`,
        code: 'space.not_active',
      });
    }

    const user = request.user;
    if (target.mode === 'dedicated' && user) {
      if (user.centreId !== undefined) {
        if (user.centreId !== target.spaceId) {
          throw new UnauthorizedException({
            message: 'Access token was issued for a different centre',
            code: 'auth.centre_mismatch',
          });
        }
      } else if (request[AUTHENTICATED_VIA_BETTER_AUTH]) {
        // Đường cookie Better Auth không mang claim theo thiết kế:
        // đối chiếu bằng tenant hiệu lực đã được TenantGuard kiểm
        // chứng trong CHÍNH kho riêng — tenant của phiên phải chính
        // là tenant mang slug của địa chỉ này. PHẢI đọc qua
        // `withSpaceDatabase(slug)`: đọc trong ngữ cảnh platform
        // không mang slug sẽ rơi về kho chung, nơi tenant chỉ sống
        // ở kho riêng không tồn tại, và từ chối oan phiên cookie
        // hợp lệ tại chính địa chỉ của trung tâm đó (lỗi A2).
        const tenantId = request.tenantId;
        // Lượt đọc tenant PHẢI mang tenantId mà TenantGuard đã kiểm
        // chứng làm GUC của kho đích: chính sách RLS của bảng
        // `tenants` chỉ cho thấy dòng khi `app.platform = 'on'`
        // hoặc `app.tenant_id` đúng id của dòng — đọc trong ngữ
        // cảnh chỉ có slug (không tenant) bị RLS giấu sạch dòng và
        // từ chối oan mọi phiên cookie hợp lệ tại địa chỉ của
        // chính trung tâm đó (lỗi A2). Truyền tenantId không nới
        // cổng: giá trị này đã qua kiểm membership trong kho riêng
        // ở TenantGuard, và phép đối chiếu slug ngay dưới đây mới
        // là quyết định cho phép.
        const effectiveTenant = tenantId
          ? await this.spaceDb.withSpaceDatabase(
              slug,
              () => this.repo.getTenant(tenantId),
              { tenantId },
            )
          : undefined;
        if (!effectiveTenant || effectiveTenant.slug !== slug) {
          throw new UnauthorizedException({
            message: 'Session is not bound to the centre at this address',
            code: 'auth.centre_mismatch',
          });
        }
      } else {
        // Đường JWT không mang claim `centre_id`: đây là phiên cũ
        // phát hành trước khi trung tâm chuyển kho (bất biến A1,
        // Phần A issue #587) — từ chối fail-closed ngay, không cho
        // qua theo slug khớp như đường cookie; chủ phiên phải đăng
        // nhập lại tại địa chỉ của trung tâm để nhận phiên mới.
        throw new UnauthorizedException({
          message: 'Access token carries no centre claim for this dedicated centre; sign in again at this centre address',
          code: 'auth.centre_mismatch',
        });
      }
    }

    // Bước chuẩn bị (PREPARE) của khung định tuyến: phân giải đích
    // + mở pool của kho đích phải xong trước khi handler chạy, vì
    // đường đồng bộ của handle định tuyến chỉ tra bảng đã-chuẩn-bị.
    await this.spaceDb.getDatabaseForSpace(slug);
    request.spaceSlug = slug;
    const store = tenantAls.getStore();
    if (store && !store.spaceSlug) {
      tenantAls.enterWith({ ...store, spaceSlug: slug });
    }
    return true;
  }
}
