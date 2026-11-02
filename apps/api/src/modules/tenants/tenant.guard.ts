import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { resolveDedicatedSpace } from './space-resolution';
import { TenantsRepository } from '@lms/db/repositories/tenants';
import { tenantAls } from './tenant-als';
import { TenantsService } from './tenants.service';
import { TenantContextService } from './tenant-context.service';

/**
 * TenantGuard (TENANT-0, #168 — hồ sơ mục 4.1): chạy sau JwtAuthGuard,
 * phân giải tenant hiệu lực của request và nạp vào TenantContextService
 * (AsyncLocalStorage qua `enterWith`, nên mọi handler/interceptor chạy
 * sau trong cùng chuỗi request đều thấy). Thứ tự phân giải: claim `tid`
 * của token (đã kiểm chứng: tenant còn active; tenant school/center
 * đòi membership active) → tenant mặc định xác định của user → tenant-
 * zero cho request ẩn danh (không gian công cộng của Trang chính).
 *
 * `tid` trỏ vào tenant đã khoá → 403 `tenant.not_active`; membership đã
 * kết thúc mà token còn hạn → 401 `tenant.membership_inactive` để
 * client đăng nhập lại/chuyển tenant (site admin được rơi về tenant-
 * zero thay vì bị khoá ngoài khỏi hệ thống vận hành của chính mình).
 * `tid` đã khai mà không tra được dòng tenant nào → 401
 * `tenant.unknown`, fail-closed thay vì rơi lặng về tenant-zero
 * (Phần A, issue #587).
 *
 * Đường kho riêng (issue #584): request ở địa chỉ của một trung tâm ở
 * kho riêng KHÔNG đi qua cổng membership của kho chung nữa — tài
 * khoản của trung tâm đó không tồn tại ở kho chung nên cổng cũ sẽ
 * từ chối oan. Nhánh kho riêng phân giải tenant từ CHÍNH kho của
 * trung tâm (dòng tenant mang slug của địa chỉ): tenant đó phải
 * active; tenant school/center đòi membership active TRONG kho riêng
 * (thành viên nội bộ của trung tâm, không nối tới tài khoản toàn
 * cục); tenant kind `platform` (site chính ở kho riêng) mở như
 * tenant-zero của đường chung. Ngoại lệ duy nhất giữ luồng cũ là
 * phiên mang `tid` của tenant platform — đường vận hành platform,
 * để `SpaceContextGuard` miễn trừ sau đó như trước.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly repo: TenantsRepository,
    private readonly tenants: TenantsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly tenantContext: TenantContextService,
    private readonly spaceDb: SpaceDatabaseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HOTFIX #196: guard là khâu THIẾT LẬP ngữ cảnh nên chính các tra cứu
    // của nó (tenant-zero, tenant của claim tid, membership) phải chạy
    // trong ngữ cảnh platform tường minh — ngoài ngữ cảnh, RLS
    // fail-closed giấu sạch bảng tenants/memberships, guard tưởng tenant
    // chưa gieo và cho request chạy KHÔNG ngữ cảnh (chỉ lộ khi app chạy
    // bằng role thường). Ngữ cảnh cho handler vẫn do
    // TenantContextInterceptor bọc lại từ `request.tenantId` như trước.
    return tenantAls.run({ platform: true }, () => this.resolveRequestTenant(context));
  }

  private async resolveRequestTenant(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      tenantId?: string;
      headers: Record<string, string | string[] | undefined>;
    }>();
    // Tenant-zero qua bản cache singleton của repository: danh tính
    // của nó cố định từ lúc bootstrap nên không tra lại xuống DB ở
    // mọi request (xem TenantsRepository.getPlatformTenant).
    const zero = await this.repo.getPlatformTenant();
    // Tenant-zero chưa được gieo (chỉ có thể xảy ra trước bootstrap seed
    // trong các test đơn vị không boot app đầy đủ): không gắn ngữ cảnh.
    if (!zero) return true;
    const user = request.user;
    // Nhánh kho riêng (issue #584): request đã xác thực ở địa chỉ
    // của trung tâm ở kho riêng thì tenant hiệu lực là dòng tenant
    // trong CHÍNH kho của trung tâm đó — không tra kho chung, không
    // đòi membership toàn cục. Phiên vận hành platform (không mang
    // claim `centre_id`, mang `tid` của tenant platform) là đường
    // vận hành platform nên rơi xuống luồng cũ bên dưới; điều kiện
    // thiếu claim là bắt buộc vì phiên của site chính mang cùng
    // `tid` nhưng mang `centre_id` của site chính và phải đi nhánh
    // kho riêng.
    if (user) {
      const space = await resolveDedicatedSpace(this.spaceDb, request.headers?.host);
      const isPlatformSession = user.tenantId !== undefined && user.tenantId === zero.id && user.centreId === undefined;
      if (space && !isPlatformSession) {
        const spaceTenant = await this.spaceDb.withSpaceDatabase(space.slug, () =>
          this.repo.getTenantBySlug(space.slug),
        );
        if (!spaceTenant) {
          throw new UnauthorizedException({
            message: 'Space tenant is not ready in its own store',
            code: 'space.tenant_missing',
          });
        }
        if (spaceTenant.status !== 'active') {
          throw new ForbiddenException({
            message: `Tenant ${spaceTenant.slug} is ${spaceTenant.status}`,
            code: 'tenant.not_active',
          });
        }
        if (spaceTenant.kind !== 'platform') {
          const membership = await this.spaceDb.withSpaceDatabase(space.slug, () =>
            this.repo.getMembership(spaceTenant.id, user.id),
          );
          if (membership?.status !== 'active') {
            throw new UnauthorizedException({
              message: 'Membership in the active tenant is no longer active',
              code: 'tenant.membership_inactive',
            });
          }
        }
        this.tenantContext.enter({ tenantId: spaceTenant.id, userId: user.id });
        // Ghim cả lên request như luồng cũ: interceptor đọc lại từ
        // đây để bọc ALS quanh handler (kèm slug trung tâm do
        // SpaceContextGuard ghim sau đó).
        request.tenantId = spaceTenant.id;
        return true;
      }
    }
    let tenantId = zero.id;
    if (user) {
      if (user.tenantId) {
        const tenant = await this.repo.getTenant(user.tenantId);
        // Bất biến fail-closed (Phần A, issue #587): `tid` đã khai
        // trong phiên mà không tra được dòng tenant nào thì KHÔNG
        // được rơi lặng về tenant platform — phiên đó không gắn
        // được vào trung tâm nào nên bị từ chối rõ ràng ngay tại
        // đây, thay vì chạy tiếp dưới danh tính tenant platform.
        if (!tenant) {
          throw new UnauthorizedException({
            message: 'Tenant declared by the session could not be resolved',
            code: 'tenant.unknown',
          });
        }
        if (tenant.status !== 'active') {
          throw new ForbiddenException({
            message: `Tenant ${tenant.slug} is ${tenant.status}`,
            code: 'tenant.not_active',
          });
        }
        if (tenant.kind === 'platform') {
          tenantId = tenant.id;
        } else {
          const membership = await this.repo.getMembership(tenant.id, user.id);
          if (membership?.status === 'active') {
            tenantId = tenant.id;
          } else if (await this.evaluator.isSiteAdmin(user.id)) {
            tenantId = zero.id;
          } else {
            throw new UnauthorizedException({
              message: 'Membership in the active tenant is no longer active',
              code: 'tenant.membership_inactive',
            });
          }
        }
      } else {
        tenantId = (await this.tenants.resolveDefaultTenant(user.id)).id;
      }
    }
    this.tenantContext.enter({ tenantId, userId: user?.id });
    // Ghim cả lên request: `enterWith` ở guard không sống qua biên
    // guard→handler của Nest (đã kiểm chứng bằng spec #168: handler
    // thấy ALS rỗng), nên TenantContextInterceptor đọc lại từ đây và
    // bọc `run` quanh lúc handler được subscribe mới giữ được ngữ
    // cảnh cho toàn bộ chuỗi xử lý của request.
    request.tenantId = tenantId;
    return true;
  }
}
