import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { GroupsModule } from '../groups/groups.module';
import { EnrolController } from './enrol.controller';
import { EnrolRepository } from './enrol.repository';
import { EnrolService } from './enrol.service';

/**
 * EnrolModule facade: EnrolService. Depends on Courses, Groups, Access
 * (report §3.12). Completion registers its related-data probe into
 * EnrolService; Enrol registers its isEnrolled checker into CoursesService —
 * both via registration, not circular imports.
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, EventsModule],
  controllers: [EnrolController],
  providers: [EnrolRepository, EnrolService],
  exports: [EnrolService],
})
export class EnrolModule {}
