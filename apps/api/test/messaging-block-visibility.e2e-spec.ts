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
 *  - Mở thẳng theo id (việc nối tiếp của #33, siết sau PR #89): chi
 *    tiết, cửa sổ lịch sử tin và đánh dấu đã đọc của conversation
 *    1–1 đang chặn đều 404 như không tồn tại ở CẢ HAI phía; `sync`
 *    realtime cũng không trả lịch sử của conversation đang chặn.
 *    Hội thoại nhóm chứa cả hai người không bị cổng này chạm.
 *  - Xoá tin theo id (siết sau PR #94 vòng 1): xoá tin của hội thoại
 *    1–1 đang chặn cũng 404 ở cả hai phía, không ghi outbox, phía
 *    còn lại không nhận bất kỳ sự kiện nào của hội thoại đó; socket
 *    mới nối không vào room của hội thoại 1–1 đang chặn.
 *  - Presence (online) không phát tới phía bị chặn.
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

    // Mở thẳng theo id khi đang chặn: 404 như không tồn tại ở CẢ
    // HAI phía — chi tiết, cửa sổ lịch sử tin, đánh dấu đã đọc
    // (luật siết của việc nối tiếp #33; trước đây lịch sử vẫn đọc
    // được, chỉ ẩn mốc đã đọc của phía bên kia).
    for (const token of [a.token, b.token]) {
      const detail = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(detail.status).toBe(404);
      expect(detail.body.code).toBe('messaging.conversation_not_found');
      const windowRes = await http(app).get(`/api/v1/messages/conversations/${conversationId}/messages`)
        .set('Authorization', `Bearer ${token}`);
      expect(windowRes.status).toBe(404);
      const read = await http(app).post(`/api/v1/messages/conversations/${conversationId}/read`)
        .set('Authorization', `Bearer ${token}`).send({});
      expect(read.status).toBe(404);
    }

    // Bỏ chặn: mọi bề mặt hiện lại nguyên trạng, gửi lại được.
    const unblock = await http(app).delete(`/api/v1/messages/contacts/${b.id}/block`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(unblock.status).toBe(200);
    expect(await conversationIds(a.token)).toContain(conversationId);
    expect(await conversationIds(b.token)).toContain(conversationId);
    expect(await contactIds(a.token)).toContain(b.id);
    expect(await contactIds(b.token)).toContain(a.id);
    // Mở theo id trở lại, lịch sử còn nguyên (không xoá dữ liệu) và
    // mốc đã đọc của A lại thấy như trước khi chặn.
    const detailAfter = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(detailAfter.status).toBe(200);
    expect((detailAfter.body as { messages: { fullMessage: string }[] }).messages
      .some((m) => m.fullMessage === 'tin trước khi chặn')).toBe(true);
    expect((detailAfter.body as { memberReadMarkers: { userId: string }[] }).memberReadMarkers
      .some((m) => m.userId === a.id)).toBe(true);
    expect((await send(b.token, 'gửi lại sau bỏ chặn')).status).toBe(201);
  });

  it('direct-read gate leaves a shared group untouched and realtime sync withholds the blocked 1-1 history', async () => {
    // Phần nhóm dùng một cặp RIÊNG (C, D): nhóm chung của cặp A/B
    // sẽ thành đường presence hợp lệ giữa hai người (nhóm không bị
    // luật chặn chạm) và làm đổi giả định của test presence phía
    // dưới — test nào giữ trạng thái của cặp đó thì tự dọn.
    const c = await person('Chi', 'GroupPeer');
    const d = await person('Dung', 'GroupPeer');
    // Nhóm chung (type 2) chứa cả C và D — admin tạo hộ vì cổng
    // lập nhóm tự do chỉ cho staff/admin; C gửi một tin làm mốc.
    const admin = await adminToken(app);
    const group = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${admin}`).send({ type: 2, memberIds: [c.id, d.id], name: 'Nhóm chung C-D' });
    expect(group.status).toBe(201);
    const groupId = (group.body as { id: string }).id;
    const groupMsg = await http(app).post(`/api/v1/messages/conversations/${groupId}/messages`)
      .set('Authorization', `Bearer ${c.token}`).send({ text: 'tin trong nhóm chung' });
    expect(groupMsg.status).toBe(201);

    // C chặn D: nhóm chung vẫn đọc được ở cả hai phía (chi tiết +
    // cửa sổ lịch sử) và sync realtime vẫn trả tin của nhóm.
    const blockCD = await http(app).post(`/api/v1/messages/contacts/${d.id}/block`)
      .set('Authorization', `Bearer ${c.token}`).send({});
    expect(blockCD.status).toBe(201);
    try {
      for (const token of [c.token, d.token]) {
        const detail = await http(app).get(`/api/v1/messages/conversations/${groupId}`)
          .set('Authorization', `Bearer ${token}`);
        expect(detail.status).toBe(200);
        const windowRes = await http(app).get(`/api/v1/messages/conversations/${groupId}/messages`)
          .set('Authorization', `Bearer ${token}`);
        expect(windowRes.status).toBe(200);
      }
      const dSocket = await connectSocket(d.token);
      try {
        const syncGroup = await dSocket.emitWithAck('sync', { [groupId]: 0 }) as Record<string, { fullMessage: string }[]>;
        expect(syncGroup[groupId]?.some((m) => m.fullMessage === 'tin trong nhóm chung')).toBe(true);
      } finally {
        dSocket.disconnect();
      }
    } finally {
      const unblockCD = await http(app).delete(`/api/v1/messages/contacts/${d.id}/block`)
        .set('Authorization', `Bearer ${c.token}`);
      expect(unblockCD.status).toBe(200);
    }

    // Sync realtime của hội thoại 1–1 (cặp A/B): khi A chặn B,
    // lịch sử KHÔNG trả cho phía bị chặn; bỏ chặn thì trả lại.
    const block = await http(app).post(`/api/v1/messages/contacts/${b.id}/block`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(block.status).toBe(201);
    try {
      const bSocket = await connectSocket(b.token);
      try {
        const syncBlocked = await bSocket.emitWithAck('sync', { [conversationId]: 0 }) as Record<string, unknown[]>;
        expect(syncBlocked[conversationId]).toBeUndefined();
      } finally {
        bSocket.disconnect();
      }
    } finally {
      const unblock = await http(app).delete(`/api/v1/messages/contacts/${b.id}/block`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(unblock.status).toBe(200);
    }
    const bSocket2 = await connectSocket(b.token);
    try {
      const syncAfter = await bSocket2.emitWithAck('sync', { [conversationId]: 0 }) as Record<string, { fullMessage: string }[]>;
      expect(syncAfter[conversationId]?.some((m) => m.fullMessage === 'tin trước khi chặn')).toBe(true);
    } finally {
      bSocket2.disconnect();
    }
  });

  it('deleting a message of a blocked 1-1 conversation returns 404 and emits nothing to the other side', async () => {
    // Tin mới của A làm mốc xoá — lấy id từ chính phản hồi tạo tin.
    const createdMsg = await send(a.token, 'tin sẽ xoá khi đang chặn');
    expect(createdMsg.status).toBe(201);
    const messageId = (createdMsg.body as { id: string }).id;
    // B nối socket TRƯỚC khi chặn (đúng ca tái hiện của đội đánh giá:
    // socket cũ đã nằm trong room) và nghe cả hai sự kiện mà một lần
    // xoá từng phát ra: message.deleted + conversation.updated.
    const bSocket = await connectSocket(b.token);
    const seen: { event: string; conversationId: string }[] = [];
    const record = (event: string) => (payload: { conversationId: string }) => {
      seen.push({ event, conversationId: payload.conversationId });
    };
    bSocket.on('message.deleted', record('message.deleted'));
    bSocket.on('conversation.updated', record('conversation.updated'));
    try {
      const block = await http(app).post(`/api/v1/messages/contacts/${b.id}/block`)
        .set('Authorization', `Bearer ${a.token}`).send({});
      expect(block.status).toBe(201);
      try {
        // A xoá tin của chính A trong lúc chặn: 404 như không tồn
        // tại (không phải 200, không phải 403), ở cả phía người chặn.
        const del = await http(app).delete(`/api/v1/messages/messages/${messageId}`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(del.status).toBe(404);
        expect(del.body.code).toBe('messaging.conversation_not_found');
        // Phía bị chặn cũng 404 (không lộ tin tồn tại qua 403).
        const delByBlocked = await http(app).delete(`/api/v1/messages/messages/${messageId}`)
          .set('Authorization', `Bearer ${b.token}`);
        expect(delByBlocked.status).toBe(404);
        expect(delByBlocked.body.code).toBe('messaging.conversation_not_found');
        // Chờ quá chu kỳ tiêu thụ outbox: B không nhận bất kỳ sự
        // kiện nào của hội thoại này (kể cả conversation.updated
        // kèm nội dung tin cuối — điểm lộ của vòng 1).
        await sleep(1500);
        expect(seen.filter((e) => e.conversationId === conversationId)).toEqual([]);
      } finally {
        const unblock = await http(app).delete(`/api/v1/messages/contacts/${b.id}/block`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(unblock.status).toBe(200);
      }
      // Sau bỏ chặn, tin vẫn còn nguyên (lần xoá 404 không xoá mềm
      // gì, không ghi outbox) và A xoá được bình thường.
      const detailAfter = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(detailAfter.status).toBe(200);
      expect((detailAfter.body as { messages: { id: string }[] }).messages
        .some((m) => m.id === messageId)).toBe(true);
      const delAfter = await http(app).delete(`/api/v1/messages/messages/${messageId}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(delAfter.status).toBe(200);
    } finally {
      bSocket.disconnect();
    }
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
