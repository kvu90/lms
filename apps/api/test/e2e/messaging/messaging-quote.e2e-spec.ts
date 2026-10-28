import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from '../../support/engagement-helpers';

/**
 * Lát M3 — TRẢ LỜI TRÍCH DẪN (issue #229): người dùng trả lời MỘT tin
 * cụ thể trong cùng hội thoại; tin mới mang tham chiếu reply-to và
 * khối tóm tắt (quote) do server dựng theo quyền của người đọc.
 * Các ca kiểm chứng đúng luồng nghiệp vụ:
 *  - gửi kèm trích dẫn → response + đường đọc của cả hai phía mang
 *    quote đầy đủ (người gửi gốc, seq, excerpt rút gọn 120 ký tự);
 *  - gác service: trích dẫn tin của hội thoại KHÁC hoặc id không tồn
 *    tại → cùng một 400 `messaging.reply_target_not_found`, không
 *    tin nào được tạo (không lộ sự tồn tại của tin ở nơi khác);
 *  - trần ký tự của M2 tính trên nội dung tin MỚI, không tính trích
 *    dẫn;
 *  - tin gốc bị thu hồi / bị tác giả ẩn phía mình → quote chuyển
 *    `unavailable`, excerpt rỗng, nội dung gốc KHÔNG xuất hiện ở bất
 *    kỳ trường nào của payload người thường; tin gốc bị moderator
 *    xoá cứng → tham chiếu mất hẳn (replyTo null qua FK SET NULL);
 *  - realtime `message.new` mang đủ dữ kiện trích dẫn.
 * Trạng thái xoá mềm toàn cục (deletedAt) hiện không còn đường API
 * nào đặt (luật quote vẫn xử lý cho dữ liệu cũ + moderator) — hai
 * trạng thái "không còn hiển thị" kiểm chứng sống ở đây là thu hồi
 * và ẩn-phía-người-đọc.
 */

interface Person { id: string; username: string; token: string }

interface QuoteBody {
  id: string; seq: number; userIdFrom: string; excerpt: string; unavailable: boolean;
}

interface MessageBody {
  id: string; fullMessage: string; userIdFrom: string; seq: number;
  replyToMessageId: string | null; replyTo: QuoteBody | null;
}

let app: INestApplication;
let base: string;
let admin: string;
const sockets: Socket[] = [];

let counter = 0;
async function person(_prefix: string): Promise<Person> {
  counter += 1;
  const created = await createUserViaApi(app, admin);
  const session = await login(app, created.username, STRONG_PASSWORD);
  return { id: created.id, username: created.username, token: session.accessToken };
}

async function befriend(a: Person, b: Person): Promise<void> {
  const req = await http(app).post(`/api/v1/messages/contacts/${b.id}`)
    .set('Authorization', `Bearer ${a.token}`).send({});
  expect(req.status).toBe(201);
  const accept = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/accept`)
    .set('Authorization', `Bearer ${b.token}`).send({});
  expect(accept.status).toBe(201);
}

async function openConversation(a: Person, b: Person): Promise<string> {
  const res = await http(app).post('/api/v1/messages/conversations')
    .set('Authorization', `Bearer ${a.token}`).send({ type: 1, memberIds: [b.id] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function send(token: string, conversationId: string, text: string, replyToMessageId?: string) {
  return http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`)
    .send(replyToMessageId ? { text, replyToMessageId } : { text });
}

async function listMessages(token: string, conversationId: string): Promise<MessageBody[]> {
  const res = await http(app).get(`/api/v1/messages/conversations/${conversationId}/messages`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.messages as MessageBody[];
}

/**
 * Ghi thẳng một dòng gán vai vào DB cho fixture. Các fixture của bộ
 * spec nhắn tin dựng persona giáo viên vừa ghi danh trong khoá vừa
 * giữ vai giảng dạy tại context khoá (giáo viên hiện diện trong khoá
 * như một thành viên và giữ vai trò kiểm duyệt). Từ issue #425,
 * trạng thái lẫn vai cùng khoá này không còn tạo được qua API — cả
 * hai chiều ghi danh/gán vai đều bị chốt tách vai chặn — và chỉ còn
 * tồn tại như dữ kiện có sẵn; các ca của bộ spec này kiểm hành vi
 * nhắn tin trên đúng dữ kiện đó, nên dòng gán vai được ghi thẳng
 * vào DB trong lúc phần ghi danh vẫn đi qua API như cũ.
 */
async function insertAssignmentRow(roleId: string, userId: string, contextId: string): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `insert into role_assignments (role_id, user_id, context_id, component) values ($1, $2, $3, '')`,
      [roleId, userId, contextId],
    );
  } finally {
    await client.end();
  }
}

