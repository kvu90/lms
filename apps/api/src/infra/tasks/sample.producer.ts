import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';

export const SAMPLE_QUEUE = 'sample';

@Injectable()
export class SampleProducerService {
  constructor(@InjectQueue(SAMPLE_QUEUE) private readonly queue: Queue) {}

  /**
   * Dedup by jobId: enqueueing the same logical job twice (same dedupKey)
   * returns the existing job instead of creating a duplicate — the BullMQ
   * equivalent of Moodle's adhoc-task dedup.
   */
  async enqueueSample(dedupKey: string, payload: Record<string, unknown>): Promise<Job> {
    return this.queue.add('sample-job', payload, {
      jobId: `sample-${dedupKey}`,
      attempts: 12,
      backoff: { type: 'exponential', delay: 1000 },
    });
  }
}
