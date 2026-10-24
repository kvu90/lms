import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';

/** Registers the repeatable activity due-soon reminder sweep (every 5 minutes, BullMQ job scheduler). The job itself is idempotent (dedupe tại phía phát trên outbox). */
@Injectable()
/**
 * Lập lịch quét nhắc hạn nộp theo chu kỳ (đưa job activity-due-reminders vào queue).
 */
export class ActivityDueReminderScheduler implements OnModuleInit {
  private readonly logger = new Logger(ActivityDueReminderScheduler.name);
  constructor(@InjectQueue('activity-due-reminders') private readonly queue: Queue) {}

  /**
   * Khởi tạo: đăng ký job lặp cho queue nhắc hạn nộp.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'activity-due-reminder-scheduler',
      { every: 5 * 60 * 1000 },
      { name: 'sweep', data: {}, opts: { removeOnComplete: true } },
    ).catch((err: Error) => this.logger.warn(`Could not register activity-due-reminder scheduler: ${err.message}`));
  }
}
