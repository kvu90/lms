import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DistributedLockService } from './distributed-lock.service';

/**
 * Sample scheduled job guarded by the Redis lock so two app instances firing
 * on the same cron tick execute the body exactly once.
 */
@Injectable()
export class SampleScheduledService {
  private readonly logger = new Logger(SampleScheduledService.name);
  executions = 0;

  constructor(
    @Inject(DistributedLockService) private readonly lock: DistributedLockService,
  ) {}

  @Cron('0 */5 * * * *')
  async handleCron(): Promise<void> {
    await this.runOnce();
  }

  async runOnce(): Promise<'ran' | 'skipped'> {
    const token = await this.lock.acquire('sample-scheduled', 30_000);
    if (!token) {
      this.logger.debug('Skipped: another instance holds the lock');
      return 'skipped';
    }
    try {
      // Small delay so concurrent callers genuinely overlap in tests.
      await new Promise((resolve) => setTimeout(resolve, 50));
      this.executions += 1;
      return 'ran';
    } finally {
      await this.lock.release('sample-scheduled', token);
    }
  }
}
