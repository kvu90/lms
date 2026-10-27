import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MyTenant, Tenant as TenantDto, TenantMembership as TenantMembershipDto } from '@lms/contracts';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import { PlanLimitsService } from '../access/plan-limits.service';
import { UsersService } from '../users/users.service';
import type { UserRow } from '../users/users.repository';
import { OutboxService } from '../../infra/events/outbox.service';
import { tenantAls } from './tenant-als';
import {
  DEFAULT_SCHOOL_TENANT_SLUG,
  PLATFORM_TENANT_SLUG,
  TenantsRepository,
  type TenantMembershipRow,
  type TenantRow,
} from './tenants.repository';
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
 * TenantsService — vòng đời tenant + membership (TENANT-0, #168; hồ sơ
 * mục 2, 4, 6.2). Nguyên tắc cứng theo chốt của Lão gia: tenant CHỈ do
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

  async getTenantForActor(actorId: string, tenantId: string): Promise<TenantDto> {
    return tenantAls.run({ platform: true }, () => this.getTenantForActorInContext(actorId, tenantId));
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
   * CỐ Ý không tự bọc ngữ cảnh platform (HOTFIX #196 vòng 2): đây là
   * thao tác dữ liệu CỦA một tenant — các call-site nghiệp vụ (ghi
   * danh, roster lớp) chạy trong đúng ngữ cảnh của tenant sở hữu và
   * PHẢI giữ ngữ cảnh đó; các call-site cấp platform (addMember,
   * createTenantUser, bootstrap seed) đã tự bọc ngữ cảnh platform ở
   * tầng của chúng và method này kế thừa ngữ cảnh của nơi gọi.
   */
  async ensureActiveMembership(tenantId: string, userId: string): Promise<TenantMembershipRow> {
    const existing = await this.repo.getMembership(tenantId, userId);
    if (existing?.status === 'active') return existing;
    let row: TenantMembershipRow;
    if (existing) {
      await this.repo.updateMembership(existing.id, { status: 'active', endedAt: null });
      row = { ...existing, status: 'active', endedAt: null };
    } else {
      row = await this.repo.insertMembership({ tenantId, userId, status: 'active' });
    }
    const tenantCtx = await this.contexts.ensureTenantContext(tenantId);
    await this.contexts.markContextDirty(tenantCtx.id);
    return row;
  }

  async addMember(actorId: string, tenantId: string, dto: AddTenantMemberDto): Promise<TenantMembershipDto> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): đây là điểm seed chết ở
    // production — platform admin đứng trong ngữ cảnh tenant-zero gọi
    // `getTenant(tenant trường)` bị RLS giấu → 404 `tenant.not_found`
    // giả; ghi membership + outbox cho tenant đích cũng cần tầm nhìn
    // platform. Cổng assertTenantManager chạy nguyên vẹn bên trong.
    return tenantAls.run({ platform: true }, () => this.addMemberInContext(actorId, tenantId, dto));
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
    return tenantAls.run({ platform: true }, () => this.setMemberStatusInContext(actorId, tenantId, userId, status));
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
    return tenantAls.run({ platform: true }, () => this.listMembersInContext(actorId, tenantId));
  }

  private async listMembersInContext(actorId: string, tenantId: string): Promise<TenantMembershipDto[]> {
    await this.assertTenantViewer(actorId, tenantId);
    return (await this.repo.listMembershipsForTenant(tenantId)).map(toMembershipDto);
  }

  // --- người dùng trong tenant ------------------------------------------------

  /**
   * Tenant admin tạo người dùng: tạo tài khoản TOÀN CỤC rồi gắn
   * membership ngay — tài khoản vẫn là một người duy nhất trên toàn hệ
   * thống (đăng nhập một lần, thuộc được nhiều tenant).
   */
  async createTenantUser(actorId: string, tenantId: string, dto: CreateTenantUserDto): Promise<UserRow> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2): membership gắn ngay sau
    // khi tạo user thuộc tenant đích — cùng lý do với addMember.
    return tenantAls.run({ platform: true }, () => this.createTenantUserInContext(actorId, tenantId, dto));
  }

  private async createTenantUserInContext(actorId: string, tenantId: string, dto: CreateTenantUserDto): Promise<UserRow> {
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
    return user;
  }

  /** Danh sách người dùng mà tenant admin của tenant này thấy: CHỈ thành viên của tenant. */
  async listTenantUsers(actorId: string, tenantId: string): Promise<UserRow[]> {
    // Ngữ cảnh platform (HOTFIX #196 vòng 2) — đọc membership của
    // tenant đích, cùng lý do với listMembers.
    return tenantAls.run({ platform: true }, () => this.listTenantUsersInContext(actorId, tenantId));
  }

  private async listTenantUsersInContext(actorId: string, tenantId: string): Promise<UserRow[]> {
    await this.assertTenantViewer(actorId, tenantId);
    const members = await this.repo.listMembershipsForTenant(tenantId);
    if (!members.length) return [];
    return this.users.getUsersByIds(members.map((m) => m.userId));
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
    return rows;
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
