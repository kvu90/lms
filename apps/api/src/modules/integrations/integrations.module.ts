import { Module } from '@nestjs/common';
import { IntegrationsRepository } from '@lms/db/repositories/integrations';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

/** Facade của IntegrationTokensModule: IntegrationsService (hàm registry + token bên ngoài). */
@Module({
  imports: [AccessModule, CoursesModule, SpaceRoutingModule],
  controllers: [IntegrationsController],
  providers: [
    // Repository của package @lms/db chạy trên handle Kysely đã định
    // tuyến theo không gian (issue #648).
    {
      provide: IntegrationsRepository,
      useFactory: (spaceDatabase: SpaceDatabaseService) => new IntegrationsRepository(spaceDatabase.routedKysely),
      inject: [SpaceDatabaseService],
    },
    IntegrationsService,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
