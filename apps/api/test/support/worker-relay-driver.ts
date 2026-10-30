import 'reflect-metadata';
import { Queue } from 'bullmq';
import { isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outboxEvents } from '@lms/db';
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
 * Hệ quả phụ của việc dẫn và cách dọn: với loại sự kiện đã có
 * trong bảng định tuyến, nhịp relay còn đẩy job BullMQ THẬT vào
 * hàng đợi đích trên `REDIS_URL` hiện hành (đúng hành vi
 * production); trong e2e không có processor nào tiêu thụ nên các
 * job đó nằm chờ trong Redis. Nếu cứ để nguyên khi đóng cầu dẫn,
 * chúng tích luỹ trên Redis dùng chung của máy dev và một worker
 * thường nối vào cùng Redis sau đó sẽ tiêu thụ chúng như sự kiện
 * mới. Vì vậy cầu dẫn GHI VẾT id của mọi dòng outbox mà chính nó
 * đã phát trong lượt (xem {@link flushWorkerRelay}) và khi đóng
 * thì XOÁ ĐÚNG các job mang id đó khỏi hàng đợi trước khi đóng
 * kết nối (xem {@link closeWorkerRelayDriver}) — `jobId` của job
 * do relay đẩy chính là id của dòng outbox. Sau khi đóng, không
 * job nào của lượt chạy còn ở trạng thái một worker thường tiêu
 * thụ được; job của tiến trình khác trên cùng Redis không bị
 * đụng vì việc xoá chỉ theo đúng các id đã ghi vết.
 *
 * Vòng đời: các singleton dựng lười ở lần dẫn đầu tiên của file spec
 * và được đóng ở `afterAll` của file đó qua
 * `closeWorkerRelayDriver()` — mỗi file e2e chạy trong module
 * registry riêng nên singleton này là theo file, không dùng chung
 * qua các file. Việc dọn job nằm trên chính đường đóng này nên
 * vẫn chạy khi một test trong file thất bại giữa chừng, vì
 * `afterAll` vẫn được Vitest gọi trong trường hợp đó.
 */
let relay: OutboxRelayScheduler | null = null;
let pool: TenantAwarePool | null = null;
let sharedDb: NodePgDatabase<typeof relations> | null = null;
let queues: Queue[] = [];
/**
 * Id các dòng outbox mà cầu dẫn này đã phát kể từ lần dựng —
 * đồng thời là `jobId` của các job BullMQ tương ứng trên mọi
 * hàng đợi đích. Đây là danh sách dọn duy nhất khi đóng: chỉ
 * job mang một trong các id này mới bị xoá.
 */
let publishedOutboxIds = new Set<string>();

