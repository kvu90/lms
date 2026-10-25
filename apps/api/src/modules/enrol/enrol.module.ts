import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagingModule } from '../messaging/messaging.module';
import { TenantsModule } from '../tenants/tenants.module';
import { EnrolController } from './enrol.controller';
import { EnrolRepository } from './enrol.repository';
import { EnrolService } from './enrol.service';

/**
 * EnrolModule facade: EnrolService. Depends on Courses, Groups, Access
 * (report §3.12). Completion registers its related-data probe into
 * EnrolService; Enrol registers its isEnrolled checker into CoursesService —
 * both via registration, not circular imports. MessagingModule is imported
 * directly for welcome messages: Messaging depends only on Access/Users/
 * Events, so there is no module cycle (same pattern as Badges/Reports).
 */
@Module({
  imports: [AccessModule, CoursesModule, GroupsModule, EventsModule, MessagingModule, TenantsModule],
  controllers: [EnrolController],
  providers: [EnrolRepository, EnrolService],
  exports: [EnrolService],
})
/** Module ghi danh. */
export class EnrolModule {}
