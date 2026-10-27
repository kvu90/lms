import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

/** Đăng ký lượt quét hết hạn ghi danh lặp lại (mỗi 5 phút, BullMQ job scheduler). Bản thân job có tính idempotent. */
@Injectable()
/**
 * Lập lịch quét ghi danh quá hạn theo chu kỳ (đưa job enrol-expiry vào queue).
 */
export class EnrolExpiryScheduler implements OnModuleInit {
  private readonly logger = new Logger(EnrolExpiryScheduler.name);
  constructor(@InjectQueue('enrol-expiry') private readonly queue: Queue) {}

  /**
   * Khởi tạo: đăng ký job lặp cho queue hết hạn ghi danh.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'enrol-expiry-scheduler',
      { every: 5 * 60 * 1000 },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true } },
    ).catch((err: Error) => this.logger.warn(`Could not register enrol-expiry scheduler: ${err.message}`));
  }
}
