import { Module } from '@nestjs/common';
import { GroupsRepository } from '@lms/db/repositories/groups';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CoursesModule } from '../courses/courses.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CohortsController, CourseGroupingsController, CourseGroupsController } from './groups.controller';
import { GroupsService } from './groups.service';
import { GroupsTransitionalRepository } from './groups-transitional.repository';

/** Facade của GroupsModule: GroupsService (groups, groupings, cohorts). Phụ thuộc Courses + Access + registry Availability. */
@Module({
  imports: [AccessModule, CoursesModule, AvailabilityModule, EventsModule, TenantsModule, SpaceRoutingModule],
  controllers: [CourseGroupsController, CourseGroupingsController, CohortsController],
  providers: [
    {
      // GroupsRepository nay là repository Kysely của `@lms/db`
      // (issue #645): provider dựng bằng factory với handle kho
      // trung tâm ĐÃ ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely`
      // của SpaceDatabaseService), cùng khuôn với các repository
      // đã chuyển trước đó.
      provide: GroupsRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new GroupsRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    // Repository chuyển tiếp Drizzle của điểm nối C-8/C (đường gỡ
    // thành viên cohort trong transaction settle của payments) —
    // chủ đóng D4 #656, xem file của nó.
    GroupsTransitionalRepository,
    GroupsService,
  ],
  exports: [GroupsService],
})
/** Module nhóm và cohort. */
export class GroupsModule {}
