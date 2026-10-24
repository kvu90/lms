import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { GradesModule } from '../grades/grades.module';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';

/**
 * DashboardModule (DASH1, issue #121): khối tổng hợp đầu dashboard (việc
 * sắp đến hạn, điểm mới đã công bố, hàng đợi chấm) + tuỳ chọn thẻ khoá cá
 * nhân. Phụ thuộc Access (PermissionEvaluator + ContextsService để xác
 * định đội giảng dạy) và Grades facade (trạng thái công bố PH-0).
 */
@Module({
  imports: [AccessModule, GradesModule],
  controllers: [DashboardController],
  providers: [DashboardRepository, DashboardService],
  exports: [DashboardService],
})
/** Module dashboard việc cần làm. */
export class DashboardModule {}
