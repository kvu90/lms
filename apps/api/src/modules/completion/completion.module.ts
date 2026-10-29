import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { AvailabilityModule } from '../availability/availability.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { CompletionController, CourseModuleCompletionController } from './completion.controller';
import { CompletionReaggregationOutboxConsumer } from './completion-reaggregation-outbox.consumer';
import { CompletionRepository } from './completion.repository';
import { COMPLETION_QUEUE, CompletionService } from './completion.service';

/** Facade của CompletionModule: CompletionService. Phụ thuộc Courses, Enrol, registry Availability, Access (report §3.12).
 * Consumer tái tổng hợp sau gỡ ghi danh sống trong module này vì nó là phía
 * tiêu thụ sự kiện `course_completion_reaggregation_requested` qua mốc seq riêng. */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, AvailabilityModule, EventsModule,
    BullModule.registerQueue({ name: COMPLETION_QUEUE }),
  ],
  controllers: [CompletionController, CourseModuleCompletionController],
  providers: [CompletionRepository, CompletionService, CompletionReaggregationOutboxConsumer],
  exports: [CompletionService],
})
/** Module theo dõi hoàn thành. */
export class CompletionModule {}
