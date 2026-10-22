import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { SiteConfigService } from './site-config.service';
import { setSiteSettingSchema, type SetSettingDto } from './dto/site-config.dto';

@ApiTags('site-config')
@Controller({ path: 'site-config', version: '1' })
/**
 * API cấu hình site và cấu hình theo plugin (chỉ quản trị có capability
 * `moodle/site:config` ở context hệ thống mới đọc/ghi được).
 */
export class SiteConfigController {
  constructor(private readonly service: SiteConfigService) {}

  @Get()
  @RequireCapability('moodle/site:config')
  /**
   * GET /site-config — mọi setting đã đăng ký kèm giá trị hiệu lực và nguồn.
   */
  async list() {
    return this.service.listSettings();
  }

  @Get('audit')
  @RequireCapability('moodle/site:config')
  /**
   * GET /site-config/audit — vết thay đổi cấu hình, lọc theo `settingKey` nếu có.
   */
  async audit(@Query('settingKey') settingKey?: string) {
    return this.service.listAudit(settingKey);
  }

  @Get(':component/:name')
  @RequireCapability('moodle/site:config')
  /**
   * GET /site-config/:component/:name — một setting kèm giá trị hiệu lực.
   */
  async get(@Param('component') component: string, @Param('name') name: string) {
    return this.service.getSetting(component, name);
  }

  @Put(':component/:name')
  @RequireCapability('moodle/site:config')
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
  @RequireCapability('moodle/site:config')
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
