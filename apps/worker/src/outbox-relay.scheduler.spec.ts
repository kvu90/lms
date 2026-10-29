import { describe, expect, it } from 'vitest';
import { MESSAGING_DISTRIBUTED_EVENT_TYPES } from '@lms/messaging';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import { OUTBOX_EVENT_QUEUE_ROUTES, type OutboxEventJobData, type OutboxEventQueueRoutes } from './outbox-event-routes';

/**
 * Test đặc trưng hoá cho relay outbox duy nhất: ghim các tính chất của
 * ngữ nghĩa đóng dấu `publishedAt` và định tuyến phát job theo loại
 * sự kiện, làm căn cứ cho mọi issue chuyển consumer sang hàng đợi ở
 * worker sau này:
 * (i) `publishedAt` chỉ xuất hiện sau khi relay phát thành công,
 *     không bao giờ trước;
 * (ii) phát thất bại thì sự kiện không có `publishedAt` và được phát
 *     lại ở lượt relay sau;
 * (iii) mỗi loại sự kiện được phát vào đúng (các) hàng đợi của nó —
 *     một sự kiện có nhiều đích thì mỗi đích nhận đúng một job
 *     (fan-out một-sự-kiện-nhiều-handler, issue #520/#521);
 * (iv) `publishedAt` không phải dấu hoàn thành xử lý — relay đóng
 *     dấu ngay khi phát xong, dù job chưa được consumer nào xử lý;
 * (v) với sự kiện nhiều đích, dấu chỉ xuất hiện khi MỌI đích đã nhận
 *     job — lỗi ở một đích thì dòng chưa có dấu, và lượt phát lại
 *     không tạo job trùng ở các đích đã nhận (chống trùng `jobId`).
 *
 * Toàn bộ test chạy trên DB/hàng đợi giả lập trong bộ nhớ theo đúng
 * bề mặt relay dùng (chuỗi truy vấn Drizzle, `Queue.add` của BullMQ,
 * `EventLogWriter.record`, `TaskLogService.recordRun`); hàng đợi giả
 * mô phỏng đúng luật chống trùng của BullMQ theo `jobId`. Các khẳng
 * định đều là hệ quả quan sát được (dòng có dấu hay chưa, job nằm ở
 * hàng đợi nào với dữ liệu gì, dòng có được phản chiếu hay không),
 * không phải chi tiết gọi nội bộ.
 */

interface FakeRow {
  id: string;
  seq: number;
  aggregate: string;
  type: string;
  payload: Record<string, unknown> | null;
  tenantId: string | null;
  occurredAt: Date;
  publishedAt: Date | null;
}

let rowCounter = 0;

function makeRow(partial: Partial<FakeRow>): FakeRow {
  rowCounter += 1;
  return {
    id: `0191e8f2-7c3a-7b21-9f00-${String(rowCounter).padStart(12, '0')}`,
    seq: rowCounter,
    aggregate: 'test',
    type: 'unrouted_type',
    payload: { n: rowCounter },
    tenantId: null,
    occurredAt: new Date('2026-10-29T00:00:00.000Z'),
    publishedAt: null,
    ...partial,
  };
}

/**
 * Hàng đợi giả theo khuôn BullMQ: `add` với `jobId` đã tồn tại thì
 * trả lại job cũ thay vì tạo job trùng; ghi lại trạng thái đóng dấu
 * của dòng tại đúng thời điểm job được đẩy để kiểm chứng thứ tự
 * phát → đóng dấu bằng trạng thái quan sát được.
 */
class FakeQueue {
  readonly jobs = new Map<string, { name: string; data: OutboxEventJobData }>();
  readonly stampedAtDispatch: boolean[] = [];
  failNextAdd = false;

  constructor(private readonly rows: FakeRow[]) {}

  async add(name: string, data: OutboxEventJobData, opts?: { jobId?: string }) {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error('redis unavailable');
    }
    const row = this.rows.find((r) => r.id === data.outboxId);
    this.stampedAtDispatch.push(row ? row.publishedAt !== null : true);
    const jobId = opts?.jobId ?? data.outboxId;
    const existing = this.jobs.get(jobId);
    if (existing) return existing;
    const job = { name, data };
    this.jobs.set(jobId, job);
    return job;
  }
}

