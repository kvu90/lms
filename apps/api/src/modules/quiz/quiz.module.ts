import { forwardRef, Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CoursesModule } from '../courses/courses.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { EnrolModule } from '../enrol/enrol.module';
import { ExamsModule } from '../exams/exams.module';
import { FilesModule } from '../files/files.module';
import { GradesModule } from '../grades/grades.module';
import { GroupsModule } from '../groups/groups.module';
import { QuestionsModule } from '../questions/questions.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { ExamMatricesController, QuizAttemptsController } from './quiz.controller';
import { MatrixBanksService } from './matrix-banks.service';
import { MatrixImportService } from './matrix-import.service';
import { QuizRepository } from './quiz.repository';
import { QuizService } from './quiz.service';

/**
 * QuizModule facade: QuizService (hoạt động mod_quiz trên question
 * engine). Phụ thuộc facade của Courses (course module + context),
 * Questions (bank + engine), Grades (grade item + ghi điểm của hoạt
 * động), Users (tên hiển thị học sinh cho thống kê câu sai) và Access
 * (PermissionEvaluator/Contexts).
 *
 * Hai vòng module là tường minh từ issue #343 (dọn controller trùng
 * path), cả hai phía đều khai `forwardRef` theo khuôn vòng module đã
 * có của repo (Users ↔ Auth ↔ BetterAuth):
 * - Quiz ↔ Questions: controller chủ của tiền tố `question-banks` ở
 *   QuestionsModule uỷ thác bề mặt ma trận của bank cho
 *   MatrixBanksService của module này, trong khi QuizService dùng
 *   facade của Questions.
 * - Quiz ↔ Exams: `ExamMatricesController` của module này uỷ thác
 *   handler sinh đề cho ExamsService của ExamsModule, trong khi
 *   ExamsService dùng facade của Quiz.
 */
@Module({
  imports: [AccessModule, CoursesModule, forwardRef(() => QuestionsModule), GradesModule, UsersModule, GroupsModule, CurriculumModule, EventsModule, TenantsModule, EnrolModule, FilesModule, forwardRef(() => ExamsModule)],
  controllers: [QuizAttemptsController, ExamMatricesController],
  providers: [QuizRepository, QuizService, MatrixBanksService, MatrixImportService],
  exports: [QuizService, MatrixBanksService],
})
/** Module hoạt động Quiz (đề thi trong khoá học). */
export class QuizModule {}
