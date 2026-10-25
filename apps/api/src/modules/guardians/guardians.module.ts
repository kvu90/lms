import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { GradesModule } from '../grades/grades.module';
import { UsersModule } from '../users/users.module';
import { GuardianSurfaceController, GuardianLinksController, GuardianViewsController } from './guardians.controller';
import { GuardianViewRepository } from './guardian-view.repository';
import { GuardianViewService } from './guardian-view.service';
import { GuardiansRepository } from './guardians.repository';
import { GuardiansService } from './guardians.service';

/**
 * GuardiansModule (PH-0, issue #116 + PH-1, issue #130): liên kết giám hộ
 * PH–HS + bề mặt đọc chỉ-xem của phụ huynh trên dữ liệu đã công bố. Phụ
 * thuộc Grades facade (sổ điểm + kết quả VN đã qua cổng công bố), Access
 * (PermissionEvaluator), Users, Events (outbox cho audit) và Dashboard
 * (tập khoá ghi danh + hàm kết quả mới đã công bố dùng chung với DASH1).
 */
@Module({
  imports: [AccessModule, UsersModule, GradesModule, EventsModule, DashboardModule],
  controllers: [GuardianLinksController, GuardianViewsController, GuardianSurfaceController],
  providers: [GuardiansRepository, GuardiansService, GuardianViewRepository, GuardianViewService],
  exports: [GuardiansService],
})
/** Module giám hộ. */
export class GuardiansModule {}
