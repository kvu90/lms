import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { OutboxRelayScheduler } from '../src/outbox-relay.scheduler';
import { SampleProcessor } from '../src/processors/sample.processor';
import { WorkerModule } from '../src/worker.module';

describe('Worker smoke (real DB + Redis)', () => {
  let context: INestApplicationContext;

  beforeAll(async () => {
    // In Nest 12, the compiled TestingModule IS the application context.
    context = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await context.init();
  });

  afterAll(async () => {
    await context.close();
  });

  it('boots the worker context with processor and relay providers', () => {
    expect(context.get(SampleProcessor)).toBeInstanceOf(SampleProcessor);
    expect(context.get(OutboxRelayScheduler)).toBeInstanceOf(OutboxRelayScheduler);
  });

  it('processor handles a sample job payload', async () => {
    const processor = context.get(SampleProcessor);
    const fakeJob = { id: 'smoke-1', name: 'sample-job', data: { hello: 'world' } };
    const result = await processor.process(fakeJob as never);
    expect(result).toEqual({ processed: true, jobName: 'sample-job' });
    expect(processor.processedCount).toBe(1);
  });

  it('outbox relay runs against the real database', async () => {
    const relay = context.get(OutboxRelayScheduler);
    await expect(relay.publishPending()).resolves.toBeGreaterThanOrEqual(0);
  });
});
