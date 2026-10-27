import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

/** Đăng ký lượt quét đối soát ghi danh cấp lớp lặp lại (mỗi 15 phút — trần lệch một chu kỳ theo hồ sơ lớp học mục 4.2). Bản thân job có tính idempotent. */
@Injectable()
/**
 * Lập lịch đối soát ghi danh cấp lớp theo chu kỳ (đưa job
 * class-enrol-reconcile vào queue): so roster của lớp (nguồn sự thật)
 * với ghi danh đã vật chất hoá ở từng khoá và tự sửa lệch.
 */
export class ClassEnrolReconcileScheduler implements OnModuleInit {
  private readonly logger = new Logger(ClassEnrolReconcileScheduler.name);
  constructor(@InjectQueue('class-enrol-reconcile') private readonly queue: Queue) {}

  /**
   * Khởi tạo: đăng ký job lặp cho queue đối soát ghi danh cấp lớp.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'class-enrol-reconcile-scheduler',
      { every: 15 * 60 * 1000 },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true } },
    ).catch((err: Error) => this.logger.warn(`Could not register class-enrol-reconcile scheduler: ${err.message}`));
  }
}
