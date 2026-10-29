import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import {
  message,
  messageConversationMembers,
  messageConversations,
  messageUsersBlocked,
  outboxEvents,
} from '@lms/db';
import { conversationRoom, userRoom } from '@lms/messaging';
import { OutboxRelayScheduler } from '../../../src/outbox-relay.scheduler';
import {
  MESSAGING_DISTRIBUTED_KEY_PREFIX,
  MessagingRealtimeProcessor,
} from '../../../src/processors/messaging-realtime.processor';
import type { OutboxEventJobData } from '../../../src/outbox-event-routes';
import {
  bootWorkerModuleAsOrdinaryRole,
  type OrdinaryWorkerModuleHarness,
} from '../../support/ordinary-worker-module';

/**
 * Phân phối realtime messaging ở worker (issue #521) — đường THẬT
 * của production sau khi consumer chuyển khỏi tiến trình API:
 * dòng outbox (ghi như đường nghiệp vụ phía API vẫn ghi) → relay
 * outbox duy nhất đóng dấu `publishedAt` và phát job vào hàng đợi
 * `messaging-realtime` → `MessagingRealtimeProcessor` → luật phân
 * phối dùng chung ở `@lms/messaging` → phát qua Redis adapter tới
 * một Socket.IO server độc lập đóng vai phía API (gắn socket vào
 * room đúng luật gateway: room riêng của user + room của các
 * conversation, `data.userId` gắn lúc bắt tay).
 *
 * Các ca ở đây là nơi cư trú mới của các khẳng định phân phối vốn
 * nằm ở e2e phía API (messaging-realtime-flow, messaging-message-
 * lifecycle ca 6, messaging-block-visibility ca biên đã-đọc) và ở
 * spec neo watermark phía API (messaging-outbox-reanchor) — cùng
 * khẳng định hành vi quan sát được, đổi cơ chế vận hành:
 *  - tin mới tới đúng room, `conversation.updated` mang số chưa đọc
 *    của CHÍNH từng thành viên;
 *  - biên đã-đọc tới các thành viên còn lại;
 *  - thứ tự phát theo đúng thứ tự sự kiện;
 *  - thành viên đã bị gỡ khỏi conversation không nhận tin nữa và
 *    socket của họ bị đẩy khỏi room tại thời điểm phân phối (F1);
 *  - thu hồi: phía kia nhận `message.deleted` + `conversation.invalidate`,
 *    xem trước không lộ nội dung đã thu hồi;
 *  - xoá-phía-mình: chỉ chính người xoá nhận tín hiệu;
 *  - cổng chặn 1–1: sự kiện ghi TRƯỚC lúc chặn vẫn bị nén ở tầng
 *    phân phối (tin mới lẫn biên đã-đọc);
 *  - chống trùng/phát lại: cùng một sự kiện phân phối đúng một lần
 *    dù relay phát lại hay job được xử lý lại (dấu theo `outboxId`);
 *  - không watermark: cơ chế hàng đợi không giữ mốc `seq` nào, sự
 *    kiện ghi sau khi các dòng outbox của "đời trước" bị xoá sạch
 *    vẫn được phân phối (bài học issue #125 không còn đất tái diễn);
 *  - không lọt tenant: room có đoạn namespace tenant, socket ở
 *    tenant khác không nhận sự kiện dù trùng id conversation.
 *
 * Tín hiệu chốt của mỗi ca là dấu đã-phân-phối theo `outboxId`
 * trong Redis (processor chỉ ghi dấu sau khi phân phối xong) —
 * không sleep cố định nào thay cho tín hiệu trạng thái.
 */
