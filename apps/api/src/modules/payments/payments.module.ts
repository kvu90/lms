import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { EnrolModule } from '../enrol/enrol.module';
import { PaymentsController } from './payments.controller';
import { PaymentsRepository } from './payments.repository';
import { ManualPaymentGateway, PAYMENT_GATEWAY, PaymentsService } from './payments.service';

/** PaymentsModule facade: PaymentsService. Gateway là PORT với adapter manual/fake. */
@Module({
  imports: [AccessModule, EnrolModule, EventsModule],
  controllers: [PaymentsController],
  providers: [PaymentsRepository, PaymentsService, ManualPaymentGateway, { provide: PAYMENT_GATEWAY, useClass: ManualPaymentGateway }],
  exports: [PaymentsService],
})
export class PaymentsModule {}
