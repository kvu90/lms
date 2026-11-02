import { Module } from '@nestjs/common';
import { GradesRepository } from '@lms/db/repositories/grades';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CompletionModule } from '../completion/completion.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { EnrolModule } from '../enrol/enrol.module';
import { UsersModule } from '../users/users.module';
import { GradeItemsController, GradeRecordsController } from './grade-items.controller';
import { CourseGradeExportsController, CourseGradeItemsController, CourseGradebookController } from './grades.controller';
import { LegacyGradesCourseController, LegacyGradesPhantomController } from './legacy-grades.controller';
import { GradesService } from './grades.service';

/**
 * GradesModule facade: GradesService (điểm theo từng bài). Depends on
 * Courses, Enrol, Access, Completion (chỉ qua facade). Đăng ký các
 * evaluator của nó vào Completion/Courses lúc khởi động.
 *
 * GradesRepository là repository Kysely của `@lms/db` (issue
 * #644): provider dựng bằng factory với handle kho trung tâm đã
 * định tuyến theo không gian (`routedKysely` của
 * SpaceDatabaseService). Ba luồng ghi điểm (`setGrade`,
 * `recordActivityGrade`, `updateGrade`) chạy trọn trong
 * transaction Kysely của repository này kèm `enqueueKysely` của
 * OutboxService — repository chuyển tiếp phía bộ máy cũ của chúng
 * đã xoá ở issue #663 khi bộ máy cũ rời khỏi cây.
 */
@Module({
  imports: [
    AccessModule, CoursesModule, EnrolModule, CompletionModule, EventsModule, UsersModule, CurriculumModule, SpaceRoutingModule,
  ],
  controllers: [CourseGradeItemsController, CourseGradebookController, CourseGradeExportsController, GradeItemsController, GradeRecordsController, LegacyGradesCourseController, LegacyGradesPhantomController],
  providers: [
    {
      provide: GradesRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new GradesRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    GradesService,
  ],
  exports: [GradesService],
})
/** Module điểm theo bài. */
export class GradesModule {}
