import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MyTenant, Tenant as TenantDto, TenantMembership as TenantMembershipDto } from '@lms/contracts';
import { ensureActiveTenantMembership } from '@lms/enrol';
import {
  DEFAULT_SCHOOL_TENANT_SLUG,
  PLATFORM_TENANT_SLUG,
  TenantsRepository,
  type TenantMembershipRow,
  type TenantRow,
} from '@lms/db/repositories/tenants';
import type { UserRow } from '@lms/db/repositories/users';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { ControlPlaneRepository } from '@lms/db/repositories/control-plane';
import { PlanLimitsService } from '../access/plan-limits.service';
import { UsersService } from '../users/users.service';
import { OutboxService } from '../../infra/events/outbox.service';
import { tenantAls } from './tenant-als';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingError } from '../../db/routing/space-connection-resolver';
import type {
  AddTenantMemberDto,
  CreateTenantDto,
  CreateTenantUserDto,
  UpdateTenantDto,
} from './dto/tenants.dto';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

export function toTenantDto(row: TenantRow): TenantDto {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as TenantDto['kind'],
    status: row.status as TenantDto['status'],
    plan: row.plan,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toMembershipDto(row: TenantMembershipRow): TenantMembershipDto {
  return {
    id: row.id,
    tenantId: row.tenantId,
    userId: row.userId,
    status: row.status as TenantMembershipDto['status'],
    joinedAt: row.joinedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
  };
}

/**
 * Hình chiếu hồ sơ người dùng cho bề mặt tenant (`GET
 * /tenants/:tenantId/users` và đáp ứng của `POST
 * /tenants/:tenantId/users`): đúng 7 trường mà phía tiêu thụ (giao
 * diện quản trị tenant) cần để ghép hồ sơ với membership — định danh,
 * tên hiển thị, email và hai cờ trạng thái tài khoản.
 */
export interface TenantUserView {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  suspended: boolean;
  deleted: boolean;
}

/**
 * Chiếu một dòng `users` đầy đủ thành `TenantUserView`.
 *
 * Lý do tồn tại của hàm chiếu này: dòng `users` (kiểu `UserRow`) chứa
 * `passwordHash` và nhiều trường nội bộ (`emailVerified`, `image`,
 * `forcePasswordChange`, `isGuest`, `lastLogin`, mốc thời gian) chỉ
 * được phép sống ở tầng nội bộ (xác thực, phân giải quyền). Mọi đáp
 * ứng HTTP của bề mặt tenant PHẢI đi qua hàm chiếu tường minh này —
 * trả nguyên dòng sẽ phơi bày băm mật khẩu của mọi thành viên tenant
 * cho bất kỳ ai có quyền xem tenant (vấn đề đã ghi tại issue của đợt
 * sửa này). Danh sách trường ở đây phải khớp đúng tập trường phía
 * tiêu thụ khai báo; cần thêm trường thì thêm tường minh tại đây kèm
 * cập nhật test e2e khẳng định hình dạng đáp ứng.
 */
export function toTenantUserView(row: UserRow): TenantUserView {
  return {
    id: row.id,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    suspended: row.suspended,
    deleted: row.deleted,
  };
}

/**
 * TenantsService — vòng đời tenant + membership (TENANT-0, #168; hồ sơ
 * mục 2, 4, 6.2). Nguyên tắc cứng đã chốt: tenant CHỈ do
 * platform admin tạo khi khách đăng ký gói tổ chức — KHÔNG có đường tự
 * tạo tenant, KHÔNG tự đăng ký thành giáo viên ở platform; học sinh ở
 * Trang chính được tự đăng ký (luồng đăng ký hiện hữu cho ra học sinh ở
 * tenant-zero), giáo viên ở platform chỉ qua admin nâng hoặc tự nâng
 * khi thanh toán gói giáo viên tự do (TENANT-4 cưỡng chế gói).
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly repo: TenantsRepository,
    private readonly contexts: ContextsService,
    private readonly evaluator: PermissionEvaluator,
    private readonly users: UsersService,
    private readonly outbox: OutboxService,
    private readonly planLimits: PlanLimitsService,
    private readonly spaceDb: SpaceDatabaseService,
    private readonly directory: ControlPlaneRepository,
  ) {}

  // --- tenant-zero + hàm hỗ trợ seed ------------------------------------------

  /**
   * Tenant-zero (Trang chính); ném lỗi khi chưa được gieo — bootstrap seed luôn tạo trước mọi request.
   *
   * HOTFIX #196: tra cứu này là đường HỆ THỐNG (đăng nhập/guard chạy
   * trước khi có ngữ cảnh tenant) nên phải chạy trong ngữ cảnh platform
   * tường minh — ngoài ngữ cảnh, RLS fail-closed giấu sạch bảng tenants
   * và mọi request tiền-đăng-nhập chết `tenant.platform_missing` dù seed
   * đã gieo (chỉ lộ khi app chạy bằng role thường, test superuser mù).
   */
  async platformTenant(): Promise<TenantRow> {
    return tenantAls.run({ platform: true }, () => this.platformTenantInContext());
  }

  private async platformTenantInContext(): Promise<TenantRow> {
    const zero = await this.repo.getTenantBySlug(PLATFORM_TENANT_SLUG);
    if (!zero) throw new NotFoundException({ message: 'Platform tenant (tenant-zero) is not seeded', code: 'tenant.platform_missing' });
    return zero;
  }

  /**
   * Tạo tenant-zero nếu chưa có (idempotent) kèm context tenant của nó.
   *
   * HOTFIX #196 vòng 2: đây là helper HỆ THỐNG của đường seed/bootstrap —
   * tự bọc ngữ cảnh platform thay vì trông vào ngữ cảnh của nơi gọi.
   * Ngoài ngữ cảnh platform, dòng tenant mới (id chưa tồn tại trong
   * `app.tenant_id` của bất kỳ kết nối nào) bị WITH CHECK của RLS chặn
   * 42501 — method này theo thiết kế CHỈ chạy được trong ngữ cảnh
   * platform hoặc bằng superuser, nên ngữ cảnh platform là một phần
   * của chính method, không phải điều kiện tiền lệ ở call-site.
   */
  async ensurePlatformTenant(): Promise<TenantRow> {
    return tenantAls.run({ platform: true }, () => this.ensurePlatformTenantInContext());
  }

  private async ensurePlatformTenantInContext(): Promise<TenantRow> {
    let zero = await this.repo.getTenantBySlug(PLATFORM_TENANT_SLUG);
    if (!zero) {
      zero = await this.repo.insertTenant({
        slug: PLATFORM_TENANT_SLUG,
        name: 'Trang chính',
        kind: 'platform',
        status: 'active',
        plan: null,
      });
    }
    await this.contexts.ensureTenantContext(zero.id);
    return zero;
  }

  /**
   * Tạo tenant trường mặc định nếu chưa có (idempotent) — đường
   * seed/review dùng, KHÔNG phải API tự phục vụ. Cùng lý do với
   * `ensurePlatformTenant`: helper hệ thống, tự bọc ngữ cảnh platform
   * (HOTFIX #196 vòng 2).
   */
  async ensureDefaultSchoolTenant(name: string): Promise<TenantRow> {
    return tenantAls.run({ platform: true }, () => this.ensureDefaultSchoolTenantInContext(name));
  }

  private async ensureDefaultSchoolTenantInContext(name: string): Promise<TenantRow> {
    let tenant = await this.repo.getTenantBySlug(DEFAULT_SCHOOL_TENANT_SLUG);
    if (!tenant) {
      tenant = await this.repo.insertTenant({
        slug: DEFAULT_SCHOOL_TENANT_SLUG,
        name,
        kind: 'school',
        status: 'active',
        plan: null,
      });
    }
    await this.contexts.ensureTenantContext(tenant.id);
    return tenant;
  }

  /**
   * Dòng tenant của một không gian trong CHÍNH kho của nó (đường kho
   * riêng, issue #584): tra bằng slug của không gian — slug của
   * tenant và slug đăng ký của trung tâm là một. Trả `undefined`
   * khi kho riêng chưa có dòng tenant của chính nó (trung tâm đã
   * đăng ký nhưng chưa được cấp phát xong); nơi gọi tự quyết
   * fail-closed thay vì rơi về dòng tenant của kho chung.
   *
   * Tra cứu bọc ngữ cảnh platform tường minh: bảng `tenants` mang
   * RLS theo `app.tenant_id`, mà ngữ cảnh của nơi gọi KHÔNG đáng
   * tin cho việc này — tiêu biểu lúc đăng nhập, handler còn mang
   * tenant-zero do `TenantGuard` gán cho request ẩn danh, nên tra
   * không bọc sẽ bị RLS giấu mất dòng tenant của kho riêng và kết
   * luận sai là "chưa cấp phát xong".
   */
  async getTenantInSpace(slug: string): Promise<TenantRow | undefined> {
    return tenantAls.run({ platform: true }, () =>
      this.spaceDb.withSpaceDatabase(slug, () => this.repo.getTenantBySlug(slug)),
    );
  }

  /**
   * Dòng membership của một user trong CHÍNH kho của một không gian
   * (đường kho riêng, issue #584): cặp (tenant, user) được tra
   * trong kho của không gian đó, tuyệt đối không tra kho chung —
   * dùng cho các chốt fail-closed phải quyết ngay trong kho riêng,
   * điển hình là bước làm mới phiên phải biết membership trong kho
   * còn hiệu lực hay đã kết thúc trước khi cấp token mới. Trả
   * `undefined` khi kho riêng không có dòng membership của cặp
   * này. Tra cứu bọc ngữ cảnh platform và `withSpaceDatabase` theo
   * đúng khuôn của `getTenantInSpace`: bảng membership cũng mang
   * RLS theo tenant và ngữ cảnh của nơi gọi không đáng tin cho
   * việc tra cứu này.
   */
  async getMembershipInSpace(slug: string, tenantId: string, userId: string): Promise<TenantMembershipRow | undefined> {
    return tenantAls.run({ platform: true }, () =>
      this.spaceDb.withSpaceDatabase(slug, () => this.repo.getMembership(tenantId, userId)),
    );
  }

  /**
   * Tra cứu một tenant theo id TRONG ngữ cảnh hiện tại — CỐ Ý không tự
   * bọc platform (HOTFIX #196 vòng 2): đây là hàm dùng chung, call-site
   * thuộc bề mặt dữ liệu của tenant hiệu lực (vd `GET /tenants/current`)
   * phải tôn trọng tầm nhìn RLS của tenant đó; các call-site cấp
   * platform/xuyên tenant (vòng đời, membership, resolveSwitchTarget)
   * tự bọc ngữ cảnh platform ở tầng của chúng trước khi gọi xuống đây.
   * Bọc platform ngay tại hàm này sẽ cho MỌI nơi gọi tầm nhìn xuyên
   * tenant — sai seam.
   */
  async getTenant(id: string): Promise<TenantRow> {
    const row = await this.repo.getTenant(id);
    if (!row) throw new NotFoundException({ message: `Tenant ${id} not found`, code: 'tenant.not_found' });
    return row;
  }

  /**
   * Tenant hiệu lực cho các bề mặt đã phủ khi luồng không có ngữ cảnh
   * request (seed script, job nền): rơi về tenant-zero.
   */
  async fallbackTenantId(): Promise<string> {
    return (await this.platformTenant()).id;
  }

  // --- cổng quyền ------------------------------------------------------------

  private async systemContextId(): Promise<string> {
    return (await this.contexts.ensureSystemContext()).id;
  }

  /** Platform: chỉ người giữ `tenant:manage` tại context HỆ THỐNG (platform admin). */
  async assertPlatformManager(actorId: string): Promise<void> {
    await this.evaluator.requireCapability(actorId, 'tenant:manage', await this.systemContextId());
  }

  /** Quản trị một tenant: manager của chính tenant đó (tại context tenant), hoặc platform manager. */
  async assertTenantManager(actorId: string, tenantId: string): Promise<void> {
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    if (await this.evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id)) return;
    await this.assertPlatformManager(actorId);
  }

  /** Xem một tenant: tenant:viewall/manage tại context tenant, hoặc phía platform. */
  async assertTenantViewer(actorId: string, tenantId: string): Promise<void> {
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    if (
      (await this.evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id)) ||
      (await this.evaluator.hasCapability(actorId, 'tenant:viewall', tenantCtx.id))
    ) return;
    const systemId = await this.systemContextId();
    if (
      (await this.evaluator.hasCapability(actorId, 'tenant:manage', systemId)) ||
      (await this.evaluator.hasCapability(actorId, 'tenant:viewall', systemId))
    ) return;
    throw new ForbiddenException({ message: 'Missing capability tenant:viewall', code: 'access.capability_denied' });
  }

  // --- vòng đời tenant (platform) -------------------------------------------
  //
  // HOTFIX #196 vòng 2 (sự cố triển khai TENANT-1, tiếp PR #236): toàn bộ
  // bề mặt vòng đời + membership dưới đây là thao tác CẤP PLATFORM hoặc
  // quản-trị-xuyên-tenant — actor hợp lệ (platform admin, hoặc tenant
  // admin của tenant đích) thường đang đứng trong ngữ cảnh của MỘT tenant
  // khác (mặc định là tenant-zero qua claim `tid`). Các bảng `tenants`,
  // `tenant_memberships`, `outbox_events` đều có RLS fail-closed theo
  // `app.tenant_id`, nên ngoài ngữ cảnh platform: `getTenant(tenant đích)`
  // trả rỗng → 404 `tenant.not_found` giả (seed chết ở POST members),
  // INSERT/UPDATE membership bị WITH CHECK chặn, listTenants chỉ thấy
  // đúng tenant hiệu lực. Vì vậy mỗi method tự bọc ngữ cảnh platform
  // tường minh — ĐÚNG khuôn vòng 1 (platformTenant/listMyTenants/
  // resolveDefaultTenant/resolveSwitchTarget). Ngữ cảnh platform chỉ đổi
  // tầm nhìn RLS của khâu tra cứu/ghi hệ thống; MỌI cổng capability
  // (assertPlatformManager/assertTenantManager/assertTenantViewer) vẫn
  // chạy nguyên vẹn bên trong, không một quyền nào được nới.
  //
  // Bổ sung issue #587 (tiền điều kiện Phần B, hạng mục 3 — thiết kế
  // A1): ba method ĐỌC theo một tenant đích đã biết
  // (getTenantForActor, listMembers, listTenantUsers) không còn bọc
  // platform một cách mù nữa. Lớp bọc của chúng phân giải đích
  // trước: tra dòng thư mục của tenant ở kho chung theo `tenantId`
  // để lấy `slug` (chỉ dữ kiện thư mục — không đọc membership hay
  // dữ kiện nghiệp vụ của tenant kho riêng từ kho chung), hỏi sổ
  // đăng ký chế độ kho của slug đó; tenant ở kho chung thì chạy
  // nguyên đường platform như cũ, tenant ở kho riêng thì chạy
  // NGUYÊN thân InContext (gồm mọi cổng capability) trong
  // `withSpaceDatabase(slug)` để các lượt đọc vào đúng kho đích.
  // Các method còn lại của bề mặt này giữ nguyên khuôn platform:
  // chúng hoặc là thao tác vòng đời do platform chủ trì trên dòng
  // thư mục ở kho chung (tạo/sửa tenant), hoặc là đường ghi
  // membership mà điểm đến đã được quyết ở tầng cao hơn
  // (createTenantUser tự rẽ sang kho riêng khi tenant đích ở kho
  // riêng). Phân giải kho riêng lỗi (bí mật/role lệch sổ) thì ném
  // ra nguyên trạng — fail-closed, không rơi về đọc kho chung cho
  // một tenant đã đăng ký kho riêng.
  //
  // Bổ sung tiền điều kiện TĐ6 (issue #587): bước phân giải đích
  // không còn chỉ tra dòng thư mục ở kho chung. Trung tâm CẤP
  // PHÁT MỚI không có dòng thư mục nào ở kho chung — pipeline
  // cấp phát chỉ ghi dòng tenant vào kho của chính trung tâm —
  // nên `spaceTargetForTenant` đọc dòng tenant ngay tại kho của
  // không gian mà ngữ cảnh request đã phân giải tới (địa chỉ
  // riêng của trung tâm) trước khi rơi về tra cứu kho chung
  // (xem `tenantRowForTargetResolution`). Nhờ đó ba method đọc
  // A1 ở trên và đường tạo người dùng cho trung tâm tới được
  // trung tâm cấp phát mới; tenant không tồn tại ở cả hai nơi
  // vẫn `tenant.not_found` như trước.

  async listTenants(actorId: string): Promise<TenantDto[]> {
    return tenantAls.run({ platform: true }, () => this.listTenantsInContext(actorId));
  }

  private async listTenantsInContext(actorId: string): Promise<TenantDto[]> {
    const systemId = await this.systemContextId();
    const canView =
      (await this.evaluator.hasCapability(actorId, 'tenant:viewall', systemId)) ||
      (await this.evaluator.hasCapability(actorId, 'tenant:manage', systemId));
    if (!canView) {
      throw new ForbiddenException({ message: 'Missing capability tenant:viewall', code: 'access.capability_denied' });
    }
    return (await this.repo.listTenants()).map(toTenantDto);
  }

  /**
   * Phân giải đích kho của một tenant theo `tenantId` (issue #587,
   * hạng mục 3 — nửa tra cứu của thiết kế A1, dùng chung cho các
   * đường đọc quản trị ở service này và cho điểm ghi mã tham gia
   * ở ClassesService):
   * - Tìm dòng tenant để lấy `slug` — slug là khoá phân giải
   *   không gian duy nhất của khung định tuyến — theo thứ tự của
   *   `tenantRowForTargetResolution`: kho của không gian mà ngữ
   *   cảnh đã phân giải tới trước (trung tâm cấp phát mới chỉ có
   *   dòng tenant ở đó — tiền điều kiện TĐ6), dòng thư mục ở kho
   *   chung sau. Không nơi nào có dòng tenant → trả `null` (bên
   *   gọi giữ hành vi hiện tại: thân InContext tự ném
   *   `tenant.not_found`).
   * - Hỏi sổ đăng ký chế độ kho của slug: `dedicated: true` khi
   *   trung tâm đã đăng ký kho riêng. Slug chưa đăng ký hoặc
   *   tầng định tuyến chưa cấu hình → `dedicated: false` (thế
   *   giới kho chung, cùng khuôn `createTenantUser`). Mọi lỗi
   *   phân giải còn lại là lỗi cấu hình của một trung tâm kho
   *   riêng đã đăng ký → ném ra nguyên trạng, fail-closed.
   *
   * @param tenantId - Định danh tenant cần phân giải đích.
   * @returns Slug của tenant và cờ kho riêng, hoặc `null` khi
   *   tenant không tồn tại ở kho nào.
   */
  async spaceTargetForTenant(tenantId: string): Promise<{ slug: string; dedicated: boolean } | null> {
    const row = await this.tenantRowForTargetResolution(tenantId);
    if (!row) return null;
    try {
      const target = await this.spaceDb.resolveTarget(row.slug);
      return { slug: row.slug, dedicated: target.mode === 'dedicated' };
    } catch (err) {
      if (
        err instanceof SpaceRoutingError &&
        (err.code === 'space_routing.space_not_found' || err.code === 'space_routing.not_configured')
      ) {
        return { slug: row.slug, dedicated: false };
      }
      throw err;
    }
  }

  /**
   * Dòng tenant dùng cho bước phân giải đích kho (issue #587,
   * tiền điều kiện TĐ6): thứ tự tra cứu phản ánh nguyên tắc dữ
   * kiện nghiệp vụ đọc tại kho đích, tầng điều khiển chỉ giữ thư
   * mục định tuyến:
   * 1. Khi ngữ cảnh hiện tại đã phân giải tới một không gian
   *    (`spaceSlug` do tầng gắn ngữ cảnh nạp từ Host của
   *    request), đọc dòng tenant theo id TRONG kho của không
   *    gian đó trước. Trung tâm cấp phát mới chỉ có dòng tenant
   *    trong kho của chính nó — pipeline cấp phát không ghi dòng
   *    nào vào kho chung — nên tra kho chung trước sẽ kết luận
   *    sai "không tồn tại" cho đúng trung tâm đang phục vụ
   *    request. Lượt đọc bọc ngữ cảnh platform NGOÀI
   *    `withSpaceDatabase` theo đúng khuôn `getTenantInSpace`:
   *    bảng `tenants` mang RLS theo `app.tenant_id` và ngữ cảnh
   *    của nơi gọi không đáng tin cho việc tra cứu này. Không
   *    gian của ngữ cảnh chưa đăng ký hoặc tầng định tuyến chưa
   *    cấu hình → lượt đọc coi như không có kết quả và rơi
   *    xuống bước 2; lỗi phân giải còn lại (bí mật/role lệch
   *    sổ) ném ra nguyên trạng — fail-closed.
   * 2. Ngoài ngữ cảnh không gian, hoặc id không có trong kho
   *    của không gian ngữ cảnh: tra dòng thư mục ở kho chung
   *    trong ngữ cảnh platform như trước — đường của các tenant
   *    đã di trú (dòng thư mục còn ở kho chung) và của mọi
   *    request ở địa chỉ platform.
   *
   * @param tenantId - Định danh tenant cần tra dòng.
   * @returns Dòng tenant tìm được, hoặc `undefined` khi không
   *   kho nào có dòng của tenant này.
   */
  private async tenantRowForTargetResolution(tenantId: string): Promise<TenantRow | undefined> {
    const contextSlug = tenantAls.getStore()?.spaceSlug;
    if (contextSlug) {
      try {
        const inContextSpace = await tenantAls.run({ platform: true }, () =>
          this.spaceDb.withSpaceDatabase(contextSlug, () => this.repo.getTenant(tenantId)),
        );
        if (inContextSpace) return inContextSpace;
      } catch (err) {
        if (
          !(err instanceof SpaceRoutingError) ||
          (err.code !== 'space_routing.space_not_found' && err.code !== 'space_routing.not_configured')
        ) {
          throw err;
        }
      }
    }
    return tenantAls.run({ platform: true }, () => this.repo.getTenant(tenantId));
  }

  /**
   * Chạy một thân đọc `InContext` tại ĐÚNG kho của tenant đích
   * (thiết kế A1): tenant ở kho riêng thì thân chạy trong
   * `withSpaceDatabase(slug)` — bọc platform đặt NGOÀI
   * `withSpaceDatabase` theo khuôn `getTenantInSpace`, vì khung
   * định tuyến hợp ngữ cảnh cha vào store của nó (platform còn
   * nguyên), trong khi bọc platform ở trong sẽ thay toàn bộ
   * store và đánh rơi slug. Tenant ở kho chung (hoặc không tra
   * được dòng thư mục) thì chạy nguyên đường platform hiện tại.
   */
  private async runInTenantTargetStore<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const target = await this.spaceTargetForTenant(tenantId);
    if (target?.dedicated) {
      return tenantAls.run({ platform: true }, () => this.spaceDb.withSpaceDatabase(target.slug, fn));
    }
    return tenantAls.run({ platform: true }, fn);
  }

  async getTenantForActor(actorId: string, tenantId: string): Promise<TenantDto> {
    return this.runInTenantTargetStore(tenantId, () => this.getTenantForActorInContext(actorId, tenantId));
  }

  private async getTenantForActorInContext(actorId: string, tenantId: string): Promise<TenantDto> {
    const tenant = await this.getTenant(tenantId);
    await this.assertTenantViewer(actorId, tenantId);
    return toTenantDto(tenant);
  }

  /**
   * Tạo tenant — CHỈ platform admin, khi khách đăng ký gói tổ chức. Tạo
   * tenant + context tenant là một thao tác nguyên tử ở tầng nghiệp vụ:
   * context tạo ngay sau dòng tenant, lỗi giữa chừng thì slug chưa được
   * công bố ở bất kỳ bề mặt nào khác.
   */
  async createTenant(actorId: string, dto: CreateTenantDto): Promise<TenantDto> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): kiểm slug trùng phải thấy
    // tenant của MỌI tenant khác và INSERT dòng tenant mới (id khác hẳn
    // tenant hiệu lực) chỉ qua WITH CHECK khi ở ngữ cảnh platform.
    return tenantAls.run({ platform: true }, () => this.createTenantInContext(actorId, dto));
  }

  private async createTenantInContext(actorId: string, dto: CreateTenantDto): Promise<TenantDto> {
    await this.assertPlatformManager(actorId);
    const slug = dto.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      throw new BadRequestException({ message: `Invalid tenant slug: ${dto.slug}`, code: 'tenant.invalid_slug' });
    }
    if (await this.repo.getTenantBySlug(slug)) {
      throw new ConflictException({ message: `Tenant slug ${slug} is already taken`, code: 'tenant.slug_taken' });
    }
    const tenant = await this.repo.insertTenant({
      slug,
      name: dto.name.trim(),
      kind: dto.kind,
      status: 'active',
      plan: dto.plan ?? null,
    });
    await this.contexts.ensureTenantContext(tenant.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'tenant',
      type: 'tenant_created',
      payload: { tenantId: tenant.id, slug, kind: dto.kind, actorId },
      tenantId: tenant.id,
    });
    return toTenantDto(tenant);
  }

  async updateTenant(actorId: string, tenantId: string, dto: UpdateTenantDto): Promise<TenantDto> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): thao tác của platform
    // admin lên tenant bất kỳ — đọc/sửa dòng tenant đích và enqueue
    // outbox mang tenant_id của tenant đích đều cần tầm nhìn platform.
    return tenantAls.run({ platform: true }, () => this.updateTenantInContext(actorId, tenantId, dto));
  }

  private async updateTenantInContext(actorId: string, tenantId: string, dto: UpdateTenantDto): Promise<TenantDto> {
    await this.assertPlatformManager(actorId);
    const tenant = await this.getTenant(tenantId);
    if (tenant.kind === 'platform' && dto.status !== undefined && dto.status !== 'active') {
      throw new BadRequestException({ message: 'The platform tenant cannot be suspended or archived', code: 'tenant.platform_immutable_status' });
    }
    const patch: Partial<TenantRow> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.plan !== undefined) patch.plan = dto.plan;
    if (Object.keys(patch).length) await this.repo.updateTenant(tenantId, patch);
    if (dto.status !== undefined && dto.status !== tenant.status) {
      const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
      await this.contexts.markContextDirty(tenantCtx.id);
      await this.outbox.enqueueStandalone({
        aggregate: 'tenant',
        type: 'tenant_status_changed',
        payload: { tenantId, from: tenant.status, to: dto.status, actorId },
        tenantId,
      });
    }
    return toTenantDto(await this.getTenant(tenantId));
  }

  // --- membership ------------------------------------------------------------

  /**
   * Đảm bảo membership `active` (tạo mới hoặc kích hoạt lại dòng đã
   * ended/suspended). Dùng cho tenant admin thêm thành viên và cho
   * luồng ghi danh (học sinh vào khoá của tenant nào thì thuộc tenant
   * đó). Đổi trạng thái membership luôn phá cache evaluator của cây
   * tenant để cổng membership có hiệu lực ngay.
   *
   * Thao tác dữ liệu sống ở tầng dùng chung
   * (`ensureActiveTenantMembership` của `@lms/enrol`) vì funnel ghi
   * danh dùng chung phải đảm bảo membership ngay trong đường vật
   * chất hoá của nó mà không phụ thuộc service của API; method này
   * chỉ uỷ thác, giữ nguyên hành vi và kiểu trả về.
   *
   * Handle uỷ thác (D5 #657): tầng dùng chung `@lms/enrol` đã
   * chuyển sang Kysely nên điểm này uỷ thác bằng tay cầm Kysely
   * đã định tuyến của API (`spaceDb.routedKysely`); handle Drizzle
   * thô inject riêng cho điểm này đã gỡ. Điểm uỷ thác là một
   * thao tác độc lập, không ghép transaction với bất kỳ thao tác
   * nào khác, nên không tồn tại giao dịch lai.
   *
   * CỐ Ý không tự bọc ngữ cảnh platform (HOTFIX #196 vòng 2): đây là
   * thao tác dữ liệu CỦA một tenant — các call-site nghiệp vụ (ghi
   * danh, roster lớp) chạy trong đúng ngữ cảnh của tenant sở hữu và
   * PHẢI giữ ngữ cảnh đó; các call-site cấp platform (addMember,
   * createTenantUser, bootstrap seed) đã tự bọc ngữ cảnh platform ở
   * tầng của chúng và method này kế thừa ngữ cảnh của nơi gọi.
   */
  async ensureActiveMembership(tenantId: string, userId: string): Promise<TenantMembershipRow> {
    return ensureActiveTenantMembership(this.spaceDb.routedKysely, tenantId, userId);
  }

  /**
   * Đồng bộ thư mục thành viên ở control plane sau một thao tác
   * ghi membership thành công (issue #587, hạng mục 3 — thiết kế
   * B1): chỉ áp cho tenant ở kho riêng và chỉ khi control plane
   * đã cấu hình; tenant ở kho chung không có gì phải đồng bộ vì
   * bộ chọn đọc thẳng membership ở kho chung.
   *
   * Mục đã có trong thư mục thì chỉ cập nhật trạng thái — giữ
   * nguyên `spaceUserId` mà các điểm ghi biết định danh đích
   * (lấp thư mục của đợt di trú, cấp phát) đã chốt, không ghi
   * đè bằng định danh toàn cục. Chưa có mục thì tạo mới với
   * `spaceUserId` bằng chính định danh của người dùng: mô hình
   * vật chất hoá tài khoản sang kho riêng giữ nguyên định danh
   * gốc của người dùng, nên định danh toàn cục cũng là định
   * danh tại kho đích cho tới khi một điểm ghi biết đích tường
   * minh chốt lại liên kết khác.
   *
   * Lỗi ghi thư mục ném ra nguyên trạng thay vì nuốt lặng: ghi
   * membership và ghi thư mục là hai nửa của cùng một thao tác,
   * lệch lặng sẽ làm bộ chọn trung tâm mất trung tâm mà không
   * ai biết — thà thao tác thất bại tường minh để gọi lại (mọi
   * điểm ghi đều chạy lại an toàn).
   */
  private async syncMembershipDirectory(tenantId: string, userId: string, status: string): Promise<void> {
    if (!this.directory.isConfigured()) return;
    const target = await this.spaceTargetForTenant(tenantId);
    if (!target?.dedicated) return;
    const updated = await this.directory.updateMembershipDirectoryStatus(userId, target.slug, status);
    if (updated === 0) {
      await this.directory.upsertMembershipDirectory({
        globalUserId: userId,
        spaceSlug: target.slug,
        spaceUserId: userId,
        status,
      });
    }
  }

  async addMember(actorId: string, tenantId: string, dto: AddTenantMemberDto): Promise<TenantMembershipDto> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): đây là điểm seed chết ở
    // production — platform admin đứng trong ngữ cảnh tenant-zero gọi
    // `getTenant(tenant trường)` bị RLS giấu → 404 `tenant.not_found`
    // giả; ghi membership + outbox cho tenant đích cũng cần tầm nhìn
    // platform. Cổng assertTenantManager chạy nguyên vẹn bên trong.
    const result = await tenantAls.run({ platform: true }, () => this.addMemberInContext(actorId, tenantId, dto));
    await this.syncMembershipDirectory(tenantId, dto.userId, result.status);
    return result;
  }

  private async addMemberInContext(actorId: string, tenantId: string, dto: AddTenantMemberDto): Promise<TenantMembershipDto> {
    await this.assertTenantManager(actorId, tenantId);
    const tenant = await this.getTenant(tenantId);
    if (tenant.status !== 'active') {
      throw new BadRequestException({ message: `Tenant ${tenantId} is not active`, code: 'tenant.not_active' });
    }
    const user = await this.users.getUser(dto.userId);
    // Điểm chặn SLOT GÓI TRUNG TÂM (issue #189 — đặc tả slot đã
    // duyệt): thêm thành viên là hành động "mời giáo viên" khi người
    // được mời ĐÃ giữ vai trò giảng dạy trong cây context của tenant
    // — membership chuyển sang `active` là họ được đếm thành một
    // slot ngay. Membership đã `active` sẵn thì số đếm không đổi,
    // không chặn. Tài khoản đang đình chỉ/đã xoá chưa được đếm nên
    // cũng không chặn ở đây (điểm chặn tương ứng nằm ở khâu bỏ đình
    // chỉ tài khoản và kích hoạt lại membership).
    const existingMembership = await this.repo.getMembership(tenantId, user.id);
    if (existingMembership?.status !== 'active' && !user.suspended && !user.deleted) {
      if (await this.planLimits.userHoldsTeachingRoleInTenant(tenantId, user.id)) {
        await this.planLimits.assertTenantSlotForNewTeacher(tenantId, user.id);
      }
    }
    const row = await this.ensureActiveMembership(tenantId, user.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'tenant',
      type: 'tenant_member_added',
      payload: { tenantId, userId: user.id, actorId },
      tenantId,
    });
    return toMembershipDto(row);
  }

  async setMemberStatus(
    actorId: string,
    tenantId: string,
    userId: string,
    status: 'active' | 'suspended' | 'ended',
  ): Promise<TenantMembershipDto> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2) — cùng lý do với addMember:
    // đọc/sửa membership của tenant đích từ ngữ cảnh của tenant khác.
    const result = await tenantAls.run({ platform: true }, () =>
      this.setMemberStatusInContext(actorId, tenantId, userId, status),
    );
    await this.syncMembershipDirectory(tenantId, userId, status);
    return result;
  }

  private async setMemberStatusInContext(
    actorId: string,
    tenantId: string,
    userId: string,
    status: 'active' | 'suspended' | 'ended',
  ): Promise<TenantMembershipDto> {
    await this.assertTenantManager(actorId, tenantId);
    const existing = await this.repo.getMembership(tenantId, userId);
    if (!existing) throw new NotFoundException({ message: 'Membership not found', code: 'tenant.membership_not_found' });
    // Điểm chặn SLOT GÓI TRUNG TÂM (issue #189 — đặc tả slot đã
    // duyệt): kích hoạt lại membership (`suspended`/`ended` →
    // `active`) của một người đã giữ vai trò giảng dạy trong cây
    // context của tenant, với tài khoản đang hoạt động, là hành động
    // làm tăng số slot — chặn khi tenant đã chạm hạn mức hiệu lực.
    // Các chuyển trạng thái khác (đình chỉ, kết thúc, hoặc kích hoạt
    // lại người chưa có vai trò giảng dạy) không đổi số đếm.
    if (status === 'active' && existing.status !== 'active') {
      const user = await this.users.getUser(userId);
      if (!user.suspended && !user.deleted) {
        if (await this.planLimits.userHoldsTeachingRoleInTenant(tenantId, userId)) {
          await this.planLimits.assertTenantSlotForNewTeacher(tenantId, userId);
        }
      }
    }
    await this.repo.updateMembership(existing.id, {
      status,
      endedAt: status === 'ended' ? new Date() : null,
    });
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    await this.contexts.markContextDirty(tenantCtx.id);
    await this.outbox.enqueueStandalone({
      aggregate: 'tenant',
      type: status === 'active' ? 'tenant_member_reactivated' : 'tenant_member_status_changed',
      payload: { tenantId, userId, status, actorId },
      tenantId,
    });
    return toMembershipDto({ ...existing, status, endedAt: status === 'ended' ? new Date() : null });
  }

  async listMembers(actorId: string, tenantId: string): Promise<TenantMembershipDto[]> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): platform/tenant admin xem
    // membership của tenant đích từ ngữ cảnh tenant khác — ngoài ngữ
    // cảnh platform RLS trả danh sách rỗng giả. Cổng viewer giữ nguyên.
    // Đích kho theo thiết kế A1 (issue #587): tenant đã chuyển kho thì
    // thân đọc chạy tại kho đích — membership của nó chỉ còn ở đó.
    return this.runInTenantTargetStore(tenantId, () => this.listMembersInContext(actorId, tenantId));
  }

  private async listMembersInContext(actorId: string, tenantId: string): Promise<TenantMembershipDto[]> {
    await this.assertTenantViewer(actorId, tenantId);
    return (await this.repo.listMembershipsForTenant(tenantId)).map(toMembershipDto);
  }

  // --- người dùng trong tenant ------------------------------------------------

  /**
   * Tenant admin tạo người dùng: tạo tài khoản TOÀN CỤC rồi gắn
   * membership ngay — tài khoản vẫn là một người duy nhất trên toàn hệ
   * thống (đăng nhập một lần, thuộc được nhiều tenant). Đáp ứng ra
   * HTTP là `TenantUserView` đã chiếu qua `toTenantUserView` — dòng
   * `users` đầy đủ (gồm `passwordHash`) chỉ ở lại tầng nội bộ.
   *
   * Đường kho riêng (issue #584): khi tenant đích là trung tâm ở kho
   * riêng, tài khoản mới CHỈ được tạo trong kho của trung tâm đó —
   * không tạo dòng tài khoản toàn cục, không tạo thành viên xuyên
   * trung tâm. Membership gắn kèm là membership NỘI BỘ của kho riêng
   * (dòng nối tài khoản trong kho với dòng tenant trong cùng kho),
   * để cổng membership của evaluator tiếp tục hoạt động trong kho
   * riêng mà không cần bất kỳ tra cứu nào sang kho chung. Cổng quản
   * trị tenant cũng xét trong kho riêng: quản trị của trung tâm
   * được nhận diện từ danh sách `siteadmins` của chính kho đó, và
   * quản trị platform cũng được nhận diện trong ngữ cảnh này qua
   * phép hợp nhất một chiều của evaluator — lớp phủ của người vận
   * hành platform, không tạo membership hay tài khoản nào cho họ
   * trong kho riêng, và chiều ngược lại không tồn tại (kho chung
   * không bao giờ thấy danh sách của kho riêng). Riêng cổng đăng
   * nhập platform vẫn ghim danh sách của kho chung, nên quản trị
   * trung tâm không qua được cổng đó tại bất kỳ địa chỉ nào.
   */
  async createTenantUser(actorId: string, tenantId: string, dto: CreateTenantUserDto): Promise<TenantUserView> {
    // Phân giải đích kho của tenant đích qua điểm phân giải dùng
    // chung `spaceTargetForTenant` — cùng kỷ luật lỗi đã có ở đó:
    // chỉ "chưa đăng ký kho riêng / tầng định tuyến chưa cấu
    // hình" mới rơi xuống đường kho chung; lỗi cấu hình của một
    // trung tâm kho riêng ĐÃ đăng ký (bí mật thiếu hoặc không hợp
    // lệ, role lệch sổ) ném ra nguyên trạng — nuốt chúng sẽ lặng
    // lẽ tạo tài khoản toàn cục kèm membership xuyên trung tâm ở
    // kho chung cho một trung tâm phải nằm trong kho riêng.
    // Điểm phân giải này đọc dòng tenant tại kho của không gian
    // mà ngữ cảnh đã phân giải tới trước khi tra kho chung, nên
    // trung tâm cấp phát mới (chỉ có dòng tenant trong kho của
    // chính nó — tiền điều kiện TĐ6, issue #587) tới được nhánh
    // kho riêng; trước đây bước tra kho chung ở ngay đầu method
    // này ném `tenant.not_found` oan cho đúng trung tâm đó dù
    // nhánh kho riêng đã sẵn sàng phía dưới.
    const target = await this.spaceTargetForTenant(tenantId);
    if (target?.dedicated) {
      return this.createTenantUserInSpace(actorId, target.slug, dto);
    }
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): kiểm tra tồn tại
    // trước (tenant không tồn tại ở kho nào vẫn 404
    // `tenant.not_found` như trước) và membership gắn ngay sau
    // khi tạo user thuộc tenant đích — cùng lý do với addMember.
    return tenantAls.run({ platform: true }, async () => {
      await this.getTenant(tenantId);
      return this.createTenantUserInContext(actorId, tenantId, dto);
    });
  }

  private async createTenantUserInSpace(
    actorId: string,
    slug: string,
    dto: CreateTenantUserDto,
  ): Promise<TenantUserView> {
    const spaceTenant = await this.getTenantInSpace(slug);
    if (!spaceTenant) {
      throw new NotFoundException({ message: `Tenant ${slug} is not ready in its own store`, code: 'tenant.not_found' });
    }
    const view = await this.spaceDb.withSpaceDatabase(slug, async () => {
      await this.assertTenantManager(actorId, spaceTenant.id);
      const user = await this.users.createUser({
        username: dto.username,
        email: dto.email,
        password: dto.password,
        firstName: dto.firstName,
        lastName: dto.lastName,
        forcePasswordChange: dto.forcePasswordChange,
        customFields: dto.customFields,
      });
      await this.ensureActiveMembership(spaceTenant.id, user.id);
      return toTenantUserView(user);
    });
    // Ghi thư mục thành viên cho tài khoản vừa sinh ra trong kho
    // riêng (issue #587, hạng mục 3 — thiết kế B1): tài khoản này
    // không tồn tại ở kho chung, định danh duy nhất của họ là
    // định danh tại kho đích, nên cả hai phía của mục thư mục
    // đều mang định danh đó — bộ chọn tra theo định danh tại kho
    // đích sẽ thấy trung tâm này. Ghi sau khi phiên kho riêng đã
    // hoàn tất; lỗi ghi thư mục ném ra nguyên trạng như các điểm
    // ghi membership khác (xem syncMembershipDirectory).
    if (this.directory.isConfigured()) {
      await this.directory.upsertMembershipDirectory({
        globalUserId: view.id,
        spaceSlug: slug,
        spaceUserId: view.id,
        status: 'active',
      });
    }
    return view;
  }

  private async createTenantUserInContext(actorId: string, tenantId: string, dto: CreateTenantUserDto): Promise<TenantUserView> {
    await this.assertTenantManager(actorId, tenantId);
    const user = await this.users.createUser({
      username: dto.username,
      email: dto.email,
      password: dto.password,
      firstName: dto.firstName,
      lastName: dto.lastName,
      forcePasswordChange: dto.forcePasswordChange,
      customFields: dto.customFields,
    });
    await this.ensureActiveMembership(tenantId, user.id);
    return toTenantUserView(user);
  }

  /**
   * Danh sách người dùng mà tenant admin của tenant này thấy: CHỈ
   * thành viên của tenant, mỗi phần tử đã chiếu qua `toTenantUserView`
   * (không bao giờ trả nguyên dòng `users` ra HTTP).
   */
  async listTenantUsers(actorId: string, tenantId: string): Promise<TenantUserView[]> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2) — đọc membership của
    // tenant đích, cùng lý do với listMembers. Đích kho theo thiết
    // kế A1 (issue #587) như listMembers.
    return this.runInTenantTargetStore(tenantId, () => this.listTenantUsersInContext(actorId, tenantId));
  }

  private async listTenantUsersInContext(actorId: string, tenantId: string): Promise<TenantUserView[]> {
    await this.assertTenantViewer(actorId, tenantId);
    const members = await this.repo.listMembershipsForTenant(tenantId);
    if (!members.length) return [];
    const rows = await this.users.getUsersByIds(members.map((m) => m.userId));
    return rows.map(toTenantUserView);
  }

  // --- phân giải tenant cho phiên đăng nhập -----------------------------------

  /** Các tenant user là thành viên active và tenant đang active — cho bộ chọn tenant. */
  async listMyTenants(userId: string, activeTenantId?: string): Promise<MyTenant[]> {
    // Đường hệ thống xuyên tenant (bộ chọn tenant phải thấy membership ở
    // MỌI tenant của user) — chạy trong ngữ cảnh platform như platformTenant.
    return tenantAls.run({ platform: true }, () => this.listMyTenantsInContext(userId, activeTenantId));
  }

  private async listMyTenantsInContext(userId: string, activeTenantId?: string): Promise<MyTenant[]> {
    const memberships = await this.repo.listMembershipsForUser(userId);
    const active = memberships.filter((m) => m.status === 'active');
    const rows: MyTenant[] = [];
    for (const m of active) {
      const tenant = await this.repo.getTenant(m.tenantId);
      if (!tenant || tenant.status !== 'active') continue;
      rows.push({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        kind: tenant.kind as MyTenant['kind'],
        active: tenant.id === activeTenantId,
      });
    }
    // Hợp nhất thư mục thành viên của các không gian kho riêng
    // (issue #587, hạng mục 3 — thiết kế B1): membership của
    // trung tâm đã chuyển chỉ còn ở kho đích nên lượt tra kho
    // chung ở trên không thấy; thư mục ở control plane cho biết
    // người này còn là thành viên của không gian kho riêng nào,
    // và dữ kiện của từng trung tâm được đọc tại chính kho của
    // nó (xem myTenantFromDirectoryEntry). Slug đã có từ nguồn
    // kho chung thì không đọc lại từ thư mục.
    if (this.directory.isConfigured()) {
      const seenSlugs = new Set(rows.map((r) => r.slug));
      const entries = await this.directory.listMembershipDirectoryForUser(userId);
      for (const entry of entries) {
        if (entry.status !== 'active' || seenSlugs.has(entry.spaceSlug)) continue;
        const row = await this.myTenantFromDirectoryEntry(entry.spaceSlug, entry.spaceUserId, activeTenantId);
        if (row) {
          rows.push(row);
          seenSlugs.add(entry.spaceSlug);
        }
      }
    }
    return rows;
  }

  /**
   * Đọc một trung tâm kho riêng cho bộ chọn từ một mục thư mục
   * thành viên (issue #587, hạng mục 3 — thiết kế B1): thư mục
   * chỉ là chỉ mục định tuyến — tên/trạng thái của trung tâm và
   * trạng thái membership THẬT đều đọc tại kho đích trong
   * `withSpaceDatabase`, đối chiếu bằng `spaceUserId` của mục.
   * Trung tâm không còn active hoặc membership ở kho đích
   * không còn active → trả `null` (không thuộc bộ chọn). Chuẩn
   * bị kho đích lỗi thì `withSpaceDatabase` ném ra nguyên
   * trạng: bộ chọn lỗi tường minh thay vì lặng lẽ thiếu một
   * trung tâm.
   *
   * @param spaceSlug - Slug của không gian kho riêng.
   * @param spaceUserId - Định danh của người dùng trong kho đích.
   * @param activeTenantId - Tenant hiệu lực của phiên (đánh dấu `active`).
   */
  private async myTenantFromDirectoryEntry(
    spaceSlug: string,
    spaceUserId: string,
    activeTenantId?: string,
  ): Promise<MyTenant | null> {
    return this.spaceDb.withSpaceDatabase(spaceSlug, async () => {
      const tenant = await this.repo.getTenantBySlug(spaceSlug);
      if (!tenant || tenant.status !== 'active') return null;
      const membership = await this.repo.getMembership(tenant.id, spaceUserId);
      if (!membership || membership.status !== 'active') return null;
      return {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        kind: tenant.kind as MyTenant['kind'],
        active: tenant.id === activeTenantId,
      };
    });
  }

  /**
   * Tenant mặc định khi đăng nhập, thứ tự xác định (hồ sơ mục 4.2):
   * đúng một membership active → tenant đó; nhiều membership → site
   * admin về tenant-zero (không gian vận hành), người thường về tenant
   * school/center gia nhập sớm nhất; không có membership nào →
   * tenant-zero (không gian công cộng của Trang chính). KHÔNG BAO GIỜ
   * đoán một tenant khách hàng cho người không phải thành viên.
   */
  async resolveDefaultTenant(userId: string): Promise<TenantRow> {
    // Đường tiền-đăng-nhập: phân giải tenant mặc định phải thấy membership
    // của user ở mọi tenant — chạy trong ngữ cảnh platform như platformTenant.
    return tenantAls.run({ platform: true }, () => this.resolveDefaultTenantInContext(userId));
  }

  private async resolveDefaultTenantInContext(userId: string): Promise<TenantRow> {
    const zero = await this.platformTenant();
    const memberships = (await this.repo.listMembershipsForUser(userId)).filter((m) => m.status === 'active');
    const tenants: TenantRow[] = [];
    for (const m of memberships) {
      const tenant = await this.repo.getTenant(m.tenantId);
      if (tenant && tenant.status === 'active') tenants.push(tenant);
    }
    if (tenants.length === 1) return tenants[0]!;
    if (tenants.length > 1) {
      if (await this.evaluator.isSiteAdmin(userId)) return zero;
      const nonPlatform = tenants.find((t) => t.kind !== 'platform');
      if (nonPlatform) return nonPlatform;
    }
    return zero;
  }

  /**
   * Kiểm chứng đích chuyển tenant (POST /auth/switch-tenant): tenant
   * phải tồn tại và đang active; tenant school/center đòi membership
   * active; tenant-zero mở cho mọi tài khoản đã đăng nhập (không gian
   * công cộng của Trang chính).
   */
  async resolveSwitchTarget(userId: string, tenantId: string): Promise<TenantRow> {
    // Kiểm chứng đích chuyển tenant là đường hệ thống xuyên tenant — chạy
    // trong ngữ cảnh platform như platformTenant.
    return tenantAls.run({ platform: true }, () => this.resolveSwitchTargetInContext(userId, tenantId));
  }

  private async resolveSwitchTargetInContext(userId: string, tenantId: string): Promise<TenantRow> {
    const tenant = await this.getTenant(tenantId);
    if (tenant.status !== 'active') {
      throw new ForbiddenException({ message: `Tenant ${tenant.slug} is ${tenant.status}`, code: 'tenant.not_active' });
    }
    if (tenant.kind !== 'platform') {
      const membership = await this.repo.getMembership(tenantId, userId);
      if (!membership || membership.status !== 'active') {
        throw new ForbiddenException({ message: 'User is not an active member of this tenant', code: 'tenant.not_member' });
      }
    }
    return tenant;
  }
}
