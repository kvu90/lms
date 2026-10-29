import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { GradesModule } from '../grades/grades.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { GuardianController, GuardianLinksController } from './guardians.controller';
import { GuardianDigestService } from './guardian-digest.service';
import { GuardianViewRepository } from './guardian-view.repository';
import { GuardianViewService } from './guardian-view.service';
import { GuardiansRepository } from './guardians.repository';
import { GuardiansService } from './guardians.service';

/**
 * GuardiansModule (PH-0, issue #116 + PH-1, issue #130 + PH-2, issue
 * #159): liên kết giám hộ PH–HS + bề mặt đọc chỉ-xem của phụ huynh
 * trên dữ liệu đã công bố + tuỳ chọn tần suất digest. Phụ thuộc
 * Grades facade (sổ điểm + kết quả VN đã qua cổng công bố), Access
 * (PermissionEvaluator), Users, Events (outbox cho audit), Dashboard
 * (tập khoá ghi danh + hàm kết quả mới đã công bố dùng chung với
 * DASH1) và Tenants.
 *
 * Nửa tổng hợp + gửi của digest phụ huynh nằm ở phía WORKER (relay
 * outbox → hàng đợi `guardian-digest-events` →
 * `GuardianDigestHandlerService`, từ issue con #518 của #491): phía
 * API không còn consumer polling cho hai loại sự kiện digest và
 * không còn phụ thuộc MessagingModule — đường phát thông báo của
 * digest là `NotificationDeliveryService.notify` phía worker, dùng
 * chung hàng đợi phát kênh ngoài với phía API.
 */
@Module({
  imports: [AccessModule, UsersModule, GradesModule, EventsModule, DashboardModule, TenantsModule],
  controllers: [GuardianLinksController, GuardianController],
  providers: [
    GuardiansRepository, GuardiansService, GuardianViewRepository, GuardianViewService,
    GuardianDigestService,
  ],
  exports: [GuardiansService],
})
/** Module giám hộ. */
export class GuardiansModule {}
