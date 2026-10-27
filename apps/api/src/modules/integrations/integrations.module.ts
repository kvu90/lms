import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsRepository } from './integrations.repository';
import { IntegrationsService } from './integrations.service';

/** Facade của IntegrationTokensModule: IntegrationsService (hàm registry + token bên ngoài). */
@Module({
  imports: [AccessModule, CoursesModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsRepository, IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
