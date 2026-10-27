import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { and, desc, eq, gte } from 'drizzle-orm';
import { eventLog, outboxEvents, taskLog } from '@lms/db-schema';
import { EnrolExpiryProcessor } from '../src/processors/enrol-expiry.processor';
import { OutboxRelayScheduler } from '../src/outbox-relay.scheduler';
import { TaskLogService } from '../src/task-log.service';
import { WorkerModule } from '../src/worker.module';

/**
 * task_log + phản chiếu logstore (issue #22): các lượt chạy worker theo lịch để lại một
 * dòng task_log (success/failed), và relay của worker phản chiếu mọi dòng outbox
 * mà nó phát hành vào event_log với các trường payload đã chuẩn hoá.
 */
describe('Worker: task_log recording and outbox → event_log mirroring', () => {
  let context: INestApplicationContext;
  let db: any;
  let taskLogService: TaskLogService;
  let startedAt: Date;

  beforeAll(async () => {
    context = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    await context.init();
    db = context.get(getDrizzleToken());
    taskLogService = context.get(TaskLogService);
    startedAt = new Date(Date.now() - 1000);
  });
  afterAll(async () => { await context.close(); });

  async function latestTaskLog(taskName: string) {
    const rows = await db.select().from(taskLog)
      .where(and(eq(taskLog.taskName, taskName), gte(taskLog.startedAt, startedAt)))
      .orderBy(desc(taskLog.startedAt));
    return rows[0];
  }

  it('TaskLogService.run records a success row and returns the result', async () => {
    const result = await taskLogService.run('unit-probe', async () => 42, (r) => `got ${r}`);
    expect(result).toBe(42);
    const row = await latestTaskLog('unit-probe');
    expect(row).toBeDefined();
    expect(row.status).toBe('success');
    expect(row.message).toBe('got 42');
    expect(row.finishedAt).not.toBeNull();
  });

  it('TaskLogService.run records a failed row and rethrows', async () => {
    await expect(taskLogService.run('unit-probe-fail', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const row = await latestTaskLog('unit-probe-fail');
    expect(row).toBeDefined();
    expect(row.status).toBe('failed');
    expect(row.message).toContain('boom');
  });

  it('enrol-expiry processor run leaves a task_log row', async () => {
    const processor = context.get(EnrolExpiryProcessor);
    await processor.process({ data: {} } as never);
    const row = await latestTaskLog('enrol-expiry');
    expect(row).toBeDefined();
    expect(row.status).toBe('success');
    expect(row.finishedAt).not.toBeNull();
  });

  it('relay tick mirrors a published outbox row into event_log and logs the tick', async () => {
    const actorId = '01900000-0000-7000-8000-00000000aa01';
    const studentId = '01900000-0000-7000-8000-00000000aa02';
    const courseId = '01900000-0000-7000-8000-00000000aa03';
    const [outboxRow] = await db.insert(outboxEvents).values({
      aggregate: 'enrol', type: 'user_enrolled',
      payload: { courseId, userId: studentId, actorId, instanceId: '01900000-0000-7000-8000-00000000aa04' },
    }).returning();

    const relay = context.get(OutboxRelayScheduler);
    await relay.relayTick();

    const logs = await db.select().from(eventLog).where(eq(eventLog.eventType, 'user_enrolled'));
    const mine = logs.find((r: any) => (r.payload as any)?.outboxId === outboxRow.id);
    expect(mine).toBeDefined();
    expect(mine.userId).toBe(actorId);
    expect(mine.payload.component).toBe('enrol');
    expect(mine.payload.action).toBe('user_enrolled');
    expect(mine.payload.relatedUserId).toBe(studentId);
    expect(mine.payload.courseId).toBe(courseId);

    const tick = await latestTaskLog('outbox-relay');
    expect(tick).toBeDefined();
    expect(tick.status).toBe('success');
  });
});
