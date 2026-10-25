import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { QuestionsModule } from '../questions/questions.module';
import { QuizModule } from '../quiz/quiz.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { TenantsModule } from '../tenants/tenants.module';
import { ExamDossiersController } from './exam-dossiers.controller';
import { ExamDossiersService } from './exam-dossiers.service';
import { ExamMatrixGenerateController, ExamPapersController } from './exam-papers.controller';
import { ExamPapersRepository } from './exam-papers.repository';
import { ExamPapersService } from './exam-papers.service';

/**
 * ExamPapersModule facade (feat issue #113, EB-1): lớp Ngân hàng đề —
 * thực thể đề snapshot + version + slots ghim trên khuôn bank đa loại
 * của Questions (bank + capability exam:* tại context bank), triển
 * khai vào quiz qua facade của Quiz (deployPaperSlots). Không vòng
 * phụ thuộc: Quiz không phụ thuộc ExamPapers. EB-3 (#165) thêm luồng
 * duyệt BỘ HỒ SƠ (ExamDossiersService — đọc seam cấu hình cấp duyệt 2
 * qua SiteConfigModule) và lớp bảo mật xem đề định kỳ trong chính
 * ExamPapersService.
 */
@Module({
  imports: [AccessModule, EventsModule, QuestionsModule, QuizModule, SiteConfigModule, TenantsModule],
  controllers: [ExamPapersController, ExamMatrixGenerateController, ExamDossiersController],
  providers: [ExamPapersRepository, ExamPapersService, ExamDossiersService],
  exports: [ExamPapersService],
})
/** Module ngân hàng đề (đề snapshot/version/slots + triển khai vào quiz + duyệt bộ hồ sơ). */
export class ExamPapersModule {}
