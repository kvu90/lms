import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';

/**
 * Chuẩn app nhắn tin phổ biến, chốt bổ sung trên issue #33
 * (24/10/2026): LIÊN HỆ ĐÃ CHẶN THÌ KHÔNG HIỆN Ở PHẦN TIN NHẮN.
 *  - Có quan hệ chặn ở bất kỳ chiều nào: conversation 1–1 và liên hệ
 *    của nhau biến mất khỏi danh sách của CẢ HAI phía (lọc ở tầng
 *    truy vấn, không xoá dữ liệu); huy hiệu chưa đọc không đếm
 *    conversation đang ẩn.
 *  - Gửi tin trong lúc chặn bị từ chối ở cả hai chiều
 *    (`messaging.contact_blocked`).
 *  - Trạng thái đã đọc của phía bên kia không lộ qua chi tiết
 *    conversation 1–1; presence (online) không phát tới phía bị chặn.
 *  - Bỏ chặn thì mọi bề mặt hiện lại nguyên trạng.
 */

interface Person { id: string; username: string; token: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Messaging — ẩn hội thoại/liên hệ khi có quan hệ chặn (issue #33)', () => {
  let app: INestApplication;
  let base: string;
  let a: Person;
  let b: Person;
  let conversationId: string;

  async function person(firstName: string, lastName: string): Promise<Person> {
    const admin = await adminToken(app);
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function conversationIds(token: string): Promise<string[]> {
    const res = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { id: string }[]).map((c) => c.id);
  }

  async function contactIds(token: string): Promise<string[]> {
    const res = await http(app).get('/api/v1/messages/contacts').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { contacts: string[] }).contacts;
  }

