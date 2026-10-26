import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { EnrolModule } from '../enrol/enrol.module';
import { FilesModule } from '../files/files.module';
import { GradesModule } from '../grades/grades.module';
import { GroupsModule } from '../groups/groups.module';
import { QuestionsModule } from '../questions/questions.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { ExamMatricesController, QuizAttemptsController } from './quiz.controller';
import { ExamMatrixBankController, QuestionBankMatricesController } from './matrix-banks.controller';
import { MatrixBanksService } from './matrix-banks.service';
import { QuizRepository } from './quiz.repository';
import { QuizService } from './quiz.service';

/**
 * QuizModule facade: QuizService (hoạt động mod_quiz trên question
 * engine). Phụ thuộc facade của Courses (course module + context),
 * Questions (bank + engine), Grades (grade item + ghi điểm của hoạt
 * động), Users (tên hiển thị học sinh cho thống kê câu sai) và Access
 * (PermissionEvaluator/Contexts) — không vòng phụ thuộc vì không module
 * nào trong số đó phụ thuộc Quiz.
 */
@Module({
  imports: [AccessModule, CoursesModule, QuestionsModule, GradesModule, UsersModule, GroupsModule, CurriculumModule, EventsModule, TenantsModule, EnrolModule, FilesModule],
  controllers: [QuizAttemptsController, ExamMatricesController, ExamMatrixBankController, QuestionBankMatricesController],
  providers: [QuizRepository, QuizService, MatrixBanksService],
  exports: [QuizService, MatrixBanksService],
})
/** Module hoạt động Quiz (đề thi trong khoá học). */
export class QuizModule {}
