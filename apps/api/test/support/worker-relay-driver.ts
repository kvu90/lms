import 'reflect-metadata';
import { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { redisConnectionFromUrl } from '../../../worker/src/config/env';
import { tenantAls } from '../../../worker/src/db/tenant-als';
import { TenantAwarePool } from '../../../worker/src/db/tenant-pool';
import { relations } from '../../../worker/src/db/relations';
import { EventLogWriter } from '../../../worker/src/event-log-writer.service';
import { TaskLogService } from '../../../worker/src/task-log.service';
import { OutboxRelayScheduler } from '../../../worker/src/outbox-relay.scheduler';
import {
  OUTBOX_EVENT_QUEUE_ROUTES,
  allQueueNamesOfRoutes,
  type OutboxEventQueues,
} from '../../../worker/src/outbox-event-routes';

/**
 * Cầu dẫn nhịp relay outbox ở worker cho các suite e2e (issue #523).
 *
 * Bối cảnh: trước #523, tiến trình API trong `createTestApp()` vừa
 * ghi sự kiện outbox vừa chạy relay riêng (`OutboxRelayService`)
 * để phản chiếu vào `event_log`, nên các spec chỉ cần gọi tay
 * `relay.publishPending()` rồi truy vấn logstore. Từ #523, relay
 * phía API đã gỡ — tiến trình API trong test không còn relay nữa —
 * nên các spec phải TỰ dẫn nhịp relay của worker, nếu không mọi
 * truy vấn `event-logs` sau đó đều rỗng.
 *
 * Cách dẫn: dựng ĐÚNG ngăn xếp production của worker bằng `new`
 * (không qua Nest, không boot WorkerModule — e2e shard chỉ build
 * `@lms/api`, không có tiến trình worker chạy kèm): tay cầm Drizzle
 * trên `TenantAwarePool` của worker (gắn GUC theo ALS như module
 * thật), `EventLogWriter` + `TaskLogService` của worker, bảng định
 * tuyến `OUTBOX_EVENT_QUEUE_ROUTES` và một `Queue` BullMQ thật cho
 * mỗi hàng đợi có mặt trong bảng đó (cùng cấu hình kết nối Redis
 * và cùng chính sách job mặc định như `worker.module.ts`).
 *
 * Vì sao import thẳng code production của worker thay vì dựng một
 * bản phản chiếu riêng cho test: import thẳng thì spec khẳng định
 * đúng đường production (cùng relay, cùng thứ tự phát → đóng dấu
 * → phản chiếu); một bản dựng riêng cho test sẽ chỉ chứng minh bản
 * test chạy được, không chứng minh worker chạy được. Nhịp 5 giây
 * theo lịch (`@Interval`) không nằm trong phạm vi dẫn này — nó được
 * ghim ở tầng worker (`outbox-relay.scheduler.spec.ts`).
 *
 * Hệ quả phụ của việc dẫn: với loại sự kiện đã có trong bảng định
 * tuyến, nhịp relay còn đẩy job BullMQ vào hàng đợi đích (đúng hành
 * vi production); trong e2e không có processor nào tiêu thụ nên job
 * chỉ nằm chờ trong Redis, không ảnh hưởng assertion nào của spec.
 *
 * Vòng đời: các singleton dựng lười ở lần dẫn đầu tiên của file spec
 * và được đóng ở `afterAll` của file đó qua
 * `closeWorkerRelayDriver()` — mỗi file e2e chạy trong module
 * registry riêng nên singleton này là theo file, không dùng chung
 * qua các file.
 */
let relay: OutboxRelayScheduler | null = null;
let pool: TenantAwarePool | null = null;
let queues: Queue[] = [];

function getSharedDb(): NodePgDatabase<typeof relations> {
  if (!pool) {
    pool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL });
  }
  return drizzle({ client: pool, relations });
}

function getRelay(): OutboxRelayScheduler {
  if (!relay) {
    const db = getSharedDb();
    const queueNames = allQueueNamesOfRoutes(OUTBOX_EVENT_QUEUE_ROUTES);
    const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? '');
    queues = queueNames.map(
      (name) =>
        new Queue(name, {
          connection,
          defaultJobOptions: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: 1000,
            removeOnFail: 1000,
          },
        }),
    );
    const queueMap: OutboxEventQueues = new Map(
      queueNames.map((name, index) => [name, queues[index]!] as const),
    );
    relay = new OutboxRelayScheduler(
      db,
      new EventLogWriter(db),
      new TaskLogService(db),
      OUTBOX_EVENT_QUEUE_ROUTES,
      queueMap,
    );
  }
  return relay;
}

/**
 * Dẫn các nhịp relay của worker cho tới khi không còn dòng outbox
 * chưa phát (tối đa 20 nhịp, mỗi nhịp 500 dòng — đúng khuôn vòng
 * xả cũ của các spec trước #523).
 *
 * @returns Tổng số dòng đã được relay đóng dấu qua các nhịp.
 */
export async function flushWorkerRelay(): Promise<number> {
  const target = getRelay();
  let published = 0;
  for (let i = 0; i < 20; i += 1) {
    const n = await tenantAls.run({ platform: true }, () => target.publishPending(500));
    published += n;
    if (n === 0) break;
  }
  return published;
}

/** Đóng các hàng đợi BullMQ và pool DB mà cầu dẫn đã dựng. */
export async function closeWorkerRelayDriver(): Promise<void> {
  const toClose = queues;
  queues = [];
  relay = null;
  await Promise.all(toClose.map((queue) => queue.close()));
  if (pool) {
    const closing = pool;
    pool = null;
    await closing.end();
  }
}
