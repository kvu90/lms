import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * Flow test cho stream SSE số thông báo chưa đọc
 * (GET /notifications/unread-count/stream):
 *  - mở stream → sự kiện `unread-count` đầu tiên là snapshot số hiện tại;
 *  - có thông báo mới → server đẩy số tăng qua Redis pub/sub;
 *  - đánh dấu đã đọc / đọc tất cả → server đẩy số giảm;
 *  - stream của user khác không nhận sự kiện của user này;
 *  - xác thực: access token qua query `access_token` (EventSource không
 *    đặt được header) hoặc Bearer header như mọi route khác; thiếu
 *    token thì 401.
 */

interface StreamEvent { type: string; data: unknown }

interface StreamClient {
  events: StreamEvent[];
  unreadEvents(): number[];
  waitForUnread(expected: number, timeoutMs?: number): Promise<void>;
  waitForUnreadAfter(index: number, expected: number, timeoutMs?: number): Promise<void>;
  close(): void;
}

/** Bộ đọc SSE tối thiểu trên fetch streaming: tách frame theo dòng trống, đọc cặp event:/data:. */
async function openStream(url: string, headers: Record<string, string> = {}): Promise<StreamClient> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  if (res.status !== 200 || !res.body) {
    throw new Error(`stream open failed: ${res.status}`);
  }
  const events: StreamEvent[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          let type = 'message';
          let dataText = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) type = line.slice('event:'.length).trim();
            if (line.startsWith('data:')) dataText += line.slice('data:'.length).trim();
          }
          if (dataText) {
            try { events.push({ type, data: JSON.parse(dataText) as unknown }); } catch { /* frame không phải JSON: bỏ qua */ }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Abort khi đóng stream là đường kết thúc bình thường của test.
    }
  })();

  const unreadEvents = () => events
    .filter((e) => e.type === 'unread-count')
    .map((e) => (e.data as { unread: number }).unread);

  return {
    events,
    unreadEvents,
    async waitForUnread(expected: number, timeoutMs = 8000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (unreadEvents().includes(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`không nhận được sự kiện unread=${expected}; đã nhận: ${JSON.stringify(unreadEvents())}`);
    },
    async waitForUnreadAfter(index: number, expected: number, timeoutMs = 8000): Promise<void> {
      // Chờ sự kiện MỚI (từ vị trí index trở đi) — vì lịch sử đã chứa sẵn
      // các giá trị cũ (snapshot 0, lần tăng 1 trước đó), chờ theo giá
      // trị đơn thuần sẽ khớp ngay sự kiện cũ và kết luận sai.
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (unreadEvents().slice(index).includes(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`không nhận được sự kiện mới unread=${expected} sau vị trí ${index}; đã nhận: ${JSON.stringify(unreadEvents())}`);
    },
    close(): void { controller.abort(); },
  };
}

describe('Notification unread count SSE stream', () => {
  let app: INestApplication;
  let base: string;
  let admin: string;
  let userA: { id: string; username: string };
  let userB: { id: string; username: string };
  let tokenA: string;
  let tokenB: string;
  let streamA: StreamClient;
  let streamB: StreamClient;

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = await adminToken(app);
    userA = await createUserViaApi(app, admin);
    userB = await createUserViaApi(app, admin);
    tokenA = (await login(app, userA.username, STRONG_PASSWORD)).accessToken;
    tokenB = (await login(app, userB.username, STRONG_PASSWORD)).accessToken;
  });

  afterAll(async () => {
    streamA?.close();
    streamB?.close();
    await app.close();
  });

  async function sendNotificationTo(userId: string, subject: string) {
    const res = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId, provider: 'badge_awarded', subject, body: 'Nội dung kiểm thử stream' });
    expect(res.status).toBe(201);
    expect(res.body.channels.popup).toBe('delivered');
    return res.body.notificationId as string;
  }

  it('mở stream bằng query token: sự kiện đầu tiên là snapshot số hiện tại (0)', async () => {
    streamA = await openStream(`${base}/api/v1/notifications/unread-count/stream?access_token=${encodeURIComponent(tokenA)}`);
    await streamA.waitForUnread(0);
    expect(streamA.unreadEvents()[0]).toBe(0);
  });

  it('thông báo mới cho A: stream của A đẩy số tăng, stream của B không đổi', async () => {
    streamB = await openStream(`${base}/api/v1/notifications/unread-count/stream?access_token=${encodeURIComponent(tokenB)}`);
    await streamB.waitForUnread(0);

    await sendNotificationTo(userA.id, 'Huy hiệu cho A');
    await streamA.waitForUnread(1);

    // Cho tín hiệu (nếu có) thời gian tới B rồi khẳng định B chỉ có snapshot.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(streamB.unreadEvents()).toEqual([0]);
  });

  it('đánh dấu đã đọc: stream đẩy số giảm về 0', async () => {
    const list = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${tokenA}`);
    expect(list.body).toHaveLength(1);
    const before = streamA.unreadEvents().length;
    const read = await http(app).post(`/api/v1/notifications/${list.body[0].id}/read`).set('Authorization', `Bearer ${tokenA}`);
    expect(read.status).toBe(201);
    await streamA.waitForUnreadAfter(before, 0);
    expect(streamA.unreadEvents().at(-1)).toBe(0);
  });

  it('đọc tất cả: số tăng khi có thông báo mới rồi giảm về 0', async () => {
    const beforeSend = streamA.unreadEvents().length;
    await sendNotificationTo(userA.id, 'Huy hiệu thứ hai cho A');
    await streamA.waitForUnreadAfter(beforeSend, 1);
    const beforeReadAll = streamA.unreadEvents().length;
    const readAll = await http(app).post('/api/v1/notifications/read-all').set('Authorization', `Bearer ${tokenA}`);
    expect(readAll.status).toBe(201);
    await streamA.waitForUnreadAfter(beforeReadAll, 0);
    expect(streamA.unreadEvents().at(-1)).toBe(0);
  });

  it('mở stream bằng Bearer header vẫn dùng được như mọi route khác', async () => {
    const stream = await openStream(`${base}/api/v1/notifications/unread-count/stream`, { Authorization: `Bearer ${tokenB}` });
    await stream.waitForUnread(0);
    stream.close();
  });

  it('thiếu token thì stream bị từ chối 401', async () => {
    const res = await fetch(`${base}/api/v1/notifications/unread-count/stream`);
    expect(res.status).toBe(401);
    await res.text().catch(() => undefined);
  });

  it('query token KHÔNG được chấp nhận ở route thường khác', async () => {
    const res = await fetch(`${base}/api/v1/notifications/unread-count?access_token=${encodeURIComponent(tokenA)}`);
    expect(res.status).toBe(401);
    await res.text().catch(() => undefined);
  });
});
