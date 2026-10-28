import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { OutboxRelayScheduler } from '../../../src/outbox-relay.scheduler';
import { FileCleanupProcessor } from '../../../src/processors/file-cleanup.processor';
import { WorkerModule } from '../../../src/worker.module';

describe('Worker smoke (real DB + Redis)', () => {
  let context: INestApplicationContext;

  beforeAll(async () => {
    // Trong Nest 12, TestingModule đã biên dịch CHÍNH LÀ application context.
    context = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await context.init();
  });

  afterAll(async () => {
    await context.close();
  });

  it('boots the worker context with processor and relay providers', () => {
    expect(context.get(FileCleanupProcessor)).toBeInstanceOf(FileCleanupProcessor);
    expect(context.get(OutboxRelayScheduler)).toBeInstanceOf(OutboxRelayScheduler);
  });

  it('outbox relay runs against the real database', async () => {
    const relay = context.get(OutboxRelayScheduler);
    await expect(relay.publishPending()).resolves.toBeGreaterThanOrEqual(0);
  });
});
