import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CoursesModule } from '../courses/courses.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CohortsController, CourseGroupingsController, CourseGroupsController } from './groups.controller';
import { GroupsRepository } from './groups.repository';
import { GroupsService } from './groups.service';

/** Facade của GroupsModule: GroupsService (groups, groupings, cohorts). Phụ thuộc Courses + Access + registry Availability. */
@Module({
  imports: [AccessModule, CoursesModule, AvailabilityModule, EventsModule, TenantsModule],
  controllers: [CourseGroupsController, CourseGroupingsController, CohortsController],
  providers: [GroupsRepository, GroupsService],
  exports: [GroupsService],
})
/** Module nhóm và cohort. */
export class GroupsModule {}