function getSharedDb(): NodePgDatabase<typeof relations> {
  if (!sharedDb) {
    pool = new TenantAwarePool({ connectionString: process.env.DATABASE_URL });
    sharedDb = drizzle({ client: pool, relations });
  }
  return sharedDb;
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
 * Đọc id của mọi dòng outbox đã có dấu `publishedAt` trong DB
 * test tại thời điểm gọi.
 *
 * Truy vấn phải chạy trong ngữ cảnh platform tường minh như
 * chính relay: bảng outbox mang `tenant_id` và RLS fail-closed
 * sẽ làm mù các dòng của tenant nếu thiếu ngữ cảnh (xem ghi chú
 * TENANT-1 ở relay của worker).
 *
 * @param db Tay cầm Drizzle dùng chung của cầu dẫn.
 * @returns Tập id các dòng đã đóng dấu.
 */
async function readPublishedOutboxIds(
  db: NodePgDatabase<typeof relations>,
): Promise<Set<string>> {
  const rows = await tenantAls.run({ platform: true }, async () => {
    return await db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(isNotNull(outboxEvents.publishedAt));
  });
  return new Set(rows.map((row) => row.id));
}

/**
 * Dẫn các nhịp relay của worker cho tới khi không còn dòng outbox
 * chưa phát (tối đa 20 nhịp, mỗi nhịp 500 dòng — đúng khuôn vòng
 * xả cũ của các spec trước #523).
 *
 * Ghi vết cho việc dọn khi đóng: chụp tập id đã đóng dấu TRƯỚC
 * lượt dẫn và đối chiếu lại SAU lượt — hiệu số là đúng các dòng
 * lượt này vừa phát, được cộng vào danh sách dọn của
 * {@link closeWorkerRelayDriver}. Việc đối chiếu nằm ở khối
 * `finally` nên kể cả khi một nhịp relay ném lỗi giữa lượt, các
 * dòng đã kịp đóng dấu trước lỗi (và đã sinh job thật) vẫn được
 * ghi vết để dọn.
 *
 * @returns Tổng số dòng đã được relay đóng dấu qua các nhịp.
 */
export async function flushWorkerRelay(): Promise<number> {
  const target = getRelay();
  const db = getSharedDb();
  const publishedBefore = await readPublishedOutboxIds(db);
  let published = 0;
  try {
    for (let i = 0; i < 20; i += 1) {
      const n = await tenantAls.run({ platform: true }, () => target.publishPending(500));
      published += n;
      if (n === 0) break;
    }
    return published;
  } finally {
    const publishedAfter = await readPublishedOutboxIds(db);
    for (const id of publishedAfter) {
      if (!publishedBefore.has(id)) publishedOutboxIds.add(id);
    }
  }
}

/**
 * Dọn job của lượt chạy, rồi đóng các hàng đợi BullMQ và pool DB
 * mà cầu dẫn đã dựng — gọi ở `afterAll` của file spec dùng nó,
 * nên việc dọn chạy cả khi test trong file thất bại giữa chừng.
 *
 * Cách xoá (theo tài liệu chính thức của BullMQ, mục xoá job):
 * trước khi đóng kết nối, gọi `queue.remove(jobId)` cho từng id
 * đã ghi vết trên TỪNG hàng đợi mà cầu dẫn dựng (một dòng có thể
 * fan-out ra nhiều hàng đợi nên phải thử xoá ở mọi hàng đợi).
 * `queue.remove` chỉ xoá đúng job mang id đó — trả 1 khi xoá
 * được, 0 khi job không còn ở hàng đợi đó hoặc đang bị khoá —
 * nên job của tiến trình khác trên cùng Redis dùng chung không
 * bị ảnh hưởng; vì lý do đó cấm dùng các thao tác xoá hàng loạt
 * toàn hàng đợi (`drain`/`obliterate`/`clean`) ở đây.
 * `queue.close()` chỉ đóng kết nối và không xoá job nào, còn
 * `removeOnComplete`/`removeOnFail` chỉ tác động sau khi một job
 * đã được tiêu thụ xong — cả hai đều không thay được bước xoá
 * này đối với job chưa từng được tiêu thụ.
 *
 * Hành vi khi lỗi: lỗi xoá của một job không chặn việc dọn các
 * job còn lại và không chặn việc đóng kết nối/pool, nhưng được
 * gom lại và ném ra sau khi đã đóng xong, để lượt chạy đỏ lên
 * thay vì rò rỉ job lặng lẽ. Trong e2e không có processor nào
 * chạy nên job của lượt luôn ở trạng thái chờ và xoá được.
 */
export async function closeWorkerRelayDriver(): Promise<void> {
  const toClose = queues;
  const jobIds = [...publishedOutboxIds];
  queues = [];
  relay = null;
  publishedOutboxIds = new Set();
  const removalErrors: unknown[] = [];
  await Promise.all(
    toClose.map(async (queue) => {
      for (const jobId of jobIds) {
        try {
          await queue.remove(jobId);
        } catch (error) {
          removalErrors.push(error);
        }
      }
    }),
  );
  await Promise.all(toClose.map((queue) => queue.close()));
  if (pool) {
    const closing = pool;
    pool = null;
    sharedDb = null;
    await closing.end();
  }
  if (removalErrors.length > 0) {
    throw new Error(
      `Worker relay driver failed to remove ${removalErrors.length} job(s) it created`,
    );
  }
}
