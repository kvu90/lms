import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AvailabilityService } from './availability.service';

/**
 * AvailabilityModule facade: AvailabilityService. Leaf evaluators for
 * completion/group/grouping are registered by their owning modules at
 * bootstrap (registry pattern — no repository imports across modules).
 */
@Module({
  imports: [UsersModule],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
/** Module điều kiện availability. */
export class AvailabilityModule {}