  async function send(token: string, text: string) {
    return http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`).send({ text });
  }

  function connectSocket(token: string): Promise<Socket> {
    const socket: Socket = io(`${base}/messaging`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 8000);
      socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
      socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
    });
  }

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    a = await person('An', 'Blocker');
    b = await person('Binh', 'Blocked');
    // Kết bạn hai chiều (yêu cầu–chấp nhận) rồi mở hội thoại 1–1.
    const req = await http(app).post(`/api/v1/messages/contacts/${b.id}`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/accept`)
      .set('Authorization', `Bearer ${b.token}`).send({});
    expect(acc.status).toBe(201);
    const created = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${a.token}`).send({ memberIds: [b.id], type: 1 });
    expect(created.status).toBe(201);
    conversationId = (created.body as { id: string }).id;
    // A gửi một tin (B chưa đọc — mốc cho huy hiệu chưa đọc), B gửi
    // một tin và A đọc hết (mốc đã đọc của A tồn tại để kiểm tra lộ).
    expect((await send(a.token, 'tin trước khi chặn')).status).toBe(201);
    expect((await send(b.token, 'tin trả lời')).status).toBe(201);
    const read = await http(app).post(`/api/v1/messages/conversations/${conversationId}/read`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(read.status).toBe(201);
  });
  afterAll(async () => {
    await app.close();
  });

  it('block hides the 1-1 conversation and the contact from BOTH sides; unblock restores them', async () => {
    // Đối chứng trước khi chặn: cả hai phía đều thấy hội thoại + liên hệ.
    expect(await conversationIds(a.token)).toContain(conversationId);
    expect(await conversationIds(b.token)).toContain(conversationId);
    expect(await contactIds(a.token)).toContain(b.id);
    expect(await contactIds(b.token)).toContain(a.id);
    const unreadBefore = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${b.token}`);
    expect((unreadBefore.body as { conversations: number }).conversations).toBe(1);
    // B mở chi tiết: thấy mốc đã đọc của A (đối chứng cho luật lộ).
    const detailBefore = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect((detailBefore.body as { memberReadMarkers: { userId: string }[] }).memberReadMarkers
      .some((m) => m.userId === a.id)).toBe(true);

    // A chặn B.
    const block = await http(app).post(`/api/v1/messages/contacts/${b.id}/block`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(block.status).toBe(201);

    // Cả hai phía: hội thoại 1–1 và liên hệ của nhau biến mất.
    expect(await conversationIds(a.token)).not.toContain(conversationId);
    expect(await conversationIds(b.token)).not.toContain(conversationId);
    expect(await contactIds(a.token)).not.toContain(b.id);
    expect(await contactIds(b.token)).not.toContain(a.id);
    // Huy hiệu chưa đọc của B không còn đếm conversation đang ẩn.
    const unreadAfter = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${b.token}`);
    expect((unreadAfter.body as { conversations: number }).conversations).toBe(0);

    // Gửi trong lúc chặn: bị từ chối ở CẢ HAI chiều.
    const sendByBlocked = await send(b.token, 'gửi khi bị chặn');
    expect(sendByBlocked.status).toBe(403);
    expect(sendByBlocked.body.code).toBe('messaging.contact_blocked');
    const sendByBlocker = await send(a.token, 'gửi khi đang chặn');
    expect(sendByBlocker.status).toBe(403);
    expect(sendByBlocker.body.code).toBe('messaging.contact_blocked');

    // Đã đọc không lộ: B mở chi tiết (lịch sử vẫn đọc được) nhưng
    // không còn mốc đã đọc của A; phía A cũng không thấy mốc của B.
    const detailB = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(detailB.status).toBe(200);
    expect((detailB.body as { memberReadMarkers: { userId: string }[] }).memberReadMarkers
      .some((m) => m.userId === a.id)).toBe(false);
    const detailA = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect((detailA.body as { memberReadMarkers: { userId: string }[] }).memberReadMarkers
      .some((m) => m.userId === b.id)).toBe(false);

    // Bỏ chặn: mọi bề mặt hiện lại nguyên trạng, gửi lại được.
    const unblock = await http(app).delete(`/api/v1/messages/contacts/${b.id}/block`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(unblock.status).toBe(200);
    expect(await conversationIds(a.token)).toContain(conversationId);
    expect(await conversationIds(b.token)).toContain(conversationId);
    expect(await contactIds(a.token)).toContain(b.id);
    expect(await contactIds(b.token)).toContain(a.id);
    expect((await send(b.token, 'gửi lại sau bỏ chặn')).status).toBe(201);
  });

  it('presence of the blocker does not reach the blocked peer while blocked, and flows again after unblock', async () => {
    const bSocket = await connectSocket(b.token);
    const presenceEvents: { userId: string; online: boolean }[] = [];
    bSocket.on('presence.changed', (payload: { userId: string; online: boolean }) => {
      presenceEvents.push(payload);
    });
    try {
      // A chặn B, rồi A nối socket: B không được nhận presence của A.
      const block = await http(app).post(`/api/v1/messages/contacts/${b.id}/block`)
        .set('Authorization', `Bearer ${a.token}`).send({});
      expect(block.status).toBe(201);
      presenceEvents.length = 0;
      const aSocket1 = await connectSocket(a.token);
      await sleep(1500);
      expect(presenceEvents.some((e) => e.userId === a.id)).toBe(false);
      aSocket1.disconnect();

      // Bỏ chặn: A nối lại thì presence của A tới B như thường.
      const unblock = await http(app).delete(`/api/v1/messages/contacts/${b.id}/block`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(unblock.status).toBe(200);
      presenceEvents.length = 0;
      const aSocket2 = await connectSocket(a.token);
      const deadline = Date.now() + 5000;
      while (!presenceEvents.some((e) => e.userId === a.id && e.online) && Date.now() < deadline) {
        await sleep(100);
      }
      expect(presenceEvents.some((e) => e.userId === a.id && e.online)).toBe(true);
      aSocket2.disconnect();
    } finally {
      bSocket.disconnect();
    }
  });
});
