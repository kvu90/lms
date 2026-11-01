import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CalendarRepository } from '@lms/db/repositories/calendar';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GroupsModule } from '../groups/groups.module';
import { CalendarController } from './calendar.controller';
import { CALENDAR_IMPORT_QUEUE, CALENDAR_REMINDER_QUEUE, CalendarService } from './calendar.service';

/**
 * Facade của CalendarModule: CalendarService. Khả năng hiển thị chỉ được tính từ các facade Courses/Enrol/Groups.
 *
 * Từ issue #647, repository của module sống ở `@lms/db` trên
 * Kysely (lớp thuần, không phụ thuộc Nest) nên module lắp nó bằng
 * factory provider trên handle định tuyến theo không gian
 * (`SpaceDatabaseService.routedKysely`) — cùng khuôn lắp repository
 * của pilot control plane.
 */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, GroupsModule, EventsModule, SpaceRoutingModule,
    BullModule.registerQueue({ name: CALENDAR_REMINDER_QUEUE }),
    BullModule.registerQueue({ name: CALENDAR_IMPORT_QUEUE }),
  ],
  controllers: [CalendarController],
  providers: [
    {
      provide: CalendarRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new CalendarRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    CalendarService,
  ],
  exports: [CalendarService],
})
/** Module lịch. */
export class CalendarModule {}
