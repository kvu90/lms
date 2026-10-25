import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { EnrolModule } from '../enrol/enrol.module';
import { TenantsModule } from '../tenants/tenants.module';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { ManualPaymentGateway, PAYMENT_GATEWAY, PaymentsService } from './payments.service';
import { SepayIpnConsumer } from './sepay-ipn.consumer';
import { SepayMatchingService } from './sepay-matching.service';

/** PaymentsModule facade: PaymentsService. Gateway là PORT với adapter manual/fake.
 * Lát 1 VietQR (#189): TenantsModule cho cổng tenant; SepayMatchingService +
 * SepayIpnConsumer lo matching bất đồng bộ cho sự kiện IPN SePay. */
@Module({
  imports: [AccessModule, EnrolModule, EventsModule, TenantsModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsRepository, PaymentsService, ManualPaymentGateway,
    { provide: PAYMENT_GATEWAY, useClass: ManualPaymentGateway },
    SepayMatchingService, SepayIpnConsumer,
  ],
  exports: [PaymentsService, SepayMatchingService],
})
export class PaymentsModule {}
