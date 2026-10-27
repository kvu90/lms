import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

/**
 * Lập lịch tổng hợp email theo ngày (NB-5, issue #174): mỗi ngày lúc
 * 07:15 giờ Việt Nam (múi giờ chuẩn IANA `Asia/Ho_Chi_Minh`) đưa một
 * job `sweep` vào queue `notification-digests`. Bản thân lượt quét
 * idempotent (mục đã rời trạng thái `digest-queued` thì không được
 * quét lại) nên đăng ký trùng hoặc quét thừa vô hại.
 */
@Injectable()
export class NotificationDigestScheduler implements OnModuleInit {
  private readonly logger = new Logger(NotificationDigestScheduler.name);
  constructor(@InjectQueue('notification-digests') private readonly queue: Queue) {}

  /**
   * Khởi tạo: đăng ký job lặp hằng ngày cho queue tổng hợp email.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'notification-digest-scheduler',
      { pattern: '15 7 * * *', tz: 'Asia/Ho_Chi_Minh' },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true } },
    ).catch((err: Error) => this.logger.warn(`Could not register notification-digest scheduler: ${err.message}`));
  }
}
