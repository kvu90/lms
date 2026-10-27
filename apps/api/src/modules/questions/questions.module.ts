import { forwardRef, Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { FilesModule } from '../files/files.module';
import { GroupsModule } from '../groups/groups.module';
import { QuizModule } from '../quiz/quiz.module';
import { TenantsModule } from '../tenants/tenants.module';
import { QuestionBanksController } from './question-banks.controller';
import { QuestionBanksRepository } from './question-banks.repository';
import { QuestionBanksService } from './question-banks.service';
import { QuestionsController, QuestionUsagesController, StimuliController } from './questions.controller';
import { QuestionsRepository } from './questions.repository';
import { QuestionsService } from './questions.service';

/**
 * QuestionsModule facade: QuestionsService (bank + engine) +
 * QuestionBanksService (lớp bank có danh tính của feat Ngân hàng câu
 * hỏi chung, cần Groups cho cohort của bank tổ). Depends on Access +
 * Groups.
 *
 * Vòng module Questions ↔ Quiz là tường minh từ issue #343 (dọn
 * controller trùng path): `QuestionBanksController` của module này —
 * chủ duy nhất của tiền tố `question-banks` — uỷ thác bề mặt ma trận
 * của bank cho MatrixBanksService của QuizModule, trong khi
 * QuizModule dùng facade của Questions; hai phía đều khai
 * `forwardRef` theo khuôn vòng module đã có của repo (Users ↔ Auth ↔
 * BetterAuth).
 */
@Module({
  imports: [AccessModule, EventsModule, GroupsModule, TenantsModule, FilesModule, forwardRef(() => QuizModule)],
  controllers: [QuestionsController, QuestionUsagesController, StimuliController, QuestionBanksController],
  providers: [QuestionsRepository, QuestionsService, QuestionBanksRepository, QuestionBanksService],
  exports: [QuestionsService, QuestionBanksService],
})
/** Module ngân hàng câu hỏi và question engine. */
export class QuestionsModule {}
