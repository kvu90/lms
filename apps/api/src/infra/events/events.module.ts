import { forwardRef, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventLogWriter } from './event-log-writer.service';
import { OutboxService } from './outbox.service';

/**
 * Module hạ tầng sự kiện: outbox giao dịch và writer phản chiếu
 * event log. Sau chuyển đổi Kysely (D1, issue #653) cả hai service
 * nhận handle Kysely kho trung tâm qua factory trên facade định
 * tuyến theo không gian (`SpaceDatabaseService.routedKysely`) —
 * cùng khuôn lắp repository của các module đã chuyển. Cạnh import
 * SpaceRoutingModule dùng forwardRef vì module này nằm trong vòng
 * module tường minh AccessModule → EventsModule → SpaceRoutingModule
 * → ControlPlaneModule → AccessModule (cùng khuôn các cạnh còn lại
 * của vòng).
 */
@Module({
  imports: [EventEmitterModule.forRoot(), forwardRef(() => SpaceRoutingModule)],
  providers: [
    {
      provide: OutboxService,
      useFactory: (spaceDb: SpaceDatabaseService) => new OutboxService(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    {
      provide: EventLogWriter,
      useFactory: (spaceDb: SpaceDatabaseService) => new EventLogWriter(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
  ],
  exports: [OutboxService, EventLogWriter],
})
export class EventsModule {}
