import { BadRequestException, Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { TenantConfigService } from '../tenants/tenant-config.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import { SiteConfigService } from './site-config.service';
import { setSiteSettingSchema, type SetSettingDto } from './dto/site-config.dto';

@ApiTags('site-config')
@Controller({ path: 'site-config', version: '1' })
/**
 * API cấu hình site và cấu hình theo plugin (chỉ quản trị có capability
 * `site:config` ở context hệ thống mới đọc/ghi được). Nhánh
 * `tenant-settings` là cấu hình của TENANT hiệu lực (TENANT-0, #168):
 * gác `tenant:manage`/`tenant:viewall` tại context tenant ngay trong
 * TenantConfigService — đổi ở đây chỉ chạm tenant của người gọi.
 */
export class SiteConfigController {
  constructor(
    private readonly service: SiteConfigService,
    private readonly tenantConfig: TenantConfigService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Tenant hiệu lực của request; thiếu ngữ cảnh tenant là lỗi cấu hình phiên. */
  private activeTenantId(): string {
    const tenantId = this.tenantContext.currentTenantId();
    if (!tenantId) {
      throw new BadRequestException({ message: 'No active tenant in this request', code: 'tenant.context_missing' });
    }
    return tenantId;
  }

  @Get('tenant-settings')
  /**
   * GET /site-config/tenant-settings — setting tenant được ghi đè (scope tenant|both) kèm giá trị hiệu lực cho tenant hiệu lực.
   */
  async listTenantSettings(@CurrentUser() actor: AuthenticatedUser) {
    return this.tenantConfig.listForTenant(actor.id, this.activeTenantId());
  }

  @Put('tenant-settings/:component/:name')
  /**
   * PUT /site-config/tenant-settings/:component/:name — tenant admin đặt ghi đè cho tenant của mình.
   */
  async setTenantSetting(
    @Param('component') component: string,
    @Param('name') name: string,
    @Body({ schema: setSiteSettingSchema }) dto: SetSettingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenantConfig.setForTenant(actor.id, this.activeTenantId(), component, name, dto.value);
  }

  @Delete('tenant-settings/:component/:name')
  /**
   * DELETE /site-config/tenant-settings/:component/:name — xoá ghi đè của tenant, trở về giá trị platform/mặc định.
   */
  async clearTenantSetting(
    @Param('component') component: string,
    @Param('name') name: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.tenantConfig.clearForTenant(actor.id, this.activeTenantId(), component, name);
  }

  @Get()
  @RequireCapability('site:config')
  /**
   * GET /site-config — mọi setting đã đăng ký kèm giá trị hiệu lực và nguồn.
   */
  async list() {
    return this.service.listSettings();
  }

  @Get('audit')
  @RequireCapability('site:config')
  /**
   * GET /site-config/audit — vết thay đổi cấu hình, lọc theo `settingKey` nếu có.
   */
  async audit(@Query('settingKey') settingKey?: string) {
    return this.service.listAudit(settingKey);
  }

  @Get(':component/:name')
  @RequireCapability('site:config')
  /**
   * GET /site-config/:component/:name — một setting kèm giá trị hiệu lực.
   */
  async get(@Param('component') component: string, @Param('name') name: string) {
    return this.service.getSetting(component, name);
  }

  @Put(':component/:name')
  @RequireCapability('site:config')
  /**
   * PUT /site-config/:component/:name — đặt giá trị ghi đè (đã kiểm chứng kiểu).
   */
  async set(
    @Param('component') component: string,
    @Param('name') name: string,
    @Body({ schema: setSiteSettingSchema }) dto: SetSettingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.setSetting(actor.id, component, name, dto.value);
  }

  @Delete(':component/:name')
  @RequireCapability('site:config')
  /**
   * DELETE /site-config/:component/:name — xoá ghi đè, trở về mặc định code.
   */
  async clear(
    @Param('component') component: string,
    @Param('name') name: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.service.clearSetting(actor.id, component, name);
  }
}