/**
 * DB giả theo chuỗi truy vấn Drizzle mà relay dùng. Relay xử lý các
 * dòng tuần tự theo thứ tự đã quét và đóng dấu ngay trong vòng lặp,
 * nên bước ghi dấu của fake áp lên dòng đang chờ đóng dấu gần nhất
 * theo đúng thứ tự đó.
 */
function makeFakeDb(rows: FakeRow[]) {
  let awaitingStamp: FakeRow[] = [];
  const control = { failNextStamp: false };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (limit: number) => {
              const pending = rows.filter((r) => r.publishedAt === null).slice(0, limit);
              awaitingStamp = [...pending];
              return pending;
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: { publishedAt: Date }) => ({
        where: async () => {
          if (control.failNextStamp) {
            control.failNextStamp = false;
            throw new Error('database write failed');
          }
          const row = awaitingStamp.shift();
          if (row) row.publishedAt = values.publishedAt;
        },
      }),
    }),
  };
  return { db, control };
}

interface Harness {
  relay: OutboxRelayScheduler;
  queues: Map<string, FakeQueue>;
  mirrored: Array<Record<string, unknown>>;
  taskRuns: Array<{ status: string }>;
}

function makeRelay(rows: FakeRow[], routes: OutboxEventQueueRoutes): Harness {
  const queues = new Map<string, FakeQueue>();
  for (const queueName of new Set(Object.values(routes).flat())) {
    queues.set(queueName, new FakeQueue(rows));
  }
  const { db } = makeFakeDb(rows);
  const mirrored: Array<Record<string, unknown>> = [];
  const eventLog = {
    record: async (row: Record<string, unknown>) => {
      mirrored.push(row);
    },
  };
  const taskRuns: Array<{ status: string }> = [];
  const taskLog = {
    recordRun: async (_task: string, _startedAt: Date, status: string) => {
      taskRuns.push({ status });
    },
  };
  const relay = new OutboxRelayScheduler(
    db as never,
    eventLog as never,
    taskLog as never,
    routes,
    queues as never,
  );
  return { relay, queues, mirrored, taskRuns };
}

const ROUTES: OutboxEventQueueRoutes = {
  auth_mail_requested: ['outbox-auth-mail'],
  message_sent: ['outbox-messaging'],
};

