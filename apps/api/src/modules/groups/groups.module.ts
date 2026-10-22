import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CoursesModule } from '../courses/courses.module';
import { CohortsController, CourseGroupsController } from './groups.controller';
import { GroupsRepository } from './groups.repository';
import { GroupsService } from './groups.service';

/** GroupsModule facade: GroupsService (groups, groupings, cohorts). Depends on Courses + Access + Availability registry. */
@Module({
  imports: [AccessModule, CoursesModule, AvailabilityModule, EventsModule],
  controllers: [CourseGroupsController, CohortsController],
  providers: [GroupsRepository, GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
