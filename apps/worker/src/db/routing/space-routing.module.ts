import { Module } from '@nestjs/common';
import { SpaceDatabaseService } from './space-database.service';

/**
 * SpaceRoutingModule của worker (issue #581): khung định tuyến kết
 * nối theo trung tâm cho tác vụ nền — bản sao tổ chức theo tiền lệ
 * mỗi app giữ hạ tầng riêng. Xuất `SpaceDatabaseService` để
 * `worker.module.ts` gắn handle kho chung lúc khởi động và để
 * scheduler/processor (ở các issue kế tiếp) mở phiên theo trung
 * tâm qua cùng khung này.
 */
@Module({
  providers: [SpaceDatabaseService],
  exports: [SpaceDatabaseService],
})
export class SpaceRoutingModule {}
