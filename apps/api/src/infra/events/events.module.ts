import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventLogWriter } from './event-log-writer.service';
import { OutboxService } from './outbox.service';

@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [OutboxService, EventLogWriter],
  exports: [OutboxService, EventLogWriter],
})
export class EventsModule {}
