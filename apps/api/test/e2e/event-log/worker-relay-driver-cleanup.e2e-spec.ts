import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
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
 *
 * Vòng sửa 2 (phán quyết điều phối 6515103583, trên cơ sở phân xử
 * 6515088158): relay production phát job TRƯỚC (`queue.add` cho
 * từng đích), đóng dấu `publishedAt` SAU, và dừng cả lượt ngay tại
 * dòng lỗi — nên một dòng có thể đã sinh job thật mà không bao giờ
 * được đóng dấu (đóng dấu lỗi sau khi job đã vào Redis, hoặc
 * fan-out chỉ tới được đích thứ nhất). Ghi vết theo hiệu hai tập
 * dòng đã đóng dấu bỏ sót đúng các dòng đó. Spec bổ sung hai ca
 * nhánh lỗi tương ứng: lỗi được tiêm THẬT trên đường production
 * (trigger Postgres làm chính lệnh UPDATE đóng dấu ném lỗi; ACL
 * Redis làm `queue.add` ở đích fan-out thứ hai bị từ chối NOPERM),
 * khẳng định sau khi đóng cầu dẫn job phát một phần cũng biến mất
 * và số job chờ về đúng baseline. Hai ca này đỏ trên cơ chế ghi
 * vết cũ và xanh trên cơ chế ứng viên của vòng sửa 2.
 */
