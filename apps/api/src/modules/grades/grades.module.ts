import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { EnrolModule } from '../enrol/enrol.module';
import { UsersModule } from '../users/users.module';
import { GradesController } from './grades.controller';
import { GradesRepository } from './grades.repository';
import { GradesService } from './grades.service';

/**
 * GradesModule facade: GradesService (điểm theo từng bài). Depends on
 * Courses, Enrol, Access, Completion (facades only). Registers its
 * evaluators into Completion/Courses at bootstrap.
 */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, CompletionModule, EventsModule, UsersModule, CurriculumModule,
  ],
  controllers: [GradesController],
  providers: [GradesRepository, GradesService],
  exports: [GradesService],
})
/** Module điểm theo bài. */
export class GradesModule {}
