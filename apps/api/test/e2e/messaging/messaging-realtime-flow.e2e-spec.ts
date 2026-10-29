import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';

/**
 * Flow test cho nền dữ liệu + realtime của messaging (issue #33,
 * Lớp A chặng 0 + 1):
 *  - trạng thái đã đọc theo TỪNG thành viên trong nhóm 3 người: một
 *    người đọc không làm người khác mất số chưa đọc (mô hình cũ để
 *    mốc đọc chung trên tin nhắn);
 *  - gửi trùng `clientMessageId` không nhân đôi tin (idempotent);
 *  - phân trang cursor theo `seq` không trùng/sót, đồng bộ thiếu hụt
 *    bằng afterSeq;
 *  - realtime theo KẾT NỐI ở phía API: nối lại + `sync` bù đúng phần
 *    thiếu; socket không có token hợp lệ bị ngắt; presence/typing
 *    (A2) đi qua Redis, không xuống DB.
 *
 * Các khẳng định về PHÂN PHỐI sự kiện (tin mới tới socket qua
 * outbox → hàng đợi, biên đã-đọc tới thành viên còn lại, thành viên
 * bị gỡ không nhận tin nữa) thuộc về consumer phía worker từ issue
 * #521 và được kiểm ở
 * `apps/worker/test/integration/messaging/messaging-realtime-queue.int-spec.ts`
 * — spec này chỉ giữ phần hành vi mà tiến trình API tự chịu trách
 * nhiệm (ghi dữ kiện + sự kiện outbox, đọc/sync, presence/typing).
 */

interface WireMessage {
  id: string;
  conversationId: string;
  userIdFrom: string;
  fullMessage: string;
  seq: number;
  clientMessageId: string | null;
}

