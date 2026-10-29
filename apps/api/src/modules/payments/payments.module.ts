import { Module } from '@nestjs/common';
import {
  PaymentsRepository,
  PlanEntitlementsService,
} from '@lms/payments';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { ClassesModule } from '../classes/classes.module';
import { EnrolModule } from '../enrol/enrol.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PaymentsController } from './payments.controller';
import { ManualPaymentGateway, PAYMENT_GATEWAY, PaymentsService } from './payments.service';

/** PaymentsModule facade: PaymentsService. Gateway là PORT với adapter manual/fake.
 * Lát 1 VietQR (#189): TenantsModule cho cổng tenant; endpoint IPN
 * SePay chỉ ghi sự kiện vào `payment_provider_events` rồi trả lời
 * ngay — matching bất đồng bộ chạy ở điểm quét phía worker (issue
 * con #539 của #522), không còn consumer nào trong tiến trình API.
 * CLASS-3 (#184): ClassesModule cho seam học phí theo lớp — cổng phía lớp,
 * kích hoạt ghi danh cấp lớp và đình chỉ khi hoàn tiền nằm ở ClassesService
 * (Classes không import Payments nên chiều phụ thuộc này không tạo vòng).
 * Lát 2 (#189): SiteConfigModule cho điểm đọc GIÁ GÓI từ cấu hình hệ
 * thống (giá không ghim trong code); PlanEntitlementsService lo kích
 * hoạt/đình chỉ quyền lợi gói cho cả hai đường thành công (webhook
 * manual và matching SePay).
 * Lát 3 (#189): vòng đời duyệt hoàn + hàng đợi `needs_review` theo chủ
 * tiền nằm ở PaymentsService; điểm đọc ngưỡng duyệt hoàn/ngưỡng quá
 * hạn theo tenant dùng TenantConfigService của TenantsModule.
 * Issue #538 (con của #522): SepayMatchingService, PaymentsRepository,
 * PlanEntitlementsService và bề mặt phát outbox của matching
 * (OutboxWriterService) thuộc package dùng chung `@lms/payments`;
 * từ issue #539, toàn bộ ngăn xếp matching (service, writer và cài
 * đặt cho ba cổng xuyên module của nó) chỉ đăng ký phía worker —
 * module này giữ lại đúng hai class mà facade thanh toán dùng trực
 * tiếp (PaymentsRepository, PlanEntitlementsService) cho các đường
 * webhook manual, duyệt hoàn và hàng đợi `needs_review`. */
@Module({
  imports: [AccessModule, EnrolModule, EventsModule, TenantsModule, ClassesModule, SiteConfigModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsRepository, PaymentsService, ManualPaymentGateway, PlanEntitlementsService,
    { provide: PAYMENT_GATEWAY, useClass: ManualPaymentGateway },
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}
