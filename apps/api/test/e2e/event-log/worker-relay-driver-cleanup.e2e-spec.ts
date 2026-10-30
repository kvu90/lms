import { Queue } from 'bullmq';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redisConnectionFromUrl } from '../../../../worker/src/config/env';
import {
  OUTBOX_EVENT_QUEUE_ROUTES,
  allQueueNamesOfRoutes,
  queueNamesOfRoute,
} from '../../../../worker/src/outbox-event-routes';
import { closeWorkerRelayDriver, flushWorkerRelay } from '../../support/worker-relay-driver';

/**
 * Hồi quy điểm chặn BullMQ của PR #554 (issue #523, việc dọn cuối
 * chuỗi #491): cầu dẫn relay của worker đẩy job BullMQ thật vào
 * đúng hàng đợi production trên `REDIS_URL` hiện hành, nhưng trong
 * e2e không có processor nào tiêu thụ — nếu đóng cầu dẫn mà không
 * dọn, các job đó tích luỹ trên Redis dùng chung và một worker
 * thường nối vào sau sẽ tiêu thụ chúng như sự kiện mới (phân xử
 * 6513725570 đã đo 33 job/lượt, tích luỹ 0 → 33 → 66 qua hai lượt).
 *
 * Spec này ghim điều kiện sửa tối thiểu đã phán quyết (6513843023):
 * sau khi đóng cầu dẫn, không job nào của lượt chạy còn ở trạng
 * thái worker thường tiêu thụ được, trên TOÀN BỘ bảng định tuyến
 * (cả 5 hàng đợi, kể cả `auth-mail` — job sót ở đó mà bị worker
 * thật tiêu thụ có thể gửi mail thật), và lặp 2 lượt không cộng
 * thêm job sót của lượt trước. Việc dọn nằm trong
 * `closeWorkerRelayDriver()` nên đường `afterAll` của các file e2e
 * dùng cầu dẫn cũng được hưởng — kể cả khi test thất bại giữa
 * chừng (Vitest vẫn gọi `afterAll`).
 *
 * Cách đo: spec chèn trực tiếp 5 dòng outbox phủ đủ 5 hàng đợi
 * (loại `message_sent` fan-out ra 2 đích nên một lượt sinh 6 job),
 * xả qua cầu dẫn thật rồi đóng, sau đó đối chiếu (a) số job chờ
 * trên mỗi hàng đợi về đúng số đo trước lượt và (b) từng job của
 * lượt không còn tra được theo id. Số đo so với baseline trước
 * lượt — không so với 0 tuyệt đối — vì Redis e2e có thể là Redis
 * dùng chung, đã chứa job của tiến trình khác từ trước.
 */
describe('Worker relay driver: đóng cầu dẫn dọn đúng job của lượt chạy', () => {
  const queueNames = allQueueNamesOfRoutes(OUTBOX_EVENT_QUEUE_ROUTES);
  let pg: Client;
  let measureQueues: Queue[] = [];

  async function waitingCounts(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const queue of measureQueues) {
      const jobCounts = await queue.getJobCounts('waiting', 'delayed');
      counts[queue.name] = (jobCounts.waiting ?? 0) + (jobCounts.delayed ?? 0);
    }
    return counts;
  }

  async function insertOutboxRows(): Promise<Array<{ id: string; type: string }>> {
    const rows = [
      { aggregate: 'auth', type: 'auth_mail_requested' },
      { aggregate: 'guardian', type: 'guardian_digest_due' },
      { aggregate: 'grades', type: 'grade_updated' },
      { aggregate: 'cohort', type: 'cohort_member_added' },
      { aggregate: 'messaging', type: 'message_sent' },
    ];
    const inserted: Array<{ id: string; type: string }> = [];
    for (const row of rows) {
      const res = await pg.query(
        `INSERT INTO outbox_events (aggregate, type, payload) VALUES ($1, $2, $3) RETURNING id, type`,
        [row.aggregate, row.type, {}],
      );
      inserted.push(res.rows[0] as { id: string; type: string });
    }
    return inserted;
  }

  async function runFlushAndClose(): Promise<Array<{ id: string; type: string }>> {
    const baseline = await waitingCounts();
    const rows = await insertOutboxRows();
    const published = await flushWorkerRelay();
    expect(published).toBe(rows.length);
    await closeWorkerRelayDriver();
    const after = await waitingCounts();
    for (const name of queueNames) {
      expect(after[name]).toBe(baseline[name]);
    }
    for (const row of rows) {
      const route = OUTBOX_EVENT_QUEUE_ROUTES[row.type];
      expect(route).toBeDefined();
      for (const queueName of queueNamesOfRoute(route!)) {
        const queue = measureQueues.find((q) => q.name === queueName)!;
        expect(await queue.getJob(row.id)).toBeUndefined();
      }
    }
    return rows;
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    // Dọn tồn đọng outbox chưa phát của các spec chạy trước trên
    // cùng DB (theo đúng tiền lệ của event-log-flow): relay ở app
    // test chỉ chạy khi gọi tay, nên dòng chưa phát khi file trước
    // đóng là dòng chết — không test nào còn tiêu thụ.
    await pg.query('DELETE FROM outbox_events WHERE published_at IS NULL');
    const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? '');
    measureQueues = queueNames.map((name) => new Queue(name, { connection }));
  });

  afterAll(async () => {
    await closeWorkerRelayDriver();
    await Promise.all(measureQueues.map((queue) => queue.close()));
    await pg.end();
  });

  it('lượt 1: sau khi xả và đóng cầu dẫn, số job chờ trên cả 5 hàng đợi trở về đúng số đo trước lượt và không còn job nào của lượt', async () => {
    const rows = await runFlushAndClose();
    expect(rows).toHaveLength(5);
  });

  it('lượt 2: lặp lại lượt xả và đóng không cộng thêm job sót của lượt 1', async () => {
    const rows = await runFlushAndClose();
    expect(rows).toHaveLength(5);
  });

  it('đóng cầu dẫn lần hai không lỗi (đường afterAll gọi sau khi đã đóng tay)', async () => {
    await expect(closeWorkerRelayDriver()).resolves.toBeUndefined();
  });
});
