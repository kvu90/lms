import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import type { CentreDb } from '@lms/db';
import { EnrolExpiryProcessor } from '../../../src/processors/enrol-expiry.processor';
import { OutboxRelayScheduler } from '../../../src/outbox-relay.scheduler';
import { TaskLogService } from '../../../src/task-log.service';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * task_log + phản chiếu logstore (issue #22): các lượt chạy worker theo lịch để lại một
 * dòng task_log (success/failed), và relay của worker phản chiếu mọi dòng outbox
 * mà nó phát hành vào event_log với các trường payload đã chuẩn hoá.
 *
 * Từ lát 2 của issue #294, spec này boot WorkerModule qua harness
 * role thường (`test/ordinary-worker-module.ts`): module (gồm
 * TaskLogService và relay) chạy bằng role NOSUPERUSER/NOBYPASSRLS
 * như production, fixture và đọc kiểm chứng đi qua kết nối quản
 * trị của harness — khẳng định nghiệp vụ của spec không đổi.
 */
describe('Worker: ghi task_log và mirror outbox → event_log', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: CentreDb;
  let taskLogService: TaskLogService;
  let startedAt: Date;

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    taskLogService = context.get(TaskLogService);
    startedAt = new Date(Date.now() - 1000);
  });
  afterAll(async () => { await harness.close(); });

  async function latestTaskLog(taskName: string) {
    const rows = await db.selectFrom('task_log').selectAll()
      .where('task_name', '=', taskName)
      .where('started_at', '>=', startedAt)
      .orderBy('started_at', 'desc')
      .execute();
    return rows[0];
  }

  it('TaskLogService.run ghi một dòng thành công và trả kết quả', async () => {
    const result = await taskLogService.run('unit-probe', async () => 42, (r) => `got ${r}`);
    expect(result).toBe(42);
    const row = await latestTaskLog('unit-probe');
    expect(row).toBeDefined();
    expect(row.status).toBe('success');
    expect(row.message).toBe('got 42');
    expect(row.finished_at).not.toBeNull();
  });

  it('TaskLogService.run ghi một dòng thất bại và ném lại lỗi', async () => {
    await expect(taskLogService.run('unit-probe-fail', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    const row = await latestTaskLog('unit-probe-fail');
    expect(row).toBeDefined();
    expect(row.status).toBe('failed');
    expect(row.message).toContain('boom');
  });

  it('lượt chạy bộ xử lý enrol-expiry để lại một dòng task_log', async () => {
    const processor = context.get(EnrolExpiryProcessor);
    await processor.process({ data: {} } as never);
    const row = await latestTaskLog('enrol-expiry');
    expect(row).toBeDefined();
    expect(row.status).toBe('success');
    expect(row.finished_at).not.toBeNull();
  });

  it('tick relay mirror một dòng outbox đã phát hành sang event_log và ghi log tick', async () => {
    const actorId = '01900000-0000-7000-8000-00000000aa01';
    const studentId = '01900000-0000-7000-8000-00000000aa02';
    const courseId = '01900000-0000-7000-8000-00000000aa03';
    const outboxRow = await db.insertInto('outbox_events').values({
      aggregate: 'enrol', type: 'user_enrolled',
      payload: { courseId, userId: studentId, actorId, instanceId: '01900000-0000-7000-8000-00000000aa04' },
    }).returningAll().executeTakeFirstOrThrow();

    const relay = context.get(OutboxRelayScheduler);
    await relay.relayTick();

    const logs = await db.selectFrom('event_log').selectAll().where('event_type', '=', 'user_enrolled').execute();
    const mine = logs.find((r) => (r.payload as { outboxId?: string } | null)?.outboxId === outboxRow.id);
    expect(mine).toBeDefined();
    expect(mine!.user_id).toBe(actorId);
    expect((mine!.payload as { component?: string }).component).toBe('enrol');
    expect((mine!.payload as { action?: string }).action).toBe('user_enrolled');
    expect((mine!.payload as { relatedUserId?: string }).relatedUserId).toBe(studentId);
    expect((mine!.payload as { courseId?: string }).courseId).toBe(courseId);

    const tick = await latestTaskLog('outbox-relay');
    expect(tick).toBeDefined();
    expect(tick.status).toBe('success');
  });
});
