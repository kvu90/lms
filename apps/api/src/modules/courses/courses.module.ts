import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { CoursesController } from './courses.controller';
import { CoursesRepository } from './courses.repository';
import { CoursesService } from './courses.service';

/** CoursesModule facade: CoursesService. Depends on Access, CustomFields, Availability (report §3.12). */
@Module({
  imports: [AccessModule, CustomFieldsModule, AvailabilityModule, EventsModule],
  controllers: [CoursesController],
  providers: [CoursesRepository, CoursesService],
  exports: [CoursesService],
})
/** Module khoá học. */
export class CoursesModule {}
