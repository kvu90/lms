import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { EnrolModule } from '../enrol/enrol.module';
import { UsersModule } from '../users/users.module';
import { GradesController, SiteGradesController, VnClassificationController, VnGradebooksController } from './grades.controller';
import { GradesRepository } from './grades.repository';
import { GRADE_REGRADE_QUEUE, GradesService } from './grades.service';
import { VnGradebooksService } from './vn-gradebooks.service';

/**
 * GradesModule facade: GradesService. Depends on Courses, Enrol, Access,
 * Completion (facades only — report §3.12). Registers its evaluators into
 * Completion/Courses at bootstrap; the worker consumes the grade-regrade
 * queue for bulk recalculation.
 */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, CompletionModule, EventsModule, UsersModule, CurriculumModule,
    BullModule.registerQueue({ name: GRADE_REGRADE_QUEUE }),
  ],
  controllers: [GradesController, SiteGradesController, VnGradebooksController, VnClassificationController],
  providers: [GradesRepository, GradesService, VnGradebooksService],
  exports: [GradesService, VnGradebooksService],
})
/** Module sổ điểm. */
export class GradesModule {}
