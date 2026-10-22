import { BullModule } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { redisConnectionFromUrl, validateEnv } from '../../config/env';
import { DistributedLockService } from './distributed-lock.service';
import { SAMPLE_QUEUE, SampleProducerService } from './sample.producer';
import { SampleScheduledService } from './sample.scheduled';
import { TasksModule } from './tasks.module';

@Injectable()
class QueueProbe {
  constructor(@InjectQueue(SAMPLE_QUEUE) readonly queue: Queue) {}
}

describe('TasksModule (BullMQ dedup + lock, real Redis)', () => {
  let moduleRef: TestingModule;
  let producer: SampleProducerService;
  let scheduled: SampleScheduledService;
  let lock: DistributedLockService;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
        BullModule.forRootAsync({
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            connection: redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
          }),
        }),
        TasksModule,
        BullModule.registerQueue({ name: SAMPLE_QUEUE }),
      ],
      providers: [QueueProbe],
    }).compile();
    producer = moduleRef.get(SampleProducerService);
    scheduled = moduleRef.get(SampleScheduledService);
    lock = moduleRef.get(DistributedLockService);
    queue = moduleRef.get(QueueProbe).queue;
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('dedups queue jobs by jobId', async () => {
    const first = await producer.enqueueSample('dedup-1', { hello: 'world' });
    const second = await producer.enqueueSample('dedup-1', { hello: 'world' });
    expect(second.id).toBe(first.id);
    const counts = await queue.getJobCounts('waiting', 'delayed', 'prioritized');
    const total = counts.waiting + counts.delayed + counts.prioritized;
    expect(total).toBe(1);
  });

  it('lock: a second acquire fails until the owner releases', async () => {
    const token = await lock.acquire('infra-test-lock', 5_000);
    expect(token).not.toBeNull();
    await expect(lock.acquire('infra-test-lock', 5_000)).resolves.toBeNull();
    await lock.release('infra-test-lock', token!);
    await expect(lock.acquire('infra-test-lock', 5_000)).resolves.not.toBeNull();
  });

  it('scheduled job body runs exactly once under concurrency', async () => {
    scheduled.executions = 0;
    const results = await Promise.all([scheduled.runOnce(), scheduled.runOnce()]);
    expect(results.sort()).toEqual(['ran', 'skipped']);
    expect(scheduled.executions).toBe(1);
  });
});
