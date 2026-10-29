import { Module } from '@nestjs/common';
import {
  OutboxWriterService,
  PAID_CLASS_ENROL_ACTIVATION_PORT,
  PAID_ENROL_ACTIVATION_PORT,
  PAYMENT_SETTLEMENT_PORT,
  PaymentsRepository,
  PlanEntitlementsService,
  SepayMatchingService,
} from '@lms/payments';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { ClassesModule } from '../classes/classes.module';
import { ClassesService } from '../classes/classes.service';
import { EnrolModule } from '../enrol/enrol.module';
import { EnrolService } from '../enrol/enrol.service';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PaymentsController } from './payments.controller';
import { ManualPaymentGateway, PAYMENT_GATEWAY, PaymentsService } from './payments.service';
import { SepayIpnConsumer } from './sepay-ipn.consumer';

/** PaymentsModule facade: PaymentsService. Gateway là PORT với adapter manual/fake.
 * Lát 1 VietQR (#189): TenantsModule cho cổng tenant; SepayMatchingService +
 * SepayIpnConsumer lo matching bất đồng bộ cho sự kiện IPN SePay.
 * CLASS-3 (#184): ClassesModule cho seam học phí theo lớp — cổng phía lớp,
 * kích hoạt ghi danh cấp lớp và đình chỉ khi hoàn tiền nằm ở ClassesService
 * (Classes không import Payments nên chiều phụ thuộc này không tạo vòng).
 * Lát 2 (#189): SiteConfigModule cho điểm đọc GIÁ GÓI từ cấu hình hệ
 * thống (giá không ghim trong code); PlanEntitlementsService lo kích
 * hoạt/đình chỉ quyền lợi gói cho cả hai đường thành công (webhook
 * manual và matching SePay).
 * Lát 3 (#189): vòng đời duyệt hoàn + hàng đợi `needs_review` theo chủ
 * tiền nằm ở PaymentsService; điểm đọc ngưỡng duyệt hoàn/ngưỡng quá
 * hạn theo tenant dùng TenantConfigService của TenantsModule; sự kiện
 * `debit` được SepayMatchingService uỷ thác về PaymentsService để đối
 * khớp lệnh chi hoàn (PaymentsService không phụ thuộc matching nên
 * chiều phụ thuộc này không tạo vòng).
 * Issue #538 (con của #522): SepayMatchingService, PaymentsRepository,
 * PlanEntitlementsService và bề mặt phát outbox của matching
 * (OutboxWriterService) thuộc package dùng chung `@lms/payments`;
 * module này đăng ký các class đó làm provider và nối cài đặt cho ba
 * cổng xuyên module của bề mặt matching bằng CHÍNH các service hiện
 * hành của tiến trình API — `PAID_ENROL_ACTIVATION_PORT` →
 * EnrolService, `PAID_CLASS_ENROL_ACTIVATION_PORT` → ClassesService,
 * `PAYMENT_SETTLEMENT_PORT` → PaymentsService — nên luật nghiệp vụ
 * của cả matching lẫn ba hiệu ứng chỉ tồn tại đúng một bản. */
@Module({
  imports: [AccessModule, EnrolModule, EventsModule, TenantsModule, ClassesModule, SiteConfigModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsRepository, PaymentsService, ManualPaymentGateway, PlanEntitlementsService,
    { provide: PAYMENT_GATEWAY, useClass: ManualPaymentGateway },
    OutboxWriterService, SepayMatchingService, SepayIpnConsumer,
    { provide: PAID_ENROL_ACTIVATION_PORT, useExisting: EnrolService },
    { provide: PAID_CLASS_ENROL_ACTIVATION_PORT, useExisting: ClassesService },
    { provide: PAYMENT_SETTLEMENT_PORT, useExisting: PaymentsService },
  ],
  exports: [PaymentsService, SepayMatchingService],
})
export class PaymentsModule {}
