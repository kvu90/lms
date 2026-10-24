import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { EnrolModule } from '../enrol/enrol.module';
import { FilesModule } from '../files/files.module';
import { GradesModule } from '../grades/grades.module';
import { AssignmentsController, CourseAssignmentsController } from './assignments.controller';
import { AssignmentsRepository } from './assignments.repository';
import { AssignmentsService } from './assignments.service';

/**
 * AssignmentsModule facade: AssignmentsService (hoạt động mod_assign —
 * bài tập nộp tệp/ảnh). Phụ thuộc facade của Courses (course module +
 * context), Enrol (danh sách ghi danh cho bề mặt chấm), Files (lưu trữ
 * dedup + signed URL), Grades (grade item + ghi điểm của hoạt động) và
 * Access (PermissionEvaluator/Contexts) — không vòng phụ thuộc vì không
 * module nào trong số đó phụ thuộc Assignments.
 */
@Module({
  imports: [AccessModule, CoursesModule, EnrolModule, FilesModule, GradesModule, EventsModule],
  controllers: [CourseAssignmentsController, AssignmentsController],
  providers: [AssignmentsRepository, AssignmentsService],
  exports: [AssignmentsService],
})
/** Module hoạt động Bài tập nộp tệp/ảnh (mod_assign). */
export class AssignmentsModule {}
