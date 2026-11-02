import { Module } from '@nestjs/common';
import { SiteConfigRepository } from '@lms/db/repositories/site-config';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { TenantsModule } from '../tenants/tenants.module';
import { SiteConfigController } from './site-config.controller';
import { SiteConfigService } from './site-config.service';

@Module({
  // SpaceRoutingModule (thêm ở issue #641): SiteConfigRepository
  // đã chuyển sang `@lms/db` trên Kysely nên module lắp nó bằng
  // factory provider trên facade định tuyến `routedKysely`; trước
  // đây repository tự inject handle qua nhà cung cấp kết nối
  // Drizzle nên module chưa cần cạnh import này.
  imports: [AccessModule, TenantsModule, SpaceRoutingModule],
  controllers: [SiteConfigController],
  providers: [
    {
      provide: SiteConfigRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new SiteConfigRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    SiteConfigService,
  ],
  exports: [SiteConfigService],
})
/** Module cấu hình site và cấu hình theo plugin (admin settings). */
export class SiteConfigModule {}
