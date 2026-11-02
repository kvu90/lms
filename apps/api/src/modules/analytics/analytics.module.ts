import { Module } from '@nestjs/common';
import { AnalyticsRepository } from '@lms/db/repositories/analytics';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/** Facade của AnalyticsModule: AnalyticsService. */
@Module({
  imports: [AccessModule, CoursesModule, EnrolModule, SpaceRoutingModule],
  controllers: [AnalyticsController],
  providers: [
    // Repository của package @lms/db chạy trên handle Kysely đã định
    // tuyến theo không gian (issue #648) — cùng khuôn lắp ráp với
    // repository control plane của pilot.
    {
      provide: AnalyticsRepository,
      useFactory: (spaceDatabase: SpaceDatabaseService) => new AnalyticsRepository(spaceDatabase.routedKysely),
      inject: [SpaceDatabaseService],
    },
    AnalyticsService,
  ],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
