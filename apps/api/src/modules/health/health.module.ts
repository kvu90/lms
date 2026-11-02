import { Module } from '@nestjs/common';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [SpaceRoutingModule],
  controllers: [HealthController],
  providers: [HealthService],
})
/** Module kiểm tra sức khoẻ hệ thống. */
export class HealthModule {}
