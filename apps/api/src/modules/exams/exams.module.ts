import { forwardRef, Module } from '@nestjs/common';
import { ExamsRepository } from '@lms/db/repositories/exams';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { QuestionsModule } from '../questions/questions.module';
import { QuizModule } from '../quiz/quiz.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { ExamDossiersService } from './exam-dossiers.service';
import { ExamsController } from './exams.controller';
import { ExamPapersAliasController } from './exam-papers-alias.controller';
import { CourseExamPinsController, ExamPinFeedbacksController, ExamPinOverridesController, ExamPinsController } from './exam-pins.controller';
import { ExamsService } from './exams.service';

/**
 * ExamsModule facade (feat issue #113, EB-1): lớp Ngân hàng đề —
 * thực thể đề snapshot + version + slots ghim trên khuôn bank đa loại
 * của Questions (bank + capability exam:* tại context bank), triển
 * khai vào quiz qua facade của Quiz (deployPaperSlots). EB-3 (#165)
 * thêm luồng duyệt BỘ HỒ SƠ (ExamDossiersService — đọc seam cấu hình
 * cấp duyệt 2 qua SiteConfigModule) và lớp bảo mật xem đề định kỳ
 * trong chính ExamsService.
 *
 * Các vòng module liên quan tới module này là tường minh từ issue
 * #343 (dọn controller trùng path): controller chủ của tiền tố
 * `exam-matrices` ở QuizModule uỷ thác handler sinh đề cho
 * ExamsService của module này, trong khi ExamsService dùng facade
 * của Quiz và của Questions, còn controller chủ của `question-banks`
 * ở QuestionsModule uỷ thác bề mặt ma trận cho QuizModule. Ba module
 * Exams/Quiz/Questions tạo thành một vòng qua lại, nên mọi cạnh
 * import trong vòng đều khai `forwardRef` ở cả hai phía theo khuôn
 * vòng module đã có của repo (Users ↔ Auth ↔ BetterAuth) — nếu một
 * cạnh trong vòng nạp trực tiếp, lớp module ở đầu vòng sẽ là
 * `undefined` khi decorator của module ở cuối vòng chạy. Bề mặt hồ
 * sơ đề đã gộp vào `ExamsController` (chủ duy nhất của tiền tố
 * `exams`); toàn bộ alias `/exam-papers` nằm ở
 * `ExamPapersAliasController`.
 */
@Module({
  imports: [AccessModule, EventsModule, forwardRef(() => QuestionsModule), forwardRef(() => QuizModule), SiteConfigModule, TenantsModule, SpaceRoutingModule],
  controllers: [ExamsController, ExamPapersAliasController, CourseExamPinsController, ExamPinsController, ExamPinOverridesController, ExamPinFeedbacksController],
  providers: [
    // Repository nay thuộc package @lms/db (issue #643): dựng trên
    // handle Kysely định tuyến theo trung tâm — cùng pool
    // TenantAwarePool với đường Drizzle trước đây nên ngữ cảnh
    // GUC/RLS giữ nguyên. Token lớp giữ nguyên để các điểm tiêm và
    // `app.get(ExamsRepository)` không đổi.
    { provide: ExamsRepository, useFactory: (spaceDb: SpaceDatabaseService) => new ExamsRepository(spaceDb.routedKysely), inject: [SpaceDatabaseService] },
    ExamsService, ExamDossiersService,
  ],
  exports: [ExamsService],
})
/** Module ngân hàng đề (đề snapshot/version/slots + triển khai vào quiz + duyệt bộ hồ sơ). */
export class ExamsModule {}
