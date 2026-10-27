import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AvailabilityService } from './availability.service';

/**
 * Facade của AvailabilityModule: AvailabilityService. Các evaluator lá cho
 * completion/group/grouping được đăng ký bởi module sở hữu chúng tại
 * lúc khởi động (mẫu registry — không import repository xuyên module).
 */
@Module({
  imports: [UsersModule],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
/** Module điều kiện availability. */
export class AvailabilityModule {}
