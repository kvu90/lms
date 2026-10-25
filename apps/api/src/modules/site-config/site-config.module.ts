import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { TenantsModule } from '../tenants/tenants.module';
import { SiteConfigController } from './site-config.controller';
import { SiteConfigRepository } from './site-config.repository';
import { SiteConfigService } from './site-config.service';

@Module({
  imports: [AccessModule, TenantsModule],
  controllers: [SiteConfigController],
  providers: [SiteConfigRepository, SiteConfigService],
  exports: [SiteConfigService],
})
/** Module cấu hình site và cấu hình theo plugin (admin settings). */
export class SiteConfigModule {}
