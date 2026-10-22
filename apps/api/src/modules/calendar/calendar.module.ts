import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { GroupsModule } from '../groups/groups.module';
import { CalendarController } from './calendar.controller';
import { CalendarRepository } from './calendar.repository';
import { CALENDAR_IMPORT_QUEUE, CALENDAR_REMINDER_QUEUE, CalendarService } from './calendar.service';

/** CalendarModule facade: CalendarService. Visibility is computed from Courses/Enrol/Groups facades only. */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, GroupsModule, EventsModule,
    BullModule.registerQueue({ name: CALENDAR_REMINDER_QUEUE }),
    BullModule.registerQueue({ name: CALENDAR_IMPORT_QUEUE }),
  ],
  controllers: [CalendarController],
  providers: [CalendarRepository, CalendarService],
  exports: [CalendarService],
})
export class CalendarModule {}
