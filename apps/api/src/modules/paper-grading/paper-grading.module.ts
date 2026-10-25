import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { AccessModule } from '../access/access.module';
import { EnrolModule } from '../enrol/enrol.module';
import { FilesModule } from '../files/files.module';
import { QuizModule } from '../quiz/quiz.module';
import { SiteConfigModule } from '../site-config/site-config.module';
import { UsersModule } from '../users/users.module';
import { ExamBatchesController, ExamScansController } from './paper-grading.controller';
import { PaperGradingRepository } from './paper-grading.repository';
import { PaperGradingService } from './paper-grading.service';

/**
 * PaperGradingModule (CAM-0, issue #112): chấm bài giấy bằng camera —
 * lô in phiếu + OMR xác định + hai hàng chờ + attempt thi giấy. Dùng
 * facade của Quiz (layout ghim + ghi attempt), Enrol + Users (roster),
 * Files (lưu ảnh gốc/ảnh đã nắn), SiteConfig (ngưỡng OMR + hạn giữ
 * ảnh), Access (cổng quiz:gradepaper tại context hoạt động) và Events
 * (outbox → event log cho các thao tác gán/sửa ở hàng chờ, như biên
 * bản sửa lỗi).
 */
@Module({
  imports: [AccessModule, QuizModule, EnrolModule, UsersModule, FilesModule, SiteConfigModule, EventsModule],
  controllers: [ExamBatchesController, ExamScansController],
  providers: [PaperGradingRepository, PaperGradingService],
  exports: [PaperGradingService],
})
export class PaperGradingModule {}
