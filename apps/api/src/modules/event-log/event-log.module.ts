import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { EventLogController } from './event-log.controller';
import { EventLogRepository } from './event-log.repository';
import { EventLogService } from './event-log.service';

/** EventLogModule facade: đường đọc logstore (bảng event_log do infra/events ghi). */
@Module({
  imports: [AccessModule],
  controllers: [EventLogController],
  providers: [EventLogRepository, EventLogService],
  exports: [EventLogService],
})
/** Module nhật ký sự kiện: truy vấn log hợp nhất theo quyền tại context. */
export class EventLogModule {}
