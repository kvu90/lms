import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { CompletionRepository } from '@lms/db/repositories/completion';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { CompletionController, CourseModuleCompletionController } from './completion.controller';
import { CompletionReaggregationOutboxConsumer } from './completion-reaggregation-outbox.consumer';
import { COMPLETION_QUEUE, CompletionService } from './completion.service';

/** Facade của CompletionModule: CompletionService. Phụ thuộc Courses, Enrol, registry Availability, Access (report §3.12).
 * Consumer tái tổng hợp sau gỡ ghi danh sống trong module này vì nó là phía
 * tiêu thụ sự kiện `course_completion_reaggregation_requested` qua mốc seq riêng.
 * Repository của module nằm ở `@lms/db/repositories/completion` trên Kysely và
 * được dựng bằng factory trên facade định tuyến kho trung tâm
 * (`SpaceDatabaseService.routedKysely`). */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, AvailabilityModule, EventsModule, SpaceRoutingModule,
    BullModule.registerQueue({ name: COMPLETION_QUEUE }),
  ],
  controllers: [CompletionController, CourseModuleCompletionController],
  providers: [
    {
      provide: CompletionRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new CompletionRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    CompletionService,
    CompletionReaggregationOutboxConsumer,
  ],
  exports: [CompletionService],
})
/** Module theo dõi hoàn thành. */
export class CompletionModule {}