describe('Worker — phân phối realtime messaging qua hàng đợi (issue #521)', () => {
  let context: INestApplicationContext;
  let harness: OrdinaryWorkerModuleHarness;
  let db: OrdinaryWorkerModuleHarness['adminDb'];
  let relay: OutboxRelayScheduler;
  let processor: MessagingRealtimeProcessor;
  let queue: Queue;
  let redis: Redis;
  let httpServer: HttpServer;
  let ioServer: Server;
  let port = 0;
  const clients: ClientSocket[] = [];

  const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

  interface ReceivedEvent { event: string; payload: unknown }
  const received = new Map<string, ReceivedEvent[]>();

  function eventsOf(clientKey: string, event?: string): ReceivedEvent[] {
    const all = received.get(clientKey) ?? [];
    return event ? all.filter((e) => e.event === event) : all;
  }

  /** Nối một client đóng vai một user: vào room riêng + room của các conversation như gateway phía API. */
  async function connectClient(clientKey: string, identity: { userId: string; tenantId: string | null; conversationIds: string[] }): Promise<ClientSocket> {
    const socket = clientIo(`http://127.0.0.1:${port}/messaging`, {
      auth: identity,
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    clients.push(socket);
    received.set(clientKey, []);
    for (const event of ['message.new', 'conversation.updated', 'message.read', 'message.deleted', 'conversation.invalidate']) {
      socket.on(event, (payload: unknown) => {
        received.get(clientKey)!.push({ event, payload });
      });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });
    return socket;
  }

  async function waitUntil(check: () => boolean, timeoutMs = 15000, label = 'điều kiện'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => { setTimeout(resolve, 60); });
    }
    throw new Error(`hết hạn chờ ${label} sau ${timeoutMs}ms`);
  }

  /** Chờ processor ghi dấu đã-phân-phối cho một sự kiện — tín hiệu "lượt phân phối đã chốt". */
  async function waitDistributed(outboxId: string): Promise<void> {
    const deadline = Date.now() + 15000;
    for (;;) {
      if ((await redis.exists(`${MESSAGING_DISTRIBUTED_KEY_PREFIX}${outboxId}`)) === 1) return;
      if (Date.now() > deadline) throw new Error(`hết hạn chờ dấu đã-phân-phối của ${outboxId}`);
      await new Promise((resolve) => { setTimeout(resolve, 60); });
    }
  }

  /** Khoảng lặng ngắn SAU khi lượt phân phối đã chốt để khẳng định "không nhận gì" trên trạng thái cuối. */
  async function settle(ms = 400): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  // --- fixture -----------------------------------------------------

  async function makeUser(id: string): Promise<void> {
    await db.execute(sql`insert into users (id, username, email, first_name, last_name, suspended, deleted) values (${id}, ${`u521-${id.slice(-8)}`}, ${`u521-${id.slice(-8)}@x.io`}, 'An', 'Nguyễn', false, false) on conflict (id) do nothing`);
  }

  async function makeTenant(id: string): Promise<void> {
    await db.execute(sql`insert into tenants (id, slug, name, kind) values (${id}, ${`t521-${id.slice(-8)}`}, 'Trung tâm 521', 'center') on conflict (id) do nothing`);
  }

  async function makeConversation(opts: { type: number; tenantId: string | null; memberIds: string[] }): Promise<string> {
    const id = randomUUID();
    await db.insert(messageConversations).values({
      id, type: opts.type, tenantId: opts.tenantId, lastMessageSeq: 0,
    });
    for (const userId of opts.memberIds) {
      await db.insert(messageConversationMembers).values({ conversationId: id, userId });
    }
    return id;
  }

  async function setLastReadSeq(conversationId: string, userId: string, seq: number): Promise<void> {
    await db.update(messageConversationMembers)
      .set({ lastReadSeq: seq })
      .where(sql`${messageConversationMembers.conversationId} = ${conversationId} and ${messageConversationMembers.userId} = ${userId}`);
  }

  async function makeMessage(opts: {
    conversationId: string; userIdFrom: string; seq: number; text: string;
    recalledAt?: Date; recalledBy?: string;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(message).values({
      id,
      conversationId: opts.conversationId,
      userIdFrom: opts.userIdFrom,
      subject: '',
      fullMessage: opts.text,
      smallMessage: opts.text,
      seq: opts.seq,
      recalledAt: opts.recalledAt ?? null,
      recalledBy: opts.recalledBy ?? null,
    });
    await db.update(messageConversations)
      .set({ lastMessageSeq: opts.seq })
      .where(eq(messageConversations.id, opts.conversationId));
    return id;
  }

  async function insertOutbox(type: string, payload: Record<string, unknown>, tenantId: string | null): Promise<string> {
    // Id của dòng outbox BẮT BUỘC là uuid v7 như production (mặc
    // định của cột và `$defaultFn` phía API đều sinh v7): relay
    // chuyển tiếp theo thứ tự id tăng dần, nên id ngẫu nhiên v4 sẽ
    // làm thứ tự chuyển tiếp lệch khỏi thứ tự ghi — giữ v7 để ca
    // thứ tự seq kiểm chứng đúng tiền đề của cơ chế thật.
    const id = uuidv7();
    await db.insert(outboxEvents).values({ id, aggregate: 'messaging', type, payload, tenantId });
    return id;
  }

  /** Ghi một tin + sự kiện message_sent như transaction gửi tin phía API, rồi relay và chờ phân phối chốt. */
  async function sendAndDistribute(opts: {
    conversationId: string; userIdFrom: string; seq: number; text: string; tenantId: string | null;
  }): Promise<{ messageId: string; outboxId: string }> {
    const messageId = await makeMessage(opts);
    const outboxId = await insertOutbox('message_sent', {
      conversationId: opts.conversationId, messageId, seq: opts.seq, fromUserId: opts.userIdFrom,
    }, opts.tenantId);
    await relay.publishPending();
    await waitDistributed(outboxId);
    return { messageId, outboxId };
  }

  beforeAll(async () => {
    harness = await bootWorkerModuleAsOrdinaryRole();
    context = harness.context;
    db = harness.adminDb;
    relay = context.get(OutboxRelayScheduler);
    processor = context.get(MessagingRealtimeProcessor);
    queue = context.get(getQueueToken('messaging-realtime'));
    redis = new Redis(REDIS_URL);

    // Socket.IO server độc lập đóng vai phía API: cùng Redis adapter,
    // gắn socket vào room theo đúng luật gateway khi bắt tay.
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
  }, 120000);

  afterAll(async () => {
    for (const client of clients) client.disconnect();
    ioServer.close();
    httpServer.close();
    redis.disconnect();
    await harness.close();
  });

  it('phân phối tin mới vào đúng room và conversation.updated mang số chưa đọc của chính từng thành viên', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    for (const u of [a, b, c]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b, c] });
    // Hai tin có sẵn (không sự kiện): seq 1 của A, seq 2 của C. B đã đọc tới 1.
    await makeMessage({ conversationId: convId, userIdFrom: a, seq: 1, text: 'tin một' });
    await makeMessage({ conversationId: convId, userIdFrom: c, seq: 2, text: 'tin hai' });
    await setLastReadSeq(convId, b, 1);
    await connectClient('a', { userId: a, tenantId, conversationIds: [convId] });
    await connectClient('b', { userId: b, tenantId, conversationIds: [convId] });
    await connectClient('c', { userId: c, tenantId, conversationIds: [convId] });

    const { messageId } = await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 3, text: 'tin ba mới', tenantId });

    await waitUntil(() => eventsOf('b', 'message.new').length === 1, 10000, 'B nhận message.new');
    const newPayload = eventsOf('b', 'message.new')[0]!.payload as { conversationId: string; message: { id: string; seq: number; fullMessage: string } };
    expect(newPayload.conversationId).toBe(convId);
    expect(newPayload.message.id).toBe(messageId);
    expect(newPayload.message.seq).toBe(3);
    expect(newPayload.message.fullMessage).toBe('tin ba mới');
    // Số chưa đọc của CHÍNH từng người: B = 2 (seq 2, 3), A = 1 (seq 2 của C), C = 2 (seq 1, 3 của A).
    const updatedOf = (key: string) => eventsOf(key, 'conversation.updated')
      .map((e) => e.payload as { conversationId: string; unreadCount: number; message: { id: string } })
      .find((p) => p.conversationId === convId && p.message.id === messageId);
    await waitUntil(() => updatedOf('a') !== undefined && updatedOf('b') !== undefined && updatedOf('c') !== undefined, 10000, 'đủ conversation.updated');
    expect(updatedOf('b')!.unreadCount).toBe(2);
    expect(updatedOf('a')!.unreadCount).toBe(1);
    expect(updatedOf('c')!.unreadCount).toBe(2);
  });

  it('phân phối biên đã-đọc tới các thành viên còn lại kèm mốc của người đọc', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 1, tenantId, memberIds: [a, b] });
    await makeMessage({ conversationId: convId, userIdFrom: a, seq: 1, text: 'chào' });
    await connectClient('a2', { userId: a, tenantId, conversationIds: [convId] });
    await connectClient('b2', { userId: b, tenantId, conversationIds: [convId] });

    await setLastReadSeq(convId, b, 1);
    const outboxId = await insertOutbox('message_conversation_read', { conversationId: convId, userId: b, lastReadSeq: 1 }, tenantId);
    await relay.publishPending();
    await waitDistributed(outboxId);

    await waitUntil(() => eventsOf('a2', 'message.read').length === 1, 10000, 'A nhận message.read');
    const payload = eventsOf('a2', 'message.read')[0]!.payload as { conversationId: string; userId: string; lastReadSeq: number };
    expect(payload).toEqual({ conversationId: convId, userId: b, lastReadSeq: 1 });
  });

  it('phân phối nhiều tin theo đúng thứ tự seq của các sự kiện', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('b3', { userId: b, tenantId, conversationIds: [convId] });

    const m1 = await makeMessage({ conversationId: convId, userIdFrom: a, seq: 1, text: 'thứ nhất' });
    const e1 = await insertOutbox('message_sent', { conversationId: convId, messageId: m1, seq: 1, fromUserId: a }, tenantId);
    // Chừa một nhịp thời gian rất ngắn để thứ tự id của hai dòng
    // outbox (uuidv7 theo thời gian) khớp thứ tự ghi.
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    const m2 = await makeMessage({ conversationId: convId, userIdFrom: a, seq: 2, text: 'thứ hai' });
    const e2 = await insertOutbox('message_sent', { conversationId: convId, messageId: m2, seq: 2, fromUserId: a }, tenantId);
    await relay.publishPending();
    await waitDistributed(e1);
    await waitDistributed(e2);

    await waitUntil(() => eventsOf('b3', 'message.new').length === 2, 10000, 'B nhận đủ hai tin');
    const seqs = eventsOf('b3', 'message.new').map((e) => (e.payload as { message: { seq: number } }).message.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it('thành viên bị gỡ khỏi conversation thì không nhận tin mới nữa và socket bị đẩy khỏi room tại thời điểm phân phối', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('a4', { userId: a, tenantId, conversationIds: [convId] });
    await connectClient('b4', { userId: b, tenantId, conversationIds: [convId] });

    // Sanity: còn là thành viên thì B nhận tin bình thường.
    await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 1, text: 'trước khi gỡ', tenantId });
    await waitUntil(() => eventsOf('b4', 'message.new').length === 1, 10000, 'B nhận tin khi còn là thành viên');

    // Gỡ B khỏi conversation (membership chốt lại ở DB).
    await db.delete(messageConversationMembers)
      .where(sql`${messageConversationMembers.conversationId} = ${convId} and ${messageConversationMembers.userId} = ${b}`);

    await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 2, text: 'sau khi gỡ', tenantId });
    // A (còn là thành viên) nhận tin mới: lượt phân phối đã thật sự chạy.
    await waitUntil(() => eventsOf('a4', 'message.new').some((e) => (e.payload as { message: { seq: number } }).message.seq === 2), 10000, 'A nhận tin sau khi gỡ');
    await settle();
    expect(eventsOf('b4', 'message.new')).toHaveLength(1);
    // Socket của B đã bị đẩy khỏi room của conversation.
    const sockets = await ioServer.of('/messaging').in(conversationRoom(tenantId, convId)).fetchSockets();
    expect(sockets.map((s) => (s.data as { userId?: string }).userId)).toEqual([a]);
  });

  it('thu hồi thì phía kia nhận message.deleted và conversation.invalidate, xem trước không lộ nội dung đã thu hồi', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('b5', { userId: b, tenantId, conversationIds: [convId] });

    const messageId = await makeMessage({
      conversationId: convId, userIdFrom: a, seq: 1, text: 'nội dung bí mật sẽ thu hồi',
      recalledAt: new Date(), recalledBy: a,
    });
    const outboxId = await insertOutbox('message_recalled', { conversationId: convId, messageId }, tenantId);
    await relay.publishPending();
    await waitDistributed(outboxId);

    await waitUntil(() => eventsOf('b5', 'message.deleted').length === 1, 10000, 'B nhận message.deleted');
    const deleted = eventsOf('b5', 'message.deleted')[0]!.payload as { conversationId: string; messageId: string; deletedBy: string };
    expect(deleted).toEqual({ conversationId: convId, messageId, seq: 1, deletedBy: a });
    await waitUntil(() => eventsOf('b5', 'conversation.invalidate').some((e) => (e.payload as { conversationId: string }).conversationId === convId), 10000, 'B nhận conversation.invalidate');
    // Xem trước tin cuối (chính tin đã thu hồi) phải đã bị vô hiệu nội dung.
    const updated = eventsOf('b5', 'conversation.updated')
      .map((e) => e.payload as { message: { id: string; fullMessage: string } })
      .find((p) => p.message.id === messageId);
    expect(updated).toBeDefined();
    expect(updated!.message.fullMessage).toBe('');
    // Không một sự kiện nào mang nội dung gốc tới B.
    expect(JSON.stringify(eventsOf('b5'))).not.toContain('nội dung bí mật sẽ thu hồi');
  });

  it('xoá-phía-mình chỉ phát tín hiệu cho chính người xoá, phía kia không nhận gì', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('a6', { userId: a, tenantId, conversationIds: [convId] });
    await connectClient('b6', { userId: b, tenantId, conversationIds: [convId] });
    const messageId = await makeMessage({ conversationId: convId, userIdFrom: b, seq: 1, text: 'tin của B' });

    const outboxId = await insertOutbox('message_deleted_for_me', {
      conversationId: convId, messageId, seq: 1, actorId: a,
    }, tenantId);
    await relay.publishPending();
    await waitDistributed(outboxId);

    await waitUntil(() => eventsOf('a6', 'message.deleted').length === 1, 10000, 'A nhận message.deleted của chính mình');
    await waitUntil(() => eventsOf('a6', 'conversation.invalidate').length === 1, 10000, 'A nhận conversation.invalidate');
    await settle();
    expect(eventsOf('b6')).toEqual([]);
  });

  it('biên đã-đọc ghi trước lúc chặn bị nén ở tầng phân phối, phía bị chặn không nhận message.read', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 1, tenantId, memberIds: [a, b] });
    await makeMessage({ conversationId: convId, userIdFrom: b, seq: 1, text: 'tin của B' });
    await connectClient('a7', { userId: a, tenantId, conversationIds: [convId] });
    await connectClient('b7', { userId: b, tenantId, conversationIds: [convId] });

    // Biên đã-đọc của A được ghi vào outbox TRƯỚC, quan hệ chặn có
    // SAU (consumer tiêu thụ sự kiện sau khi chặn đã hiệu lực).
    const outboxId = await insertOutbox('message_conversation_read', { conversationId: convId, userId: a, lastReadSeq: 1 }, tenantId);
    await db.insert(messageUsersBlocked).values({ userId: a, blockedUserId: b });
    await relay.publishPending();
    await waitDistributed(outboxId);

    await settle();
    expect(eventsOf('b7', 'message.read')).toEqual([]);
    expect(eventsOf('a7', 'message.read')).toEqual([]);
  });

  it('tin gửi trước lúc chặn bị nén ở tầng phân phối, phía bị chặn không nhận message.new lẫn conversation.updated', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 1, tenantId, memberIds: [a, b] });
    await connectClient('b8', { userId: b, tenantId, conversationIds: [convId] });

    const messageId = await makeMessage({ conversationId: convId, userIdFrom: a, seq: 1, text: 'tin gửi trước khi bị chặn' });
    const outboxId = await insertOutbox('message_sent', {
      conversationId: convId, messageId, seq: 1, fromUserId: a,
    }, tenantId);
    await db.insert(messageUsersBlocked).values({ userId: b, blockedUserId: a });
    await relay.publishPending();
    await waitDistributed(outboxId);

    await settle();
    expect(eventsOf('b8')).toEqual([]);
  });

  it('phát lại cùng một sự kiện không phân phối lần hai: relay không tạo job mới và processor bỏ qua job trùng theo outboxId', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('b9', { userId: b, tenantId, conversationIds: [convId] });

    const { outboxId } = await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 1, text: 'chỉ một lần', tenantId });
    await waitUntil(() => eventsOf('b9', 'message.new').length === 1, 10000, 'B nhận tin lần đầu');
    const completedBefore = (await queue.getJobCounts('completed')).completed;

    // Relay chạy lại: dòng đã có publishedAt nên không job mới nào sinh ra.
    await relay.publishPending();
    // Processor xử lý lại đúng job đó (mô phỏng job bị phát lại
    // ngoài cửa sổ chống trùng của hàng đợi): dấu theo outboxId chặn.
    const [row] = await db.select().from(outboxEvents).where(eq(outboxEvents.id, outboxId));
    const jobData: OutboxEventJobData = {
      outboxId,
      seq: row!.seq,
      aggregate: 'messaging',
      type: 'message_sent',
      payload: row!.payload as Record<string, unknown>,
      tenantId,
      occurredAt: row!.occurredAt.toISOString(),
    };
    await processor.process({ data: jobData } as never);
    await settle();
    expect((await queue.getJobCounts('completed')).completed).toBe(completedBefore);
    expect(eventsOf('b9', 'message.new')).toHaveLength(1);
  });

  it('không giữ watermark: sự kiện ghi sau khi các dòng outbox của đời trước bị xoá sạch vẫn được phân phối', async () => {
    const tenantId = randomUUID();
    await makeTenant(tenantId);
    const [a, b] = [randomUUID(), randomUUID()];
    for (const u of [a, b]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('b10', { userId: b, tenantId, conversationIds: [convId] });

    const first = await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 1, text: 'đời trước', tenantId });
    await waitUntil(() => eventsOf('b10', 'message.new').length === 1, 10000, 'B nhận tin đời trước');

    // "Đời DB mới": toàn bộ dòng outbox của conversation này biến
    // mất (như khi DB được dựng lại) — cơ chế hàng đợi không giữ
    // watermark nào nên không có mốc cũ nào làm mù sự kiện mới.
    await db.delete(outboxEvents).where(sql`${outboxEvents.payload} ->> 'conversationId' = ${convId}`);

    const second = await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 2, text: 'đời mới', tenantId });
    expect(second.outboxId).not.toBe(first.outboxId);
    await waitUntil(() => eventsOf('b10', 'message.new').length === 2, 10000, 'B nhận tin đời mới');
    const texts = eventsOf('b10', 'message.new').map((e) => (e.payload as { message: { fullMessage: string } }).message.fullMessage);
    expect(texts).toEqual(['đời trước', 'đời mới']);
  });

  it('không lọt sự kiện sang tenant khác dù trùng id conversation', async () => {
    const tenantId = randomUUID();
    const otherTenantId = randomUUID();
    await makeTenant(tenantId);
    await makeTenant(otherTenantId);
    const [a, b, x] = [randomUUID(), randomUUID(), randomUUID()];
    for (const u of [a, b, x]) await makeUser(u);
    const convId = await makeConversation({ type: 2, tenantId, memberIds: [a, b] });
    await connectClient('b11', { userId: b, tenantId, conversationIds: [convId] });
    // Socket của X "vào room" của cùng conversationId nhưng ở đoạn
    // tenant khác — room là một kênh khác hẳn.
    await connectClient('x11', { userId: x, tenantId: otherTenantId, conversationIds: [convId] });

    await sendAndDistribute({ conversationId: convId, userIdFrom: a, seq: 1, text: 'chỉ tenant mình', tenantId });
    await waitUntil(() => eventsOf('b11', 'message.new').length === 1, 10000, 'B nhận tin');
    await settle();
    expect(eventsOf('x11')).toEqual([]);
  });
});