/** Nối một socket đã xác thực và chờ 'connect'; lỗi xác thực phía server sẽ ngắt kết nối ngay. */
async function connectSocket(base: string, token: string): Promise<Socket> {
  const socket = io(`${base}/messaging`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
  return socket;
}

/** Chờ một sự kiện socket khớp điều kiện, có timeout rõ ràng để test fail có thông điệp đọc được. */
async function waitForSocketEvent<T>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean,
  timeoutMs = 9000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`không nhận được sự kiện ${event} khớp điều kiện trong ${timeoutMs}ms`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

describe('Messaging foundation + realtime (issue #33, Lớp A)', () => {
  let app: INestApplication;
  let base: string;
  let admin: string;
  let userA: { id: string; username: string };
  let userB: { id: string; username: string };
  let userC: { id: string; username: string };
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let convId: string;

  const sockets: Socket[] = [];
  async function connect(token: string): Promise<Socket> {
    const socket = await connectSocket(base, token);
    sockets.push(socket);
    return socket;
  }

  async function sendAs(token: string, text: string, clientMessageId?: string) {
    const res = await http(app).post(`/api/v1/messages/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send(clientMessageId ? { text, clientMessageId } : { text });
    expect(res.status).toBe(201);
    return res.body as WireMessage;
  }

  async function listEntry(token: string) {
    const res = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const entry = (res.body as { id: string }[]).find((c) => c.id === convId) as
      { unread: number; lastReadSeq: number; lastMessageSeq: number; lastMessage: WireMessage | null } | undefined;
    expect(entry).toBeDefined();
    return entry!;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = await adminToken(app);
    userA = await createUserViaApi(app, admin);
    userB = await createUserViaApi(app, admin);
    userC = await createUserViaApi(app, admin);
    tokenA = (await login(app, userA.username, STRONG_PASSWORD)).accessToken;
    tokenB = (await login(app, userB.username, STRONG_PASSWORD)).accessToken;
    tokenC = (await login(app, userC.username, STRONG_PASSWORD)).accessToken;
    // Conversation nhóm 3 người — cổng liên lạc chỉ áp cho conversation
    // 1-1 nên nhóm gửi tự do, đúng luật hiện hữu. Nhóm do ADMIN tạo:
    // theo chính sách Lớp B của #33, học sinh không tự lập nhóm tự do —
    // nhóm chỉ do giáo viên/staff tạo (admin ở đây) hoặc sinh từ cấu
    // trúc lớp/khoá. Ba user A/B/C là thành viên thường của nhóm.
    const conv = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${admin}`)
      .send({ type: 2, memberIds: [userA.id, userB.id, userC.id], name: 'Nhóm kiểm thử #33' });
    expect(conv.status).toBe(201);
    convId = conv.body.id as string;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await app.close();
  });

  it('read state is per member: B reading does not clear C unread (group of 3)', async () => {
    const first = await sendAs(tokenA, 'tin thứ nhất');
    const second = await sendAs(tokenA, 'tin thứ hai');
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);

    const bBefore = await listEntry(tokenB);
    expect(bBefore.unread).toBe(2);
    expect(bBefore.lastReadSeq).toBe(0);
    expect(bBefore.lastMessage?.seq).toBe(2);
    const cBefore = await listEntry(tokenC);
    expect(cBefore.unread).toBe(2);

    const read = await http(app).post(`/api/v1/messages/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${tokenB}`).send({});
    expect(read.status).toBe(201);
    expect(read.body.marked).toBe(2);
    expect(read.body.lastReadSeq).toBe(2);

    const bAfter = await listEntry(tokenB);
    expect(bAfter.unread).toBe(0);
    expect(bAfter.lastReadSeq).toBe(2);
    // Điểm cốt lõi chống mô hình cũ: C vẫn còn nguyên 2 tin chưa đọc.
    const cAfter = await listEntry(tokenC);
    expect(cAfter.unread).toBe(2);
    expect(cAfter.lastReadSeq).toBe(0);

    const cCounts = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${tokenC}`);
    expect(cCounts.body.conversations).toBe(1);
    const bCounts = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${tokenB}`);
    expect(bCounts.body.conversations).toBe(0);
  });

  it('send is idempotent per clientMessageId: a retry returns the stored message', async () => {
    const firstSend = await sendAs(tokenA, 'nội dung gốc', 'retry-key-1');
    expect(firstSend.clientMessageId).toBe('retry-key-1');
    const retry = await sendAs(tokenA, 'nội dung khác hẳn', 'retry-key-1');
    expect(retry.id).toBe(firstSend.id);
    expect(retry.seq).toBe(firstSend.seq);
    expect(retry.fullMessage).toBe('nội dung gốc');

    const all = await http(app).get(`/api/v1/messages/conversations/${convId}/messages?limit=100`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(all.status).toBe(200);
    const withKey = (all.body.messages as WireMessage[]).filter((m) => m.clientMessageId === 'retry-key-1');
    expect(withKey).toHaveLength(1);
    // Seq không bị tiêu tốn bởi lần gửi trùng.
    const entry = await listEntry(tokenA);
    expect(entry.lastMessageSeq).toBe(firstSend.seq);
  });

  it('cursor pagination by seq has no duplicates or gaps', async () => {
    for (const text of ['bốn', 'năm', 'sáu', 'bảy']) await sendAs(tokenA, text);
    // Tổng 7 tin, seq 1..7.
    const detail = await http(app).get(`/api/v1/messages/conversations/${convId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(detail.status).toBe(200);
    expect((detail.body.messages as WireMessage[]).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(detail.body.hasMoreBefore).toBe(false);
    expect(detail.body.memberReadMarkers).toContainEqual({ userId: userB.id, lastReadSeq: 2 });

    const older = await http(app).get(`/api/v1/messages/conversations/${convId}/messages?beforeSeq=4&limit=3`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect((older.body.messages as WireMessage[]).map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(older.body.hasMoreBefore).toBe(false);

    const middle = await http(app).get(`/api/v1/messages/conversations/${convId}/messages?beforeSeq=7&limit=3`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect((middle.body.messages as WireMessage[]).map((m) => m.seq)).toEqual([4, 5, 6]);
    expect(middle.body.hasMoreBefore).toBe(true);

    const missing = await http(app).get(`/api/v1/messages/conversations/${convId}/messages?afterSeq=5`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect((missing.body.messages as WireMessage[]).map((m) => m.seq)).toEqual([6, 7]);

    const newestWindow = await http(app).get(`/api/v1/messages/conversations/${convId}/messages?limit=2`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect((newestWindow.body.messages as WireMessage[]).map((m) => m.seq)).toEqual([6, 7]);
    expect(newestWindow.body.hasMoreBefore).toBe(true);
  });

  it('reconnect sync returns exactly the messages missed while offline', async () => {
    // Hai hành động dưới đây trước đây thuộc hai ca realtime riêng
    // (tin mới tới socket + biên đã-đọc tới thành viên còn lại): phần
    // khẳng định qua socket đã chuyển sang spec tích hợp của worker
    // (issue #521, xem ghi chú đầu file); ở đây chỉ giữ khẳng định
    // REST và giữ nguyên chuỗi seq mà ca sync phía dưới neo vào.
    const eighth = await sendAs(tokenA, 'tin realtime');
    expect(eighth.seq).toBe(8);
    const read = await http(app).post(`/api/v1/messages/conversations/${convId}/read`)
      .set('Authorization', `Bearer ${tokenB}`).send({});
    expect(read.status).toBe(201);
    expect(read.body.lastReadSeq).toBe(8);

    const ninth = await sendAs(tokenA, 'thiếu một');
    const tenth = await sendAs(tokenA, 'thiếu hai');
    expect(ninth.seq).toBe(9);
    expect(tenth.seq).toBe(10);

    const socketB = await connect(tokenB);
    const result = await socketB.emitWithAck('sync', { [convId]: 8 }) as Record<string, WireMessage[]>;
    expect(result[convId]?.map((m) => m.seq)).toEqual([9, 10]);
    expect(result[convId]?.map((m) => m.id)).toEqual([ninth.id, tenth.id]);
    socketB.disconnect();
  });

  it('a socket with an invalid token is disconnected and receives nothing', async () => {
    const bad = io(`${base}/messaging`, {
      auth: { token: 'token-khong-hop-le' },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    sockets.push(bad);
    const outcome = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 6000);
      bad.on('connect', () => { /* server có thể accept ở tầng transport rồi mới ngắt sau xác thực */ });
      bad.on('disconnect', () => { clearTimeout(timer); resolve('disconnected'); });
      bad.on('connect_error', () => { clearTimeout(timer); resolve('connect_error'); });
    });
    expect(['disconnected', 'connect_error']).toContain(outcome);
    expect(bad.connected).toBe(false);
    bad.disconnect();
  });

  it('presence and typing (A2): peers see online state and typing signals', async () => {
    const socketA = await connect(tokenA);
    const socketB = await connect(tokenB);

    const presenceSeen = waitForSocketEvent<{ userId: string; online: boolean }>(
      socketA, 'presence.changed', (p) => p.userId === userC.id && p.online === true,
    );
    const socketC = await connect(tokenC);
    await presenceSeen;

    const typingSeen = waitForSocketEvent<{ conversationId: string; userId: string }>(
      socketA, 'typing', (p) => p.conversationId === convId && p.userId === userB.id,
    );
    const ack = await socketB.emitWithAck('typing', { conversationId: convId }) as { ok: boolean };
    expect(ack.ok).toBe(true);
    await typingSeen;

    const offlineSeen = waitForSocketEvent<{ userId: string; online: boolean }>(
      socketA, 'presence.changed', (p) => p.userId === userC.id && p.online === false,
    );
    socketC.disconnect();
    await offlineSeen;

    socketA.disconnect();
    socketB.disconnect();
  });

});
