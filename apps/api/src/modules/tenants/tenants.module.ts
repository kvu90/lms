import { Module } from '@nestjs/common';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { UsersModule } from '../users/users.module';
import { SpaceContextGuard } from './space-context.guard';
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
 * transaction RLS và TenantGuard. SpaceContextGuard (issue #582) gắn
 * thêm ngữ cảnh trung tâm theo địa chỉ request trên nền khung định
 * tuyến (SpaceRoutingModule). Mọi module thuộc bề mặt đã phủ tenant
 * import module này để lấy TenantContextService/TenantsService.
 */
@Module({
  imports: [AccessModule, UsersModule, EventsModule, SpaceRoutingModule],
  controllers: [TenantsController],
  providers: [
    TenantsRepository,
    TenantsService,
    TenantConfigService,
    TenantContextService,
    TenantDbService,
    TenantGuard,
    SpaceContextGuard,
  ],
  exports: [
    TenantsRepository,
    TenantsService,
    TenantConfigService,
    TenantContextService,
    TenantDbService,
    TenantGuard,
    SpaceContextGuard,
  ],
})
export class TenantsModule {}
