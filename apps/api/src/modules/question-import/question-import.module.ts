import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { QuestionsModule } from '../questions/questions.module';
import { QuestionImportController } from './question-import.controller';
import { QuestionImportRepository } from './question-import.repository';
import { QuestionImportService } from './question-import.service';

/** QuestionImportModule: số hoá đề từ file + hàng đợi duyệt vào ngân hàng câu hỏi (issue #52). */
@Module({
  imports: [AccessModule, QuestionsModule, CurriculumModule, EventsModule],
  controllers: [QuestionImportController],
  providers: [QuestionImportRepository, QuestionImportService],
  exports: [QuestionImportService],
})
/** Module nhập đề từ file Word/PDF và hàng đợi duyệt câu hỏi. */
export class QuestionImportModule {}
