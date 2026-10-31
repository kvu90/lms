import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { uuidIdSchema } from '@lms/contracts';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { TenantsService, toTenantDto } from './tenants.service';
import { TenantContextService } from './tenant-context.service';
import {
  addTenantMemberSchema,
  createTenantSchema,
  createUserSchema,
  updateTenantMemberSchema,
  updateTenantSchema,
  type AddTenantMemberDto,
  type CreateTenantDto,
  type CreateTenantUserDto,
  type UpdateTenantDto,
  type UpdateTenantMemberDto,
} from './dto/tenants.dto';

@ApiTags('tenants')
@Controller({ path: 'tenants', version: '1' })
/**
 * API tenant (TENANT-0, #168): bề mặt platform (tạo/vòng đời tenant —
 * chỉ platform admin khi khách đăng ký gói tổ chức; KHÔNG có đăng ký tự
 * phục vụ) + bề mặt tenant admin (thành viên, người dùng của tenant).
 * Mọi cổng quyền kiểm trong TenantsService theo capability tại context
 * hệ thống (platform) hoặc context tenant (tenant admin).
 */
export class TenantsController {
  constructor(
    private readonly tenants: TenantsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  /** GET /tenants — danh sách tenant toàn hệ thống (platform: tenant:viewall). */
  async list(@CurrentUser() actor: AuthenticatedUser) {
    return this.tenants.listTenants(actor.id);
  }

  @Post()
  /** POST /tenants — tạo tenant (platform: tenant:manage). */
  async create(@Body({ schema: createTenantSchema }) dto: CreateTenantDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.tenants.createTenant(actor.id, dto);
  }

  @Get('current')
  /** GET /tenants/current — tenant hiệu lực của phiên hiện tại. */
  async current(@CurrentUser() actor: AuthenticatedUser) {
    const tenantId = this.tenantContext.currentTenantId();
    const tenant = tenantId ? await this.tenants.getTenant(tenantId) : await this.tenants.resolveDefaultTenant(actor.id);
    return toTenantDto(tenant);
  }

  @Get(':tenantId')
  /** GET /tenants/:tenantId — chi tiết một tenant (platform hoặc tenant admin của tenant đó). */
  async get(@Param('tenantId', { schema: uuidIdSchema }) tenantId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.tenants.getTenantForActor(actor.id, tenantId);
  }

  @Patch(':tenantId')
  /** PATCH /tenants/:tenantId — đổi tên / trạng thái vòng đời / gói (platform). */
  async update(
    @Param('tenantId', { schema: uuidIdSchema }) tenantId: string,
    @Body({ schema: updateTenantSchema }) dto: UpdateTenantDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenants.updateTenant(actor.id, tenantId, dto);
  }

  @Get(':tenantId/members')
  /** GET /tenants/:tenantId/members — danh sách membership của tenant. */
  async members(@Param('tenantId', { schema: uuidIdSchema }) tenantId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.tenants.listMembers(actor.id, tenantId);
  }

  @Post(':tenantId/members')
  /** POST /tenants/:tenantId/members — thêm thành viên (user toàn cục có sẵn) vào tenant. */
  async addMember(
    @Param('tenantId', { schema: uuidIdSchema }) tenantId: string,
    @Body({ schema: addTenantMemberSchema }) dto: AddTenantMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenants.addMember(actor.id, tenantId, dto);
  }

  @Patch(':tenantId/members/:userId')
  /** PATCH /tenants/:tenantId/members/:userId — đổi trạng thái membership (active/suspended/ended). */
  async setMemberStatus(
    @Param('tenantId', { schema: uuidIdSchema }) tenantId: string,
    @Param('userId', { schema: uuidIdSchema }) userId: string,
    @Body({ schema: updateTenantMemberSchema }) dto: UpdateTenantMemberDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenants.setMemberStatus(actor.id, tenantId, userId, dto.status);
  }

  @Get(':tenantId/users')
  /** GET /tenants/:tenantId/users — người dùng CỦA tenant này (chỉ thành viên). */
  async users(@Param('tenantId', { schema: uuidIdSchema }) tenantId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.tenants.listTenantUsers(actor.id, tenantId);
  }

  @Post(':tenantId/users')
  /** POST /tenants/:tenantId/users — tenant admin tạo người dùng + membership ngay; tenant ở kho riêng thì tài khoản chỉ tạo trong kho của trung tâm đó (issue #584). */
  async createUser(
    @Param('tenantId', { schema: uuidIdSchema }) tenantId: string,
    @Body({ schema: createUserSchema }) dto: CreateTenantUserDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenants.createTenantUser(actor.id, tenantId, dto);
  }
}
