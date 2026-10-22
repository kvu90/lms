import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

export interface SampleJobResult {
  processed: true;
  jobName: string;
}

@Processor('sample')
/**
 * Processor mẫu kiểm chứng pipeline queue khi phát triển.
 */
export class SampleProcessor extends WorkerHost {
  private readonly logger = new Logger(SampleProcessor.name);
  processedCount = 0;

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<Record<string, unknown>>): Promise<SampleJobResult> {
    this.processedCount += 1;
    this.logger.log(`Processed sample job ${job.id} (${job.name})`);
    return { processed: true, jobName: job.name };
  }
}
