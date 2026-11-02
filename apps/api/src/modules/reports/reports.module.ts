import { Module } from '@nestjs/common';
import { ReportsRepository } from '@lms/db/repositories/reports';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { MessagingModule } from '../messaging/messaging.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/** Facade của ReportsModule: ReportsService. */
@Module({
  imports: [AccessModule, CoursesModule, MessagingModule, SpaceRoutingModule],
  controllers: [ReportsController],
  providers: [
    // Repository của package @lms/db chạy trên handle Kysely đã định
    // tuyến theo không gian (issue #648).
    {
      provide: ReportsRepository,
      useFactory: (spaceDatabase: SpaceDatabaseService) => new ReportsRepository(spaceDatabase.routedKysely),
      inject: [SpaceDatabaseService],
    },
    ReportsService,
  ],
  exports: [ReportsService],
})
export class ReportsModule {}
