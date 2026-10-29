import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import {
  MESSAGING_DISTRIBUTED_KEY_PREFIX,
  MessagingRealtimeProcessor,
} from '../../../src/processors/messaging-realtime.processor';
import type { OutboxEventJobData } from '../../../src/outbox-event-routes';

/**
 * Thử lại của job phân phối realtime messaging khi lỗi bền (điều
 * kiện đạt của điểm 2, phán quyết đối chiếu trên PR #543):
 *
 * - Chính sách job mặc định toàn worker (attempts 3, backoff hàm
 *   mũ từ 1 giây — bộ giá trị ở `worker.module.ts`) giết hẳn một
 *   job lỗi liên tục sau 3 lần thử; với đường messaging, dòng
 *   outbox đã được relay đóng dấu `publishedAt` ngay khi job vào
 *   hàng đợi nên không còn đường phát lại nào cứu sự kiện.
 * - Hành vi yêu cầu: lỗi phân phối (đọc dữ kiện lỗi, publish Redis
 *   lỗi — lỗi publish đã được spec unit của emitter chứng minh là
 *   ném ra khỏi `distributeEvent`) không đốt số lần thử và không
 *   giết job: job được hoãn bằng cơ chế delayed của BullMQ và thử
 *   lại cho tới khi lỗi hết; khi đó sự kiện vẫn được phân phối và
 *   dấu đã-phân-phối ghi đúng một lần.
 *
 * Khuôn test: hàng đợi BullMQ THẬT trên Redis thật và processor
 * THẬT, chỉ stub đúng biên `distributeEvent` của tầng phân phối
 * (biên đã được các spec khác chứng minh: luật phân phối ở
 * `@lms/messaging` và cổng phát có xác nhận publish ở emitter).
 * Hàng đợi dùng tên riêng của spec này để cách ly với hàng đợi
 * production `messaging-realtime` mà spec int của hàng đợi
 * messaging dùng song song; chính sách job mặc định được sao đúng
 * bộ giá trị thống nhất của `worker.module.ts`.
 */
const RETRY_TEST_QUEUE = 'messaging-realtime-retry-test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/** Số lần phân phối lỗi liên tiếp trước khi hết lỗi: nhiều hơn attempts mặc định (3). */
const FAILURES_BEFORE_SUCCESS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(250);
  }
  throw new Error(`Hết thời gian chờ: ${label}`);
}

describe('Worker — job phân phối realtime lỗi bền không chết theo attempts (issue #521)', () => {
  const outboxId = uuidv7();
  const markKey = `${MESSAGING_DISTRIBUTED_KEY_PREFIX}${outboxId}`;

  let queue: Queue<OutboxEventJobData>;
  let worker: Worker<OutboxEventJobData>;
  let markRedis: Redis;
  let distributeCalls = 0;
  const delivered: string[] = [];

  beforeAll(async () => {
    markRedis = new Redis(REDIS_URL);
    await markRedis.del(markKey);

    const distribution = {
      distributeEvent: async (type: string) => {
        distributeCalls += 1;
        if (distributeCalls <= FAILURES_BEFORE_SUCCESS) {
          throw new Error('publish NOPERM (lỗi bền giả lập)');
        }
        delivered.push(type);
      },
    };
    const processor = new MessagingRealtimeProcessor(distribution as never, markRedis as never);

    queue = new Queue<OutboxEventJobData>(RETRY_TEST_QUEUE, {
      connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    });
    await queue.obliterate({ force: true });
    worker = new Worker<OutboxEventJobData>(
      RETRY_TEST_QUEUE,
      async (job, token) => processor.process(job, token),
      { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }) },
    );
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await markRedis.del(markKey);
    markRedis.disconnect();
  });

  it(
    'job lỗi phân phối liên tục quá số attempts mặc định vẫn không chết: được hoãn thử lại mà không đốt attempts, lỗi hết thì sự kiện tới và dấu ghi đúng một lần',
    async () => {
      const jobData: OutboxEventJobData = {
        outboxId,
        seq: 1,
        aggregate: 'messaging',
        type: 'message_sent',
        payload: { conversationId: 'conv-retry', messageId: 'msg-retry' },
        tenantId: 'tenant-retry',
        occurredAt: '2026-10-29T00:00:00.000Z',
      };
      const job = await queue.add('message_sent', jobData, { jobId: outboxId });

      // Trong lúc lỗi còn bền và số lần phân phối lỗi đã vượt
      // attempts mặc định, job phải đang nằm ở trạng thái hoãn
      // (delayed) với attemptsMade vẫn bằng 0 — không phải failed.
      await waitUntil(
        async () => distributeCalls >= 2 && (await job.getState()) === 'delayed',
        30_000,
        'job vào trạng thái delayed sau các lần phân phối lỗi đầu',
      );
      expect(await job.getState()).not.toBe('failed');
      // attemptsMade phải đọc từ bản job tươi trên Redis (bản
      // job trả về từ add() giữ giá trị tại thời điểm tạo).
      const freshDuringFault = await queue.getJob(outboxId);
      expect(freshDuringFault?.attemptsMade).toBe(0);

      // Lỗi hết ở lần phân phối thứ 5: job hoàn thành, sự kiện
      // được phân phối đúng một lần hiệu lực và dấu đứng đúng
      // một khoá.
      await waitUntil(async () => (await job.getState()) === 'completed', 60_000, 'job hoàn thành sau khi lỗi hết');
      expect(delivered).toEqual(['message_sent']);
      expect(distributeCalls).toBe(FAILURES_BEFORE_SUCCESS + 1);
      expect(await markRedis.exists(markKey)).toBe(1);
      // BullMQ chỉ ghi nhận attemptsMade cho lượt chạy hoàn tất:
      // cả 4 lượt lỗi trước đó không lượt nào bị tính, duy nhất
      // lượt chạy thành công cuối được tính 1.
      const freshAfterSuccess = await queue.getJob(outboxId);
      expect(freshAfterSuccess?.attemptsMade).toBe(1);
    },
    120_000,
  );
});
