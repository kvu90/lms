import { Module } from '@nestjs/common';
import { AssignmentsRepository } from '@lms/db/repositories/assignments';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { FilesModule } from '../files/files.module';
import { GradesModule } from '../grades/grades.module';
import { UsersModule } from '../users/users.module';
import { AssignCommentBankController, AssignmentsController, CourseAssignmentsController } from './assignments.controller';
import { AssignmentsService } from './assignments.service';

/**
 * AssignmentsModule facade: AssignmentsService (hoạt động mod_assign —
 * bài tập nộp tệp/ảnh). Phụ thuộc facade của Courses (course module +
 * context), Enrol (danh sách ghi danh cho bề mặt chấm), Files (lưu trữ
 * dedup + signed URL), Grades (grade item + ghi điểm của hoạt động) và
 * Access (PermissionEvaluator/Contexts) — không vòng phụ thuộc vì không
 * module nào trong số đó phụ thuộc Assignments. Repository của module
 * nằm ở `@lms/db/repositories/assignments` trên Kysely và được dựng
 * bằng factory trên facade định tuyến kho trung tâm
 * (`SpaceDatabaseService.routedKysely`).
 */
@Module({
  imports: [AccessModule, CoursesModule, EnrolModule, FilesModule, GradesModule, UsersModule, EventsModule, SpaceRoutingModule],
  controllers: [CourseAssignmentsController, AssignmentsController, AssignCommentBankController],
  providers: [
    {
      provide: AssignmentsRepository,
      useFactory: (spaceDb: SpaceDatabaseService) => new AssignmentsRepository(spaceDb.routedKysely),
      inject: [SpaceDatabaseService],
    },
    AssignmentsService,
  ],
  exports: [AssignmentsService],
})
/** Module hoạt động Bài tập nộp tệp/ảnh (mod_assign). */
export class AssignmentsModule {}
