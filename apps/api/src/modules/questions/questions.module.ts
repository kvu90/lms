import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { GroupsModule } from '../groups/groups.module';
import { QuestionBanksController } from './question-banks.controller';
import { QuestionBanksRepository } from './question-banks.repository';
import { QuestionBanksService } from './question-banks.service';
import { QuestionsController, QuestionUsagesController, StimuliController } from './questions.controller';
import { QuestionsRepository } from './questions.repository';
import { QuestionsService } from './questions.service';

/** QuestionsModule facade: QuestionsService (bank + engine) + QuestionBanksService (lớp bank có danh tính của feat Ngân hàng câu hỏi chung, cần Groups cho cohort của bank tổ). Depends on Access + Groups. */
@Module({
  imports: [AccessModule, EventsModule, GroupsModule],
  controllers: [QuestionsController, QuestionUsagesController, StimuliController, QuestionBanksController],
  providers: [QuestionsRepository, QuestionsService, QuestionBanksRepository, QuestionBanksService],
  exports: [QuestionsService, QuestionBanksService],
})
/** Module ngân hàng câu hỏi và question engine. */
export class QuestionsModule {}
