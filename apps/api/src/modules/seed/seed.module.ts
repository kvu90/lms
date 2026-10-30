import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { ControlPlaneModule } from '../control-plane/control-plane.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { SeedService } from './seed.service';

@Module({
  imports: [AccessModule, UsersModule, TenantsModule, SiteConfigModule, ControlPlaneModule],
  providers: [SeedService],
})
/** Module gieo dữ liệu nền khi khởi động. */
export class SeedModule {}
