import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { GradesModule } from '../grades/grades.module';
import { UsersModule } from '../users/users.module';
import { GuardianLinksController, GuardianViewsController } from './guardians.controller';
import { GuardiansRepository } from './guardians.repository';
import { GuardiansService } from './guardians.service';

/**
 * GuardiansModule (PH-0, issue #116): liên kết giám hộ PH–HS + bề mặt đọc
 * chỉ-xem của phụ huynh trên dữ liệu đã công bố. Phụ thuộc Grades facade
 * (sổ điểm + kết quả VN đã qua cổng công bố), Access (PermissionEvaluator),
 * Users và Events (outbox cho audit).
 */
@Module({
  imports: [AccessModule, UsersModule, GradesModule, EventsModule],
  controllers: [GuardianLinksController, GuardianViewsController],
  providers: [GuardiansRepository, GuardiansService],
  exports: [GuardiansService],
})
/** Module giám hộ. */
export class GuardiansModule {}
