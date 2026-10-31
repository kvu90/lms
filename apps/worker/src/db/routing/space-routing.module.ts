import { Module } from '@nestjs/common';
import { SpaceDatabaseService } from './space-database.service';
import { SpaceJobRunner } from './space-job-runner';

/**
 * SpaceRoutingModule của worker (issue #581): khung định tuyến kết
 * nối theo trung tâm cho tác vụ nền — bản sao tổ chức theo tiền lệ
 * mỗi app giữ hạ tầng riêng. Xuất `SpaceDatabaseService` để
 * `worker.module.ts` gắn handle kho chung lúc khởi động và mở
 * phiên theo trung tâm qua cùng khung này; từ issue #582 còn xuất
 * `SpaceJobRunner` — điểm vào để các processor tiêu thụ job outbox
 * chạy trong phiên đúng kho của trung tâm mà job thuộc về.
 */
@Module({
  providers: [SpaceDatabaseService, SpaceJobRunner],
  exports: [SpaceDatabaseService, SpaceJobRunner],
})
export class SpaceRoutingModule {}