describe('Worker relay driver: đóng cầu dẫn dọn đúng job của lượt chạy', () => {
  const queueNames = allQueueNamesOfRoutes(OUTBOX_EVENT_QUEUE_ROUTES);
  let pg: Client;
  let adminRedis: Redis;
  let measureQueues: Queue[] = [];

  function queueByName(name: string): Queue {
    return measureQueues.find((q) => q.name === name)!;
  }

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

  async function insertRow(aggregate: string, type: string): Promise<string> {
    const res = await pg.query(
      `INSERT INTO outbox_events (aggregate, type, payload) VALUES ($1, $2, $3) RETURNING id`,
      [aggregate, type, {}],
    );
    return (res.rows[0] as { id: string }).id;
  }

  async function isUnpublished(id: string): Promise<boolean> {
    const res = await pg.query(
      `SELECT published_at IS NULL AS unpub FROM outbox_events WHERE id = $1`,
      [id],
    );
    return (res.rows[0] as { unpub: boolean }).unpub;
  }

  function errorText(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (current instanceof Error) {
        parts.push(current.message);
        current = (current as { cause?: unknown }).cause;
      } else {
        parts.push(String(current));
        break;
      }
    }
    return parts.join(' | ');
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
    adminRedis = new Redis(process.env.REDIS_URL ?? '');
  });

  afterAll(async () => {
    // Khôi phục hạ tầng dù một ca nhánh lỗi có chết giữa chừng:
    // nới ACL Redis về toàn quyền và gỡ trigger tiêm lỗi.
    await adminRedis.acl('SETUSER', 'default', 'resetkeys', '~*').catch(() => undefined);
    await pg
      .query('DROP TRIGGER IF EXISTS fail_stamp_after_enqueue_trg ON outbox_events')
      .catch(() => undefined);
    await pg.query('DROP FUNCTION IF EXISTS fail_stamp_after_enqueue()').catch(() => undefined);
    await closeWorkerRelayDriver();
    await Promise.all(measureQueues.map((queue) => queue.close()));
    adminRedis.disconnect();
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

  it('nhánh lỗi đóng dấu: job đã vào Redis nhưng lệnh đóng dấu publishedAt thất bại, đóng cầu dẫn vẫn dọn job của dòng lỗi', async () => {
    const baseline = await waitingCounts();
    const rowId = await insertRow('grades', 'grade_updated');
    // Tiêm lỗi thật ở đúng lệnh UPDATE đóng dấu của relay production:
    // trigger BEFORE UPDATE ném ngoại lệ khi published_at chuyển
    // NULL -> NOT NULL, tức sau khi queue.add đã thành công.
    await pg.query(`
      CREATE OR REPLACE FUNCTION fail_stamp_after_enqueue() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.published_at IS NOT NULL AND OLD.published_at IS NULL THEN
          RAISE EXCEPTION 'injected stamp failure after enqueue';
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS fail_stamp_after_enqueue_trg ON outbox_events;
      CREATE TRIGGER fail_stamp_after_enqueue_trg BEFORE UPDATE ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION fail_stamp_after_enqueue();
    `);
    let flushError: unknown = null;
    try {
      await flushWorkerRelay();
    } catch (error) {
      flushError = error;
    } finally {
      await pg.query('DROP TRIGGER IF EXISTS fail_stamp_after_enqueue_trg ON outbox_events');
      await pg.query('DROP FUNCTION IF EXISTS fail_stamp_after_enqueue()');
    }
    expect(flushError).not.toBeNull();
    expect(errorText(flushError)).toContain('injected stamp failure after enqueue');
    // Dòng lỗi không được đóng dấu, nhưng job của nó đã vào Redis.
    expect(await isUnpublished(rowId)).toBe(true);
    const notificationQueue = queueByName('notification-events');
    expect(await notificationQueue.getJob(rowId)).toBeDefined();

    await closeWorkerRelayDriver();

    expect(await notificationQueue.getJob(rowId)).toBeUndefined();
    const after = await waitingCounts();
    for (const name of queueNames) {
      expect(after[name]).toBe(baseline[name]);
    }
    await pg.query('DELETE FROM outbox_events WHERE id = $1', [rowId]);
  });

  it('nhánh lỗi fan-out: message_sent lỗi ở đích thứ hai sau khi đích thứ nhất đã nhận job, đóng cầu dẫn vẫn dọn job ở đích thứ nhất', async () => {
    const baseline = await waitingCounts();
    // Lượt xả khởi động: dựng cầu dẫn và các kết nối BullMQ khi ACL
    // chưa siết (lúc này không còn dòng chưa phát nào).
    await flushWorkerRelay();
    const rowId = await insertRow('messaging', 'message_sent');
    // Siết ACL của user mặc định: chỉ cho chạm khóa của hàng đợi
    // đích thứ nhất. Lệnh queue.add ở đích thứ hai
    // (notification-events) bị Redis từ chối NOPERM — lỗi thật trả
    // về cho đúng lời gọi production, sau khi đích thứ nhất
    // (messaging-realtime) đã nhận job.
    await adminRedis.acl('SETUSER', 'default', 'resetkeys', '~bull:messaging-realtime:*');
    let flushError: unknown = null;
    try {
      await flushWorkerRelay();
    } catch (error) {
      flushError = error;
    } finally {
      await adminRedis.acl('SETUSER', 'default', 'resetkeys', '~*');
    }
    expect(flushError).not.toBeNull();
    expect(errorText(flushError)).toMatch(/NOPERM|no permissions/i);
    // Phát một phần: dòng chưa đóng dấu, job chỉ có ở đích thứ nhất.
    expect(await isUnpublished(rowId)).toBe(true);
    const realtimeQueue = queueByName('messaging-realtime');
    const notificationQueue = queueByName('notification-events');
    expect(await realtimeQueue.getJob(rowId)).toBeDefined();
    expect(await notificationQueue.getJob(rowId)).toBeUndefined();

    await closeWorkerRelayDriver();

    expect(await realtimeQueue.getJob(rowId)).toBeUndefined();
    const after = await waitingCounts();
    for (const name of queueNames) {
      expect(after[name]).toBe(baseline[name]);
    }
    await pg.query('DELETE FROM outbox_events WHERE id = $1', [rowId]);
  });

  it('đóng cầu dẫn lần hai không lỗi (đường afterAll gọi sau khi đã đóng tay)', async () => {
    await expect(closeWorkerRelayDriver()).resolves.toBeUndefined();
  });
});