describe('Relay outbox duy nhất — ngữ nghĩa đóng dấu publishedAt', () => {
  it('chỉ đóng dấu publishedAt sau khi job đã được đẩy vào hàng đợi thành công', async () => {
    const row = makeRow({ aggregate: 'auth', type: 'auth_mail_requested', tenantId: 'tenant-1' });
    const { relay, queues } = makeRelay([row], ROUTES);
    const queue = queues.get('outbox-auth-mail')!;

    const published = await relay.publishPending();

    expect(published).toBe(1);
    // Tại thời điểm job được đẩy, dòng vẫn chưa có dấu — dấu chỉ có sau khi phát xong.
    expect(queue.stampedAtDispatch).toEqual([false]);
    expect(row.publishedAt).not.toBeNull();
    const job = queue.jobs.get(row.id);
    expect(job?.name).toBe('auth_mail_requested');
    expect(job?.data).toEqual({
      outboxId: row.id,
      seq: row.seq,
      aggregate: 'auth',
      type: 'auth_mail_requested',
      payload: { n: row.seq },
      tenantId: 'tenant-1',
      occurredAt: '2026-10-29T00:00:00.000Z',
    });
  });

  it('không đóng dấu khi đẩy job thất bại và phát lại thành công ở lượt relay sau', async () => {
    const row = makeRow({ aggregate: 'auth', type: 'auth_mail_requested' });
    const { relay, queues, mirrored } = makeRelay([row], ROUTES);
    const queue = queues.get('outbox-auth-mail')!;
    queue.failNextAdd = true;

    await expect(relay.publishPending()).rejects.toThrow('redis unavailable');
    expect(row.publishedAt).toBeNull();
    expect(queue.jobs.size).toBe(0);
    expect(mirrored).toHaveLength(0);

    const published = await relay.publishPending();
    expect(published).toBe(1);
    expect(row.publishedAt).not.toBeNull();
    expect(queue.jobs.size).toBe(1);
    expect(mirrored).toHaveLength(1);
  });

  it('phát mỗi loại sự kiện vào đúng hàng đợi của nó và không phát job cho loại chưa định tuyến', async () => {
    const mailRow = makeRow({ aggregate: 'auth', type: 'auth_mail_requested' });
    const messageRow = makeRow({ aggregate: 'messaging', type: 'message_sent' });
    const unroutedRow = makeRow({ aggregate: 'course', type: 'course_created' });
    const { relay, queues, mirrored } = makeRelay([mailRow, messageRow, unroutedRow], ROUTES);

    const published = await relay.publishPending();

    expect(published).toBe(3);
    expect([...queues.get('outbox-auth-mail')!.jobs.keys()]).toEqual([mailRow.id]);
    expect([...queues.get('outbox-messaging')!.jobs.keys()]).toEqual([messageRow.id]);
    // Loại chưa định tuyến: không job nào được tạo, nhưng dòng vẫn được
    // đóng dấu và phản chiếu như đường production hiện hành (phía tiêu
    // thụ của nó vẫn đọc trực tiếp bảng outbox theo watermark seq).
    expect(unroutedRow.publishedAt).not.toBeNull();
    expect(mirrored.map((r) => r['id'])).toEqual([mailRow.id, messageRow.id, unroutedRow.id]);
  });

  it('đóng dấu ngay khi phát xong dù job chưa được xử lý — publishedAt không phải dấu hoàn thành xử lý', async () => {
    const row = makeRow({ aggregate: 'messaging', type: 'message_sent' });
    const { relay, queues } = makeRelay([row], ROUTES);
    const queue = queues.get('outbox-messaging')!;

    const published = await relay.publishPending();

    // Relay trở về và dòng đã có dấu trong khi job vẫn nguyên trong
    // hàng đợi, chưa consumer nào chạm vào: dấu chỉ ghi nhận việc
    // phát, tiến độ xử lý thuộc về phía consumer.
    expect(published).toBe(1);
    expect(row.publishedAt).not.toBeNull();
    expect(queue.jobs.get(row.id)?.name).toBe('message_sent');
  });

  it('phản chiếu dòng đã phát vào event_log qua EventLogWriter với đầy đủ định danh của dòng', async () => {
    const row = makeRow({ aggregate: 'auth', type: 'auth_mail_requested', tenantId: 'tenant-9' });
    const { relay, mirrored } = makeRelay([row], ROUTES);

    await relay.publishPending();

    expect(mirrored).toEqual([
      {
        id: row.id,
        seq: row.seq,
        aggregate: 'auth',
        type: 'auth_mail_requested',
        payload: { n: row.seq },
        occurredAt: row.occurredAt,
        tenantId: 'tenant-9',
      },
    ]);
  });

  it('phát lại cùng một dòng sau sự cố giữa bước đẩy job và bước đóng dấu không tạo job trùng', async () => {
    const row = makeRow({ aggregate: 'auth', type: 'auth_mail_requested' });
    const rows = [row];
    const queues = new Map<string, FakeQueue>([['outbox-auth-mail', new FakeQueue(rows)]]);
    const { db, control } = makeFakeDb(rows);
    const relay = new OutboxRelayScheduler(
      db as never,
      { record: async () => undefined } as never,
      { recordRun: async () => undefined } as never,
      ROUTES,
      queues as never,
    );
    const queue = queues.get('outbox-auth-mail')!;
    control.failNextStamp = true;

    // Lượt đầu: job đã vào hàng đợi nhưng đóng dấu lỗi — dòng còn chưa phát.
    await expect(relay.publishPending()).rejects.toThrow('database write failed');
    expect(row.publishedAt).toBeNull();
    expect(queue.jobs.size).toBe(1);

    // Lượt sau phát lại cùng dòng: jobId bằng id dòng nên hàng đợi vẫn đúng một job.
    const published = await relay.publishPending();
    expect(published).toBe(1);
    expect(row.publishedAt).not.toBeNull();
    expect(queue.jobs.size).toBe(1);
  });

  it('dừng cả lô tại dòng phát thất bại — các dòng sau giữ nguyên chưa đóng dấu để lượt sau xử lý theo thứ tự', async () => {
    const failingRow = makeRow({ aggregate: 'auth', type: 'auth_mail_requested' });
    const laterRow = makeRow({ aggregate: 'course', type: 'course_created' });
    const { relay, queues, mirrored } = makeRelay([failingRow, laterRow], ROUTES);
    queues.get('outbox-auth-mail')!.failNextAdd = true;

    await expect(relay.publishPending()).rejects.toThrow('redis unavailable');

    expect(failingRow.publishedAt).toBeNull();
    expect(laterRow.publishedAt).toBeNull();
    expect(mirrored).toHaveLength(0);
  });

  it('ghi task_log trạng thái failed cho nhịp relay có lỗi phát và success khi nhịp phát được dòng', async () => {
    const row = makeRow({ aggregate: 'auth', type: 'auth_mail_requested' });
    const { relay, queues, taskRuns } = makeRelay([row], ROUTES);
    queues.get('outbox-auth-mail')!.failNextAdd = true;

    await expect(relay.relayTick()).rejects.toThrow('redis unavailable');
    expect(taskRuns).toEqual([{ status: 'failed' }]);

    await relay.relayTick();
    expect(taskRuns).toEqual([{ status: 'failed' }, { status: 'success' }]);
  });
});

