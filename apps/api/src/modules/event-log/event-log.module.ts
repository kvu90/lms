import { Module } from '@nestjs/common';
import { EventLogRepository } from '@lms/db/repositories/event-log';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { AccessModule } from '../access/access.module';
import { EventLogController } from './event-log.controller';
import { EventLogService } from './event-log.service';

/** EventLogModule facade: đường đọc logstore (bảng event_log do infra/events ghi). */
@Module({
  imports: [AccessModule, SpaceRoutingModule],
  controllers: [EventLogController],
  providers: [
    // Repository của package @lms/db chạy trên handle Kysely đã định
    // tuyến theo không gian (issue #648).
    {
      provide: EventLogRepository,
      useFactory: (spaceDatabase: SpaceDatabaseService) => new EventLogRepository(spaceDatabase.routedKysely),
      inject: [SpaceDatabaseService],
    },
    EventLogService,
  ],
  exports: [EventLogService],
})
/** Module nhật ký sự kiện: truy vấn log hợp nhất theo quyền tại context. */
export class EventLogModule {}
