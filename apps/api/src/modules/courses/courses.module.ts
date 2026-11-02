import { Module } from '@nestjs/common';
import { CoursesRepository } from '@lms/db/repositories/courses';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CoursesController } from './courses.controller';
import { CoursesService } from './courses.service';

/** Facade của CoursesModule: CoursesService. Phụ thuộc Access, CustomFields, Availability (report §3.12). */
@Module({
  imports: [AccessModule, CustomFieldsModule, AvailabilityModule, EventsModule, TenantsModule, SpaceRoutingModule],
  controllers: [CoursesController],
  providers: [
    {
      // CoursesRepository nay là repository Kysely của `@lms/db`
      // (issue #645): provider dựng bằng factory với handle kho
      // trung tâm ĐÃ ĐỊNH TUYẾN THEO KHÔNG GIAN (`routedKysely`
      // của SpaceDatabaseService — cùng pool dùng chung có gắn
      // ngữ cảnh tenant mà tầng Drizzle đang chạy trên đó), không
      // phải handle tĩnh theo một database cố định.
      provide: CoursesRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new CoursesRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    CoursesService,
  ],
  exports: [CoursesService],
})
/** Module khoá học. */
export class CoursesModule {}
