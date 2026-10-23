import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventLogWriter } from './event-log-writer.service';
import { OutboxRelayService } from './outbox-relay.service';
import { OutboxService } from './outbox.service';

@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [OutboxService, OutboxRelayService, EventLogWriter],
  exports: [OutboxService, OutboxRelayService, EventLogWriter],
})
export class EventsModule {}