describe('Relay outbox duy nhất — fan-out một sự kiện nhiều đích', () => {
  const FANOUT_ROUTES: OutboxEventQueueRoutes = {
    message_sent: ['messaging-realtime', 'messaging-notifications'],
  };

  it('một dòng có hai đích thì mỗi đích nhận đúng một job cùng jobId và cùng dữ liệu, dòng chỉ đóng dấu sau khi cả hai đích đã nhận', async () => {
    const row = makeRow({ aggregate: 'messaging', type: 'message_sent', tenantId: 'tenant-1' });
    const { relay, queues } = makeRelay([row], FANOUT_ROUTES);
    const realtime = queues.get('messaging-realtime')!;
    const notifications = queues.get('messaging-notifications')!;

    const published = await relay.publishPending();

    expect(published).toBe(1);
    expect(row.publishedAt).not.toBeNull();
    for (const queue of [realtime, notifications]) {
      expect(queue.jobs.size).toBe(1);
      // Tại thời điểm job được đẩy vào TỪNG đích, dòng vẫn chưa có dấu.
      expect(queue.stampedAtDispatch).toEqual([false]);
      const job = queue.jobs.get(row.id);
      expect(job?.name).toBe('message_sent');
      expect(job?.data).toEqual({
        outboxId: row.id,
        seq: row.seq,
        aggregate: 'messaging',
        type: 'message_sent',
        payload: { n: row.seq },
        tenantId: 'tenant-1',
        occurredAt: '2026-10-29T00:00:00.000Z',
      });
    }
  });

  it('lỗi ở đích thứ hai thì dòng không được đóng dấu; phát lại không tạo job trùng ở đích thứ nhất và hoàn tất ở đích thứ hai', async () => {
    const row = makeRow({ aggregate: 'messaging', type: 'message_sent' });
    const { relay, queues, mirrored } = makeRelay([row], FANOUT_ROUTES);
    const realtime = queues.get('messaging-realtime')!;
    const notifications = queues.get('messaging-notifications')!;
    notifications.failNextAdd = true;

    await expect(relay.publishPending()).rejects.toThrow('redis unavailable');
    // Đích thứ nhất đã nhận job nhưng dòng CHƯA có dấu — dấu chỉ
    // thuộc về lượt phát trọn vẹn tới mọi đích.
    expect(realtime.jobs.size).toBe(1);
    expect(notifications.jobs.size).toBe(0);
    expect(row.publishedAt).toBeNull();
    expect(mirrored).toHaveLength(0);

    const published = await relay.publishPending();
    expect(published).toBe(1);
    expect(row.publishedAt).not.toBeNull();
    // Phát lại không nhân đôi job ở đích đã nhận (jobId = id dòng).
    expect(realtime.jobs.size).toBe(1);
    expect(notifications.jobs.size).toBe(1);
    expect(mirrored).toHaveLength(1);
  });

  it('bảng định tuyến production đưa mọi loại sự kiện phân phối messaging về hàng đợi messaging-realtime', () => {
    for (const type of MESSAGING_DISTRIBUTED_EVENT_TYPES) {
      expect(OUTBOX_EVENT_QUEUE_ROUTES[type]).toContain('messaging-realtime');
    }
  });
});