describe('Messaging M3 — trả lời trích dẫn (issue #229)', () => {
  let a: Person; let b: Person; let convId: string;
  let teacher: Person; let s1: Person; let s2: Person; let groupConvId: string;

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    admin = await adminToken(app);

    a = await person('a');
    b = await person('b');
    await befriend(a, b);
    convId = await openConversation(a, b);

    // Bối cảnh nhóm khoá cho ca moderator xoá cứng (khuôn lifecycle).
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    teacher = await person('gv');
    s1 = await person('s1');
    s2 = await person('s2');
    for (const p of [teacher, s1, s2]) await enrolUser(app, admin, course.id, instance.id, p.id);
    const courseCtx = await contextIdByLevelInstance(app, admin, 50, course.id);
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    // Persona giáo viên ở đây vừa ghi danh vừa giữ vai giảng dạy tại
    // chính khoá: dòng gán vai ghi thẳng vào DB (xem insertAssignmentRow).
    await insertAssignmentRow(editingTeacher, teacher.id, courseCtx);
    const group = await createGroupViaApi(app, admin, course.id, 'Lớp trích dẫn M3');
    for (const p of [teacher, s1, s2]) await addGroupMember(app, admin, course.id, group.id, p.id);
    const created = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${s1.token}`).send({ groupId: group.id });
    expect(created.status).toBe(201);
    groupConvId = created.body.id as string;
  }, 180000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    // Dọn site-config trần ký tự nếu ca trần chết giữa chừng.
    await http(app).delete('/api/v1/site-config/core/messagingmaxmessagelength')
      .set('Authorization', `Bearer ${admin}`).catch(() => undefined);
    await app.close();
  });

  it('1. gửi kèm trích dẫn: response và đường đọc của cả hai phía mang quote đầy đủ', async () => {
    const original = await send(a.token, convId, 'Nội dung gốc để trích dẫn');
    expect(original.status).toBe(201);
    const originalId = original.body.id as string;

    const reply = await send(b.token, convId, 'Tôi trả lời tin này', originalId);
    expect(reply.status).toBe(201);
    expect(reply.body.replyToMessageId).toBe(originalId);
    expect(reply.body.replyTo).toMatchObject({
      id: originalId,
      seq: original.body.seq,
      userIdFrom: a.id,
      excerpt: 'Nội dung gốc để trích dẫn',
      unavailable: false,
    });

    for (const viewer of [a, b]) {
      const messages = await listMessages(viewer.token, convId);
      const seen = messages.find((m) => m.id === (reply.body.id as string));
      expect(seen?.replyToMessageId).toBe(originalId);
      expect(seen?.replyTo?.excerpt).toBe('Nội dung gốc để trích dẫn');
      expect(seen?.replyTo?.unavailable).toBe(false);
    }

    // Chi tiết hội thoại (đường trang web tải khi mở) cũng mang quote.
    const detail = await http(app).get(`/api/v1/messages/conversations/${convId}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(detail.status).toBe(200);
    const inDetail = (detail.body.messages as MessageBody[]).find((m) => m.id === (reply.body.id as string));
    expect(inDetail?.replyTo?.userIdFrom).toBe(a.id);
  });

  it('2. excerpt rút gọn ở 120 ký tự (kèm …), nội dung gốc đầy đủ vẫn ở tin gốc', async () => {
    const longText = 'x'.repeat(200);
    const original = await send(a.token, convId, longText);
    expect(original.status).toBe(201);
    const reply = await send(b.token, convId, 'trích dẫn tin dài', original.body.id as string);
    expect(reply.status).toBe(201);
    const excerpt = (reply.body.replyTo as QuoteBody).excerpt;
    expect(excerpt).toHaveLength(121);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.startsWith('x'.repeat(120))).toBe(true);
  });

  it('3. gác: trích dẫn tin của hội thoại khác / id không tồn tại → cùng một 400, không tin nào được tạo', async () => {
    const c = await person('c');
    await befriend(a, c);
    const otherConvId = await openConversation(a, c);
    const foreign = await send(a.token, otherConvId, 'tin của hội thoại khác');
    expect(foreign.status).toBe(201);
    const foreignId = foreign.body.id as string;

    const before = await listMessages(b.token, convId);

    const cross = await send(b.token, convId, 'trích dẫn chéo hội thoại', foreignId);
    expect(cross.status).toBe(400);
    expect(cross.body.code).toBe('messaging.reply_target_not_found');

    const missing = await send(b.token, convId, 'trích dẫn id không tồn tại', '0192c3b4-1111-7000-8000-000000000000');
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('messaging.reply_target_not_found');

    const after = await listMessages(b.token, convId);
    expect(after).toHaveLength(before.length);
  });

  it('4. trần ký tự của M2 tính trên nội dung tin mới — trích dẫn không tính vào trần', async () => {
    const put = await http(app).put('/api/v1/site-config/core/messagingmaxmessagelength')
      .set('Authorization', `Bearer ${admin}`).send({ value: 10 });
    expect(put.status).toBe(200);
    try {
      const original = (await listMessages(a.token, convId)).find((m) => m.fullMessage.length > 10);
      expect(original).toBeDefined();
      const ok = await send(b.token, convId, '0123456789', original!.id);
      expect(ok.status).toBe(201);
      expect(ok.body.replyTo?.excerpt.length).toBeGreaterThan(10);

      const tooLong = await send(b.token, convId, '0123456789x', original!.id);
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.code).toBe('messaging.message_too_long');
    } finally {
      const del = await http(app).delete('/api/v1/site-config/core/messagingmaxmessagelength')
        .set('Authorization', `Bearer ${admin}`);
      expect(del.status).toBe(200);
    }
  });

  it('5. tin gốc bị thu hồi → quote unavailable, excerpt rỗng, nội dung gốc không lộ ở payload người nhận', async () => {
    const secret = 'bí mật sẽ bị thu hồi m3';
    const original = await send(a.token, convId, secret);
    expect(original.status).toBe(201);
    const reply = await send(b.token, convId, 'trả lời trước khi thu hồi', original.body.id as string);
    expect(reply.status).toBe(201);
    expect(reply.body.replyTo.excerpt).toBe(secret);

    const recall = await http(app).post(`/api/v1/messages/${original.body.id as string}/recall`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(recall.status).toBe(201);

    const messages = await listMessages(b.token, convId);
    const seen = messages.find((m) => m.id === (reply.body.id as string));
    expect(seen?.replyTo?.unavailable).toBe(true);
    expect(seen?.replyTo?.excerpt).toBe('');
    expect(JSON.stringify(messages)).not.toContain(secret);
  });

  it('6. tác giả ẩn tin gốc phía mình → chính tác giả thấy quote unavailable, phía kia vẫn thấy excerpt', async () => {
    const text = 'tin gốc A sẽ tự ẩn phía mình';
    const original = await send(a.token, convId, text);
    expect(original.status).toBe(201);
    const reply = await send(b.token, convId, 'trả lời tin sắp ẩn', original.body.id as string);
    expect(reply.status).toBe(201);

    const hide = await http(app).delete(`/api/v1/messages/${original.body.id as string}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(hide.status).toBe(200);

    const forA = await listMessages(a.token, convId);
    expect(forA.some((m) => m.id === (original.body.id as string))).toBe(false);
    const seenByA = forA.find((m) => m.id === (reply.body.id as string));
    expect(seenByA?.replyTo?.unavailable).toBe(true);
    expect(seenByA?.replyTo?.excerpt).toBe('');

    const forB = await listMessages(b.token, convId);
    const seenByB = forB.find((m) => m.id === (reply.body.id as string));
    expect(seenByB?.replyTo?.unavailable).toBe(false);
    expect(seenByB?.replyTo?.excerpt).toBe(text);
  });

  it('7. tin gốc bị moderator xoá cứng → tham chiếu mất hẳn (replyTo null), tin trả lời còn nguyên', async () => {
    const original = await send(s1.token, groupConvId, 'tin gốc trong nhóm lớp');
    expect(original.status).toBe(201);
    const reply = await send(s2.token, groupConvId, 'trả lời trong nhóm', original.body.id as string);
    expect(reply.status).toBe(201);
    expect(reply.body.replyTo?.excerpt).toBe('tin gốc trong nhóm lớp');

    const hard = await http(app).post(`/api/v1/messages/${original.body.id as string}/hard-delete`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ reason: 'kiểm chứng lát trích dẫn M3' });
    expect(hard.status).toBe(201);

    const messages = await listMessages(s2.token, groupConvId);
    expect(messages.some((m) => m.id === (original.body.id as string))).toBe(false);
    const seen = messages.find((m) => m.id === (reply.body.id as string));
    expect(seen).toBeDefined();
    expect(seen?.replyToMessageId).toBeNull();
    expect(seen?.replyTo).toBeNull();
  });

  it('8. realtime: message.new mang đủ dữ kiện trích dẫn cho phía nhận', async () => {
    const socket: Socket = io(`${base}/messaging`, {
      auth: { token: b.token }, transports: ['websocket'], reconnection: false,
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', (err) => reject(err));
    });

    const original = await send(b.token, convId, 'tin gốc cho realtime');
    expect(original.status).toBe(201);

    const eventPromise = new Promise<{ message: MessageBody }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('không nhận được message.new trong 10s')), 10000);
      socket.on('message.new', (payload: { message: MessageBody }) => {
        if (payload.message.replyToMessageId === (original.body.id as string)) {
          clearTimeout(timer);
          resolve(payload);
        }
      });
    });
    const reply = await send(a.token, convId, 'trả lời qua realtime', original.body.id as string);
    expect(reply.status).toBe(201);

    const payload = await eventPromise;
    expect(payload.message.id).toBe(reply.body.id as string);
    expect(payload.message.replyTo).toMatchObject({
      id: original.body.id as string,
      userIdFrom: b.id,
      excerpt: 'tin gốc cho realtime',
      unavailable: false,
    });
    socket.disconnect();
  });
});
