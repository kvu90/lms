import { Module } from '@nestjs/common';
import { CentreIdentityRepository } from '@lms/db/repositories/centre-identity';
import { TenantsRepository } from '@lms/db/repositories/tenants';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { ControlPlaneModule } from '../control-plane/control-plane.module';
import { UsersModule } from '../users/users.module';
import { CentreIdentityController } from './centre-identity.controller';
import { CentreIdentityService } from './centre-identity.service';
import { SpaceContextGuard } from './space-context.guard';
import { SpaceProgramPackageService } from './space-program-package.service';
import { TenantConfigService } from './tenant-config.service';
import { TenantContextService } from './tenant-context.service';
import { TenantDbService } from './tenant-db.service';
import { TenantGuard } from './tenant.guard';
import { TenantsController } from './tenants.controller';
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
  imports: [AccessModule, UsersModule, EventsModule, SpaceRoutingModule, ControlPlaneModule],
  controllers: [TenantsController, CentreIdentityController],
  providers: [
    // Hai repository của module đã chuyển sang `@lms/db` trên
    // Kysely (issue #641) nên được lắp bằng factory provider trên
    // facade định tuyến `routedKysely` — cùng khuôn lắp ráp với
    // ControlPlaneRepository ở ControlPlaneModule.
    {
      provide: TenantsRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new TenantsRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    {
      provide: CentreIdentityRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new CentreIdentityRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    CentreIdentityService,
    TenantsService,
    TenantConfigService,
    TenantContextService,
    TenantDbService,
    TenantGuard,
    SpaceContextGuard,
    SpaceProgramPackageService,
  ],
  exports: [
    TenantsRepository,
    TenantsService,
    TenantConfigService,
    TenantContextService,
    TenantDbService,
    TenantGuard,
    SpaceContextGuard,
    SpaceProgramPackageService,
  ],
})
export class TenantsModule {}
