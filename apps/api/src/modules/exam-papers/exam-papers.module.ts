import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { QuestionsModule } from '../questions/questions.module';
import { QuizModule } from '../quiz/quiz.module';
import { ExamMatrixGenerateController, ExamPapersController } from './exam-papers.controller';
import { ExamPapersRepository } from './exam-papers.repository';
import { ExamPapersService } from './exam-papers.service';

/**
 * ExamPapersModule facade (feat issue #113, EB-1): lớp Ngân hàng đề —
 * thực thể đề snapshot + version + slots ghim trên khuôn bank đa loại
 * của Questions (bank + capability exam:* tại context bank), triển
 * khai vào quiz qua facade của Quiz (deployPaperSlots). Không vòng
 * phụ thuộc: Quiz không phụ thuộc ExamPapers.
 */
@Module({
  imports: [AccessModule, EventsModule, QuestionsModule, QuizModule],
  controllers: [ExamPapersController, ExamMatrixGenerateController],
  providers: [ExamPapersRepository, ExamPapersService],
  exports: [ExamPapersService],
})
/** Module ngân hàng đề (đề snapshot/version/slots + triển khai vào quiz). */
export class ExamPapersModule {}
