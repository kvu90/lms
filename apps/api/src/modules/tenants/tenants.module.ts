import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { UsersModule } from '../users/users.module';
import { TenantConfigService } from './tenant-config.service';
import { TenantContextService } from './tenant-context.service';
import { TenantDbService } from './tenant-db.service';
import { TenantGuard } from './tenant.guard';
import { TenantsController } from './tenants.controller';
import { TenantsRepository } from './tenants.repository';
import { TenantsService } from './tenants.service';

/**
 * TenantsModule — nền multi-tenant (TENANT-0, #168): vòng đời tenant,
 * membership, cấu hình theo tenant, ngữ cảnh request (ALS), wrapper
 * transaction RLS và TenantGuard. Mọi module thuộc bề mặt đã phủ tenant
 * import module này để lấy TenantContextService/TenantsService.
 */
@Module({
  imports: [AccessModule, UsersModule, EventsModule],
  controllers: [TenantsController],
  providers: [
    TenantsRepository,
    TenantsService,
    TenantConfigService,
    TenantContextService,
    TenantDbService,
    TenantGuard,
  ],
  exports: [
    TenantsRepository,
    TenantsService,
    TenantConfigService,
    TenantContextService,
    TenantDbService,
    TenantGuard,
  ],
})
export class TenantsModule {}
