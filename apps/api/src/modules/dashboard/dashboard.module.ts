import { Module } from '@nestjs/common';
import { DashboardRepository, type ContextLevels } from '@lms/db/repositories/dashboard';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { AccessModule } from '../access/access.module';
import { CONTEXT_LEVELS } from '../access/domain/capabilities';
import { GradesModule } from '../grades/grades.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Token DI của cổng registry mức ngữ cảnh cho repository dashboard:
 * phía ứng dụng cấp qua token này object registry hiện hành
 * (`CONTEXT_LEVELS` của module access — nguồn định nghĩa duy nhất
 * của hệ). `@lms/db` chỉ giữ hình dạng của registry (interface
 * `ContextLevels`), tuyệt đối không giữ bản sao giá trị của nó.
 */
const CONTEXT_LEVELS_PORT = 'CONTEXT_LEVELS_PORT';

/**
 * DashboardModule (DASH1, issue #121): khối tổng hợp đầu dashboard (việc
 * sắp đến hạn, điểm mới đã công bố, hàng đợi chấm) + tuỳ chọn thẻ khoá cá
 * nhân. Phụ thuộc Access (PermissionEvaluator + ContextsService để xác
 * định đội giảng dạy) và Grades facade (trạng thái công bố PH-0).
 *
 * Từ issue #652, repository của module sống ở `@lms/db` trên Kysely
 * (lớp thuần, không phụ thuộc Nest) nên module lắp nó bằng factory
 * provider trên handle định tuyến theo không gian
 * (`SpaceDatabaseService.routedKysely`) kèm implementation cổng
 * registry qua `CONTEXT_LEVELS_PORT` — cùng khuôn lắp repository của
 * pilot control plane.
 */
@Module({
  imports: [AccessModule, GradesModule, SpaceRoutingModule],
  controllers: [DashboardController],
  providers: [
    { provide: CONTEXT_LEVELS_PORT, useValue: CONTEXT_LEVELS },
    {
      provide: DashboardRepository,
      useFactory: (spaceDb: SpaceDatabaseService, contextLevels: ContextLevels) =>
        new DashboardRepository(spaceDb.routedKysely, contextLevels),
      inject: [SpaceDatabaseService, CONTEXT_LEVELS_PORT],
    },
    DashboardService,
  ],
  exports: [DashboardService],
})
/** Module dashboard việc cần làm. */
export class DashboardModule {}
