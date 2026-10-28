import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/current-user.decorator';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { TenantsRepository } from './tenants.repository';
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
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly repo: TenantsRepository,
    private readonly tenants: TenantsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly tenantContext: TenantContextService,
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
    const request = context.switchToHttp().getRequest<{ user?: AuthenticatedUser; tenantId?: string }>();
    // Tenant-zero qua bản cache singleton của repository: danh tính
    // của nó cố định từ lúc bootstrap nên không tra lại xuống DB ở
    // mọi request (xem TenantsRepository.getPlatformTenant).
    const zero = await this.repo.getPlatformTenant();
    // Tenant-zero chưa được gieo (chỉ có thể xảy ra trước bootstrap seed
    // trong các test đơn vị không boot app đầy đủ): không gắn ngữ cảnh.
    if (!zero) return true;
    const user = request.user;
    let tenantId = zero.id;
    if (user) {
      if (user.tenantId) {
        const tenant = await this.repo.getTenant(user.tenantId);
        if (tenant) {
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
