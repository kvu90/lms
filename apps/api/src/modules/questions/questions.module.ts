import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { QuestionsController, QuestionUsagesController } from './questions.controller';
import { QuestionsRepository } from './questions.repository';
import { QuestionsService } from './questions.service';

/** QuestionsModule facade: QuestionsService (bank + engine). Depends on Access only (report §3.12). */
@Module({
  imports: [AccessModule, EventsModule],
  controllers: [QuestionsController, QuestionUsagesController],
  providers: [QuestionsRepository, QuestionsService],
  exports: [QuestionsService],
})
export class QuestionsModule {}
