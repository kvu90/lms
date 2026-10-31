import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';

/**
 * Ảnh chụp hiện diện ban đầu (issue #592): socket vừa nối nhận
 * ngay tập đối tác đang trực tuyến trong phạm vi hội thoại của
 * mình bằng đúng sự kiện `presence.changed` vốn có — không cần
 * sửa client (bản đồ presence của client chỉ được nuôi bằng sự
 * kiện này). Đối tác ngoại tuyến lúc nối vắng khỏi tập, nên
 * client vẫn giữ trạng thái "chưa biết" với họ thay vì đoán
 * ngoại tuyến.
 *
 * Hai ca: (1) đối tác nối trước — người xem nối sau nhận ngay
 * sự kiện online của đối tác; (2) đối tác chưa từng nối — người
 * xem nối và không nhận sự kiện nào của đối tác trong cửa sổ
 * chờ (sau khi sự kiện của chính mình đã về, chứng tỏ lượt ảnh
 * chụp đã chạy xong).
 */
interface Person { id: string; username: string; token: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Messaging — ảnh chụp hiện diện ban đầu khi socket mới nối (issue #592)', () => {
  let app: INestApplication;
  let base: string;
  let redis: Redis;
  const sockets: Socket[] = [];

  async function person(firstName: string, lastName: string): Promise<Person> {
    const admin = await adminToken(app);
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  function connectSocket(token: string): Promise<Socket> {
    const socket: Socket = io(`${base}/messaging`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  async function waitForPresenceKey(userId: string): Promise<void> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const keys = await redis.keys(`lms:messaging:presence:*:${userId}`);
      if (keys.length > 0) return;
      if (Date.now() > deadline) throw new Error(`không thấy khoá presence của ${userId}`);
      await sleep(60);
    }
  }

  async function waitForSocketEvent<T>(
    socket: Socket, event: string, match: (payload: T) => boolean, timeoutMs = 9000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`hết hạn chờ sự kiện ${event}`)), timeoutMs);
      const handler = (payload: T) => {
        if (match(payload)) { clearTimeout(timer); socket.off(event, handler); resolve(payload); }
      };
      socket.on(event, handler);
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    redis.disconnect();
    await app.close();
  });

  it('đối tác đã trực tuyến trước — người xem nối sau nhận ngay sự kiện online của đối tác trong ảnh chụp', async () => {
    const admin = await adminToken(app);
    const partner = await person('Phuc', 'OnlineTruoc');
    const viewer = await person('Van', 'XemSau');
    const third = await person('Thu', 'ThuBa');
    const created = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${admin}`).send({ memberIds: [partner.id, viewer.id, third.id], type: 2 });
    expect(created.status).toBe(201);

    // Đối tác nối trước, chờ khoá presence của họ đã ghi xong.
    const partnerSocket = await connectSocket(partner.token);
    await waitForPresenceKey(partner.id);

    // Người xem nối sau, gắn listener TRƯỚC khi handshake chạy xong
    // để không bỏ lỡ ảnh chụp gửi ngay sau khi nối.
    const viewerSocket: Socket = io(`${base}/messaging`, {
      auth: { token: viewer.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    sockets.push(viewerSocket);
    const snapshotSeen = waitForSocketEvent<{ userId: string; online: boolean }>(
      viewerSocket, 'presence.changed', (p) => p.userId === partner.id && p.online === true,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      viewerSocket.once('connect', () => { clearTimeout(timer); resolve(); });
      viewerSocket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });

    const snapshot = await snapshotSeen;
    expect(snapshot).toEqual({ userId: partner.id, online: true });
    partnerSocket.disconnect();
  });

  it('đối tác chưa từng nối — người xem nối và không nhận sự kiện nào của đối tác', async () => {
    const admin = await adminToken(app);
    const partner = await person('Quang', 'ChuaNoi');
    const viewer = await person('Minh', 'XemOffline');
    const created = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${admin}`).send({ memberIds: [partner.id, viewer.id], type: 2 });
    expect(created.status).toBe(201);

    const viewerSocket: Socket = io(`${base}/messaging`, {
      auth: { token: viewer.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    sockets.push(viewerSocket);
    const seen: { userId: string; online: boolean }[] = [];
    viewerSocket.on('presence.changed', (p: { userId: string; online: boolean }) => { seen.push(p); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      viewerSocket.once('connect', () => { clearTimeout(timer); resolve(); });
      viewerSocket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });
    // Chờ sự kiện của chính mình về (lượt ghi presence đã chạy),
    // rồi thêm một cửa sổ lặng để khẳng định không có sự kiện
    // của đối tác ngoại tuyến trong ảnh chụp.
    await waitForSocketEvent<{ userId: string; online: boolean }>(
      viewerSocket, 'presence.changed', (p) => p.userId === viewer.id && p.online === true,
    );
    await sleep(1000);

    expect(seen.some((p) => p.userId === partner.id)).toBe(false);
  });
});
