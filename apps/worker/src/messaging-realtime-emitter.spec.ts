/**
 * Cổng phát realtime messaging ở worker — xác nhận publish Redis
 * (issue #521; điểm sửa của PR #543 theo kết luận đối chiếu độc
 * lập: ghi dấu đã-phân-phối trước khi publish được xác nhận).
 *
 * Dựng đường THẬT của worker: processor thật + tầng phân phối dùng
 * chung `@lms/messaging` + cổng phát thật
 * `createMessagingRealtimeEmitter`, và một Socket.IO server độc lập
 * đóng vai phía API (cùng Redis adapter, client socket.io thật đã
 * vào room theo đúng luật gateway). Bề mặt đọc dữ kiện được giả lập
 * ở biên store vì điểm kiểm nằm ở tầng phát/ghi dấu, không nằm ở
 * luật đọc. Hai hành vi chốt:
 *
 * - Publish lành mạnh: `process()` hoàn thành, client phía API
 *   nhận đủ `message.new` + `conversation.updated`, và dấu
 *   đã-phân-phối theo `outboxId` được ghi.
 * - Chỉ đường publish bị hỏng (connection publish của cổng phát
 *   dùng một user Redis riêng bị từ chối đúng lệnh `PUBLISH` bằng
 *   ACL, trong khi connection ghi dấu dùng user mặc định, lành
 *   mạnh): lỗi publish nổi lên thành lỗi phân phối, processor
 *   biến nó thành tín hiệu hoãn thử lại (`DelayedError`), dấu
 *   KHÔNG được ghi, phía API không nhận sự kiện nào của tin đó —
 *   để lượt phát lại của BullMQ còn đất phân phối tiếp; và lượt
 *   xử lý lại cùng job bằng cổng phát lành mạnh phân phối được
 *   thật và ghi dấu.
 *
 * User ACL của test được xoá trong `afterAll`; mọi dấu ghi trong
 * test được dọn cùng lúc.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DelayedError } from 'bullmq';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import {
  conversationRoom,
  createMessagingDistributionService,
  userRoom,
  type MessagingDistributionStore,
} from '@lms/messaging';
import {
  createMessagingRealtimeEmitter,
  type MessagingRealtimeEmitterHandle,
} from './messaging-realtime-emitter';
import { SpaceJobRunner } from './db/routing/space-job-runner';
import type { SpaceDatabaseService } from './db/routing/space-database.service';
import {
  MESSAGING_DISTRIBUTED_KEY_PREFIX,
  MessagingRealtimeProcessor,
} from './processors/messaging-realtime.processor';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const ACL_USER = 'lms-test-nopublish';
const ACL_PASS = 'lms-test-nopublish-pass';

const tenantId = 'emitter-spec-tenant';
const convId = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

interface ReceivedEvent { event: string; payload: { message?: { id?: string } } }
const received: ReceivedEvent[] = [];
const usedOutboxIds: string[] = [];

function makeRow(id: string, seq: number): Record<string, unknown> {
  return {
    id,
    conversationId: convId,
    userIdFrom: userA,
    subject: '',
    fullMessage: `tin kiểm cổng phát ${seq}`,
    smallMessage: `tin kiểm cổng phát ${seq}`,
    seq,
    clientMessageId: null,
    deletedAt: null,
    deletedBy: null,
    recalledAt: null,
    recalledBy: null,
    replyToMessageId: null,
    createdAt: new Date(),
  };
}

const rows = new Map<string, Record<string, unknown>>();
const store: MessagingDistributionStore = {
  getMessage: async (id: string) => rows.get(id) as never,
  listMembers: async () => [userA, userB],
  getConversation: async () => ({ id: convId, type: 2, tenantId }) as never,
  getConversationTenantId: async () => tenantId,
  listBlockedCounterpartIds: async () => [],
  attachQuotes: async (input: never[]) => input.map((row) => ({ ...(row as object), replyTo: null })) as never,
  countUnreadForConversation: async () => 0,
  listMessages: async () => [],
};

function makeProcessor(emitterHandle: MessagingRealtimeEmitterHandle, markRedis: Redis): MessagingRealtimeProcessor {
  const distribution = createMessagingDistributionService({
    store,
    emitter: emitterHandle.emitter,
    logger: { warn: () => undefined, error: () => undefined },
  });
  // Bộ chạy job với dịch vụ định tuyến không cấu hình sổ: mọi
  // job của spec mang slug rỗng nên phiên chạy giữ nguyên đường
  // platform như trước (định tuyến kho có spec riêng).
  const runner = new SpaceJobRunner({
    resolveTarget: async () => {
      throw new Error('spec không cấu hình sổ đăng ký');
    },
  } as unknown as SpaceDatabaseService);
  return new MessagingRealtimeProcessor(distribution, markRedis, runner);
}

function jobOf(outboxId: string, messageId: string, seq: number): never {
  usedOutboxIds.push(outboxId);
  return {
    data: {
      outboxId,
      seq,
      aggregate: 'messaging',
      type: 'message_sent',
      payload: { messageId },
      tenantId,
      occurredAt: new Date().toISOString(),
    },
  } as never;
}

async function waitUntil(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 60); });
  }
  throw new Error(`hết hạn chờ ${label} sau ${timeoutMs}ms`);
}

describe('Cổng phát realtime messaging ở worker — publish Redis phải được xác nhận trước khi ghi dấu', () => {
  let httpServer: HttpServer;
  let ioServer: Server;
  let client: ClientSocket;
  let markRedis: Redis;
  let adminRedis: Redis;
  let healthyEmitter: MessagingRealtimeEmitterHandle;
  let port = 0;

  beforeAll(async () => {
    markRedis = new Redis(REDIS_URL);
    adminRedis = new Redis(REDIS_URL);

    // Server Socket.IO độc lập đóng vai phía API: cùng Redis
    // adapter, gắn socket vào room theo đúng luật gateway (room
    // riêng của user + room của các conversation, `data.userId`
    // gắn lúc bắt tay).
    const pub = new Redis(REDIS_URL);
    const sub = pub.duplicate();
    httpServer = createServer();
    ioServer = new Server(httpServer);
    ioServer.adapter(createAdapter(pub, sub) as never);
    ioServer.of('/messaging').on('connection', (socket) => {
      const auth = socket.handshake.auth as { userId: string; tenantId: string | null; conversationIds?: string[] };
      socket.data.userId = auth.userId;
      void socket.join(userRoom(auth.tenantId, auth.userId));
      for (const conversationId of auth.conversationIds ?? []) {
        void socket.join(conversationRoom(auth.tenantId, conversationId));
      }
    });
    await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
    port = (httpServer.address() as AddressInfo).port;

    client = clientIo(`http://127.0.0.1:${port}/messaging`, {
      auth: { userId: userB, tenantId, conversationIds: [convId] },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    for (const event of ['message.new', 'conversation.updated', 'message.read', 'message.deleted', 'conversation.invalidate']) {
      client.on(event, (payload: ReceivedEvent['payload']) => { received.push({ event, payload }); });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      client.once('connect', () => { clearTimeout(timer); resolve(); });
      client.once('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
    });

    healthyEmitter = createMessagingRealtimeEmitter(REDIS_URL);
  }, 60000);

  afterAll(async () => {
    client?.disconnect();
    ioServer?.close();
    httpServer?.close();
    await healthyEmitter?.close().catch(() => undefined);
    if (usedOutboxIds.length > 0) {
      await adminRedis?.del(...usedOutboxIds.map((id) => `${MESSAGING_DISTRIBUTED_KEY_PREFIX}${id}`)).catch(() => undefined);
    }
    await adminRedis?.call('ACL', 'DELUSER', ACL_USER).catch(() => undefined);
    adminRedis?.disconnect();
    markRedis?.disconnect();
  }, 60000);

  it('publish lành mạnh: process() hoàn thành, client phía API nhận đủ sự kiện và dấu đã-phân-phối được ghi', async () => {
    const messageId = randomUUID();
    const outboxId = randomUUID();
    rows.set(messageId, makeRow(messageId, 1));
    const processor = makeProcessor(healthyEmitter, markRedis);

    await processor.process(jobOf(outboxId, messageId, 1));

    await waitUntil(
      () => received.some((e) => e.event === 'message.new' && e.payload.message?.id === messageId),
      8000,
      'client nhận message.new khi publish lành mạnh',
    );
    await waitUntil(
      () => received.some((e) => e.event === 'conversation.updated' && e.payload.message?.id === messageId),
      8000,
      'client nhận conversation.updated khi publish lành mạnh',
    );
    expect(await markRedis.exists(`${MESSAGING_DISTRIBUTED_KEY_PREFIX}${outboxId}`)).toBe(1);
  }, 60000);

  it('publish bị Redis từ chối trong khi đường ghi dấu lành mạnh: process() ném DelayedError hẹn thử lại, dấu không được ghi, phía API không nhận sự kiện; lượt chạy lại bằng cổng phát lành mạnh phân phối được và ghi dấu', async () => {
    // User Redis riêng cho connection publish của cổng phát: mọi
    // lệnh chạy trừ PUBLISH (bị NOPERM) — đường ghi dấu dùng
    // connection mặc định, không liên quan.
    await adminRedis.call(
      'ACL', 'SETUSER', ACL_USER, 'reset', 'on', `>${ACL_PASS}`, 'allchannels',
      '+subscribe', '+psubscribe', '+unsubscribe', '+punsubscribe',
      '+ping', '+quit', '+client', '+select', '-publish',
    );
    const aclPub = new Redis(REDIS_URL, { username: ACL_USER, password: ACL_PASS, enableReadyCheck: false });
    await expect(aclPub.publish('emitter-spec-channel', 'x')).rejects.toThrow(/NOPERM/);
    aclPub.disconnect();

    const badEmitter = createMessagingRealtimeEmitter(REDIS_URL, { username: ACL_USER, password: ACL_PASS });
    const messageId = randomUUID();
    const outboxId = randomUUID();
    rows.set(messageId, makeRow(messageId, 2));
    try {
      const badProcessor = makeProcessor(badEmitter, markRedis);

      // Lỗi NOPERM của publish được cổng phát ném ra khỏi tầng
      // phân phối; processor bắt nó và trả tín hiệu hoãn thử lại
      // (DelayedError) thay vì để job bị tính là lần thử thất bại.
      await expect(badProcessor.process(jobOf(outboxId, messageId, 2))).rejects.toThrow(DelayedError);

      // Cho mọi tín hiệu muộn (nếu có) cơ hội tới trước khi khẳng
      // định "không nhận gì" trên trạng thái cuối.
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      expect(await markRedis.exists(`${MESSAGING_DISTRIBUTED_KEY_PREFIX}${outboxId}`)).toBe(0);
      expect(received.filter(
        (e) => (e.event === 'message.new' || e.event === 'conversation.updated') && e.payload.message?.id === messageId,
      )).toHaveLength(0);
    } finally {
      await badEmitter.close().catch(() => undefined);
    }

    // Lượt chạy lại của cùng job (BullMQ phát lại job đã hoãn)
    // bằng cổng phát lành mạnh: phân phối được thật, dấu được
    // ghi — sự kiện không mất vì lượt publish hỏng trước đó.
    const retryProcessor = makeProcessor(healthyEmitter, markRedis);
    await retryProcessor.process(jobOf(outboxId, messageId, 2));
    await waitUntil(
      () => received.some((e) => e.event === 'message.new' && e.payload.message?.id === messageId),
      8000,
      'client nhận message.new ở lượt thử lại',
    );
    expect(await markRedis.exists(`${MESSAGING_DISTRIBUTED_KEY_PREFIX}${outboxId}`)).toBe(1);
  }, 90000);
});
