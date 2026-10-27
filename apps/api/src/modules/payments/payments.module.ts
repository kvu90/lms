import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { ClassesModule } from '../classes/classes.module';
import { EnrolModule } from '../enrol/enrol.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { ManualPaymentGateway, PAYMENT_GATEWAY, PaymentsService } from './payments.service';
import { SepayIpnConsumer } from './sepay-ipn.consumer';
import { PlanEntitlementsService } from './plan-entitlements.service';
import { SepayMatchingService } from './sepay-matching.service';

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
 * chiều phụ thuộc này không tạo vòng). */
@Module({
  imports: [AccessModule, EnrolModule, EventsModule, TenantsModule, ClassesModule, SiteConfigModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsRepository, PaymentsService, ManualPaymentGateway, PlanEntitlementsService,
    { provide: PAYMENT_GATEWAY, useClass: ManualPaymentGateway },
    SepayMatchingService, SepayIpnConsumer,
  ],
  exports: [PaymentsService, SepayMatchingService],
})
export class PaymentsModule {}
