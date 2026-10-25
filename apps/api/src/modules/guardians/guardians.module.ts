import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { GradesModule } from '../grades/grades.module';
import { MessagingModule } from '../messaging/messaging.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { GuardianSurfaceController, GuardianLinksController, GuardianViewsController } from './guardians.controller';
import { GuardianDigestConsumer } from './guardian-digest.consumer';
import { GuardianDigestRepository } from './guardian-digest.repository';
import { GuardianDigestService } from './guardian-digest.service';
import { GUARDIAN_DIGEST_ZALO_PORT, LogOnlyGuardianDigestZaloPort } from './guardian-digest-zalo.port';
import { GuardianViewRepository } from './guardian-view.repository';
import { GuardianViewService } from './guardian-view.service';
import { GuardiansRepository } from './guardians.repository';
import { GuardiansService } from './guardians.service';

/**
 * GuardiansModule (PH-0, issue #116 + PH-1, issue #130 + PH-2, issue
 * #159): liên kết giám hộ PH–HS + bề mặt đọc chỉ-xem của phụ huynh
 * trên dữ liệu đã công bố + digest định kỳ tổng hợp từ đúng các đường
 * đọc đó. Phụ thuộc Grades facade (sổ điểm + kết quả VN đã qua cổng
 * công bố), Access (PermissionEvaluator), Users, Events (outbox cho
 * audit), Dashboard (tập khoá ghi danh + hàm kết quả mới đã công bố
 * dùng chung với DASH1) và Messaging (MessagingService.notify là điểm
 * gửi thông báo duy nhất; MessagingModule không phụ thuộc ngược lại
 * module này nên không có vòng phụ thuộc).
 */
@Module({
  imports: [AccessModule, UsersModule, GradesModule, EventsModule, DashboardModule, MessagingModule, TenantsModule],
  controllers: [GuardianLinksController, GuardianViewsController, GuardianSurfaceController],
  providers: [
    GuardiansRepository, GuardiansService, GuardianViewRepository, GuardianViewService,
    GuardianDigestRepository, GuardianDigestService, GuardianDigestConsumer,
    { provide: GUARDIAN_DIGEST_ZALO_PORT, useClass: LogOnlyGuardianDigestZaloPort },
  ],
  exports: [GuardiansService],
})
/** Module giám hộ. */
export class GuardiansModule {}
