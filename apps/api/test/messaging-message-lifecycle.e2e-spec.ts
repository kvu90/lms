import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from './engagement-helpers';

/**
 * Vòng đời tin nhắn THEO VAI (issue #33, bổ sung cho PR #94) — ba lớp
 * thao tác tách bạch:
 *   (a) tác giả XOÁ-PHÍA-MÌNH mọi lúc (cờ cá nhân, phía kia không đổi);
 *   (b) tác giả THU HỒI cho mọi người chỉ trong cửa sổ site-config
 *       `core/messagingrecallwindowminutes` (mặc định 15 phút) — nội
 *       dung bị vô hiệu với thành viên thường, moderator_action
 *       'recall' được ghi, đường truy vết còn thấy nội dung gốc;
 *   (c) moderator có capability `moderation:manage` XOÁ CỨNG / GỠ
 *       HÀNG LOẠT không giới hạn thời gian, lý do bắt buộc, mọi lần
 *       ghi moderator_action — dòng tin biến mất khỏi mọi đường đọc.
 * Kèm: sự kiện realtime của thu hồi BẮT BUỘC vô hiệu cache danh sách
 * (`conversation.invalidate`) ở phía kia, còn xoá-phía-mình không
 * phát bất kỳ tín hiệu nào sang phía kia; cổng chặn 1–1 vẫn nuốt cả
 * thu hồi lẫn xoá-phía-mình như mọi đường theo id khác.
 */

interface Person { id: string; username: string; token: string }

interface MessageBody {
  id: string; fullMessage: string; userIdFrom: string; seq: number;
  deletedAt: string | null; recalledAt: string | null; recalledBy: string | null;
}

interface ModeratorActionRow {
  action: string; actor_id: string; author_id: string; reason: string | null; message_seq: number | null;
}

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

/** Chờ một điều kiện đúng (poll ngắn) — dùng cho khẳng định realtime bất đồng bộ qua outbox. */
async function waitUntil(check: () => boolean, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }
  throw new Error(`điều kiện realtime không đạt trong ${timeoutMs}ms`);
}

describe('Messaging — vòng đời tin nhắn theo vai (issue #33, bổ sung PR #94)', () => {
  let app: INestApplication;
  let base: string;
  let pg: Client;
  let admin: string;
  let teacher: Person;
  let otherTeacher: Person;
  let s1: Person;
  let s2: Person;
  let courseId: string;
  let groupConvId: string;
  const sockets: Socket[] = [];

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function send(token: string, conversationId: string, text: string) {
    return http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`).send({ text });
  }

  async function viewMessages(token: string, conversationId: string) {
    const res = await http(app).get(`/api/v1/messages/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { messages: MessageBody[]; canModerate: boolean };
  }

  async function listEntry(token: string, conversationId: string) {
    const res = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const entry = (res.body as { id: string; unread: number; lastMessage: MessageBody | null }[])
      .find((c) => c.id === conversationId);
    expect(entry).toBeDefined();
    return entry!;
  }

  async function actionsFor(messageId: string): Promise<ModeratorActionRow[]> {
    const res = await pg.query<ModeratorActionRow>(
      'select action, actor_id, author_id, reason, message_seq from message_moderator_actions where message_id = $1 order by created_at asc',
      [messageId],
    );
    return res.rows;
  }

  beforeAll(async () => {
    app = await createTestApp();
    const server = app.getHttpServer();
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = await adminToken(app);

    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    courseId = course.id;
    const instance = await createEnrolInstance(app, admin, course.id);
    teacher = await person();
    s1 = await person();
    s2 = await person();
    for (const p of [teacher, s1, s2]) await enrolUser(app, admin, course.id, instance.id, p.id);
    const courseCtx = await contextIdByLevelInstance(app, admin, 50, course.id);
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    // Persona giáo viên ở đây vừa ghi danh trong khoá vừa giữ vai
    // giảng dạy tại context khoá (giáo viên hiện diện trong khoá như
    // một thành viên và giữ vai trò kiểm duyệt). Từ issue #425,
    // trạng thái lẫn vai cùng khoá này không còn tạo được qua API —
    // cả hai chiều ghi danh/gán vai đều bị chốt tách vai chặn — và
    // chỉ còn tồn tại như dữ kiện có sẵn; các ca của spec này kiểm
    // hành vi nhắn tin trên đúng dữ kiện đó, nên dòng gán vai được
    // ghi thẳng vào DB trong lúc phần ghi danh vẫn đi qua API.
    await pg.query(
      `insert into role_assignments (role_id, user_id, context_id, component) values ($1, $2, $3, '')`,
      [editingTeacher, teacher.id, courseCtx],
    );

    // Giáo viên khoá khác: có vai staff nhưng NGOÀI phạm vi khoá chính.
    const category2 = await createCategory(app, admin);
    const course2 = await createCourse(app, admin, category2.id);
    otherTeacher = await person();
    const course2Ctx = await contextIdByLevelInstance(app, admin, 50, course2.id);
    await assignRole(app, admin, otherTeacher.id, editingTeacher, course2Ctx);

    const group = await createGroupViaApi(app, admin, course.id, 'Lớp vòng đời');
    for (const p of [teacher, s1, s2]) await addGroupMember(app, admin, course.id, group.id, p.id);
    const created = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${s1.token}`).send({ groupId: group.id });
    expect(created.status).toBe(201);
    groupConvId = created.body.id as string;
    // Timeout tường minh cho hook: dựng app + seed + hai khoá trên
    // máy tải nặng vượt trần hook mặc định 30s của vitest config.
  }, 180000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await pg.end();
    await app.close();
  });

  it('1. thu hồi TRONG cửa sổ: nội dung bị vô hiệu với phía kia, truy vết còn nguyên, moderator_action recall được ghi', async () => {
    // s2 đọc hết quá khứ để mốc chưa đọc dưới đây chỉ phản ánh tin mới.
    const marked = await http(app).post(`/api/v1/messages/conversations/${groupConvId}/read`)
      .set('Authorization', `Bearer ${s2.token}`).send({});
    expect(marked.status).toBe(201);
    const sent = await send(s1.token, groupConvId, 'tin sẽ thu hồi trong cửa sổ');
    expect(sent.status).toBe(201);
    const msgId = sent.body.id as string;
    expect((await listEntry(s2.token, groupConvId)).unread).toBe(1);

    // Người không phải tác giả không thu hồi được.
    const foreign = await http(app).post(`/api/v1/messages/${msgId}/recall`)
      .set('Authorization', `Bearer ${s2.token}`).send({});
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('messaging.message_recall_forbidden');

    // Tác giả thu hồi: 200 kèm dấu thu hồi trên chính dòng trả về.
    const recalled = await http(app).post(`/api/v1/messages/${msgId}/recall`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(recalled.status).toBe(201);
    expect(recalled.body.recalledAt).toBeTruthy();
    expect(recalled.body.recalledBy).toBe(s1.id);
    expect(recalled.body.fullMessage).toBe('tin sẽ thu hồi trong cửa sổ');

    // Phía kia (thành viên thường): tin VẪN CÒN trong khung nhưng nội
    // dung đã bị vô hiệu — chỉ còn dấu vết thu hồi để hiện dòng
    // "tin nhắn đã được thu hồi"; số chưa đọc rơi về 0 và xem trước
    // trong danh sách cũng là bản đã vô hiệu nội dung.
    const s2View = await viewMessages(s2.token, groupConvId);
    const forS2 = s2View.messages.find((m) => m.id === msgId);
    expect(forS2).toBeDefined();
    expect(forS2!.fullMessage).toBe('');
    expect(forS2!.recalledAt).toBeTruthy();
    expect(forS2!.recalledBy).toBe(s1.id);
    const s2Entry = await listEntry(s2.token, groupConvId);
    expect(s2Entry.unread).toBe(0);
    expect(s2Entry.lastMessage?.id).toBe(msgId);
    expect(s2Entry.lastMessage?.fullMessage).toBe('');

    // Đường truy vết (giáo viên phụ trách): nội dung gốc còn nguyên
    // kèm dấu thu hồi — thu hồi không phải là xoá dấu vết.
    const teacherView = await viewMessages(teacher.token, groupConvId);
    expect(teacherView.canModerate).toBe(true);
    const traced = teacherView.messages.find((m) => m.id === msgId);
    expect(traced?.fullMessage).toBe('tin sẽ thu hồi trong cửa sổ');
    expect(traced?.recalledBy).toBe(s1.id);

    // Dấu vết hành động: đúng một dòng 'recall', người thực hiện là
    // tác giả, lý do trống (recall không có lý do).
    const actions = await actionsFor(msgId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe('recall');
    expect(actions[0]!.actor_id).toBe(s1.id);
    expect(actions[0]!.author_id).toBe(s1.id);
    expect(actions[0]!.reason).toBeNull();

    // Thu hồi lại: idempotent — dấu đầu giữ nguyên, không thêm dòng.
    const again = await http(app).post(`/api/v1/messages/${msgId}/recall`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(again.status).toBe(201);
    expect(again.body.recalledAt).toBe(recalled.body.recalledAt);
    expect(await actionsFor(msgId)).toHaveLength(1);
  });

  it('2. thu hồi NGOÀI cửa sổ bị từ chối — người thường chỉ còn xoá-phía-mình', async () => {
    const sent = await send(s1.token, groupConvId, 'tin cũ ngoài cửa sổ thu hồi');
    expect(sent.status).toBe(201);
    const msgId = sent.body.id as string;
    // Đẩy mốc gửi về quá khứ 16 phút (cửa sổ mặc định 15) bằng SQL
    // trực tiếp — đúng trạng thái của một tin đã gửi từ lâu.
    await pg.query("update message set created_at = now() - interval '16 minutes' where id = $1", [msgId]);

    const recall = await http(app).post(`/api/v1/messages/${msgId}/recall`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(recall.status).toBe(403);
    expect(recall.body.code).toBe('messaging.recall_window_expired');
    // Không dấu thu hồi, không dòng hành động nào được ghi.
    expect(await actionsFor(msgId)).toHaveLength(0);

    // Lớp (a) vẫn mở mọi lúc: xoá-phía-mình thành công…
    const del = await http(app).delete(`/api/v1/messages/${msgId}`)
      .set('Authorization', `Bearer ${s1.token}`);
    expect(del.status).toBe(200);
    const s1View = await viewMessages(s1.token, groupConvId);
    expect(s1View.messages.map((m) => m.id)).not.toContain(msgId);
    // …và phía kia vẫn thấy nguyên nội dung (đó là bản chất của lớp (a)).
    const s2View = await viewMessages(s2.token, groupConvId);
    const forS2 = s2View.messages.find((m) => m.id === msgId);
    expect(forS2?.fullMessage).toBe('tin cũ ngoài cửa sổ thu hồi');
    expect(forS2?.recalledAt).toBeNull();
  });

  it('3. cửa sổ đặt 0 qua site-config thì thu hồi bị tắt hẳn, kể cả tin vừa gửi', async () => {
    const put = await http(app).put('/api/v1/site-config/core/messagingrecallwindowminutes')
      .set('Authorization', `Bearer ${admin}`).send({ value: 0 });
    expect(put.status).toBe(200);
    try {
      const sent = await send(s1.token, groupConvId, 'tin gửi lúc cửa sổ đang tắt');
      expect(sent.status).toBe(201);
      const recall = await http(app).post(`/api/v1/messages/${sent.body.id}/recall`)
        .set('Authorization', `Bearer ${s1.token}`).send({});
      expect(recall.status).toBe(403);
      expect(recall.body.code).toBe('messaging.recall_window_expired');
    } finally {
      const restore = await http(app).put('/api/v1/site-config/core/messagingrecallwindowminutes')
        .set('Authorization', `Bearer ${admin}`).send({ value: 15 });
      expect(restore.status).toBe(200);
    }
  });

  it('4. xoá cứng: chỉ moderation:manage trong phạm vi, lý do bắt buộc, dòng tin biến mất và dấu vết còn lại', async () => {
    const sent = await send(s1.token, groupConvId, 'tin vi phạm sẽ bị xoá cứng');
    expect(sent.status).toBe(201);
    const msgId = sent.body.id as string;

    // Học sinh (kể cả tác giả) không có đường xoá cứng.
    const byStudent = await http(app).post(`/api/v1/messages/${msgId}/hard-delete`)
      .set('Authorization', `Bearer ${s1.token}`).send({ reason: 'em tự xoá' });
    expect(byStudent.status).toBe(403);
    expect(byStudent.body.code).toBe('messaging.message_moderation_forbidden');
    // Giáo viên khoá KHÁC: có vai staff nhưng ngoài phạm vi conversation.
    const byOther = await http(app).post(`/api/v1/messages/${msgId}/hard-delete`)
      .set('Authorization', `Bearer ${otherTeacher.token}`).send({ reason: 'ngoài phạm vi' });
    expect(byOther.status).toBe(403);
    expect(byOther.body.code).toBe('messaging.message_moderation_forbidden');
    // Thiếu lý do → 400 trước cả khi xét thẩm quyền nghiệp vụ.
    const noReason = await http(app).post(`/api/v1/messages/${msgId}/hard-delete`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ reason: '   ' });
    expect(noReason.status).toBe(400);

    // Giáo viên phụ trách xoá cứng có lý do — KHÔNG giới hạn thời
    // gian: đẩy tin về quá khứ xa vẫn xoá được.
    await pg.query("update message set created_at = now() - interval '30 days' where id = $1", [msgId]);
    const hard = await http(app).post(`/api/v1/messages/${msgId}/hard-delete`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ reason: 'Vi phạm nội quy lớp học' });
    expect(hard.status).toBe(201);
    expect(hard.body.deleted).toBe(true);

    // Dòng tin biến mất khỏi DB và khỏi mọi đường đọc (kể cả truy vết).
    const count = await pg.query<{ n: string }>('select count(*) as n from message where id = $1', [msgId]);
    expect(Number(count.rows[0]!.n)).toBe(0);
    const teacherView = await viewMessages(teacher.token, groupConvId);
    expect(teacherView.messages.map((m) => m.id)).not.toContain(msgId);
    // Căn cứ duy nhất còn lại: dòng moderator_action kèm lý do và
    // bản chụp tác giả/seq của tin đã mất.
    const actions = await actionsFor(msgId);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe('hard_delete');
    expect(actions[0]!.actor_id).toBe(teacher.id);
    expect(actions[0]!.author_id).toBe(s1.id);
    expect(actions[0]!.reason).toBe('Vi phạm nội quy lớp học');
    expect(actions[0]!.message_seq).toBe(sent.body.seq);
  });

  it('5. gỡ hàng loạt: kiểm tra toàn bộ trước — một tin lạ là cả yêu cầu bị từ chối, không gỡ một phần', async () => {
    const b1 = await send(s1.token, groupConvId, 'tin gỡ loạt 1');
    const b2 = await send(s2.token, groupConvId, 'tin gỡ loạt 2');
    expect(b1.status).toBe(201);
    expect(b2.status).toBe(201);
    const ids = [b1.body.id as string, b2.body.id as string];

    // Học sinh gọi gỡ loạt → 403.
    const byStudent = await http(app).post('/api/v1/messages/bulk-remove')
      .set('Authorization', `Bearer ${s1.token}`).send({ messageIds: ids, reason: 'tự gỡ' });
    expect(byStudent.status).toBe(403);
    // Danh sách lẫn một id không tồn tại → 404 và KHÔNG tin nào bị gỡ.
    const mixed = await http(app).post('/api/v1/messages/bulk-remove')
      .set('Authorization', `Bearer ${teacher.token}`)
      .send({ messageIds: [...ids, '123e4567-e89b-72d3-a456-426614174000'], reason: 'dọn loạt' });
    expect(mixed.status).toBe(404);
    const stillThere = await pg.query<{ n: string }>('select count(*) as n from message where id = any($1)', [ids]);
    expect(Number(stillThere.rows[0]!.n)).toBe(2);

    // Gỡ loạt hợp lệ: cả hai biến mất, mỗi tin một dòng bulk_hard_delete.
    const bulk = await http(app).post('/api/v1/messages/bulk-remove')
      .set('Authorization', `Bearer ${teacher.token}`).send({ messageIds: ids, reason: 'Dọn nội dung vi phạm hàng loạt' });
    expect(bulk.status).toBe(201);
    expect(bulk.body.removed).toBe(2);
    const gone = await pg.query<{ n: string }>('select count(*) as n from message where id = any($1)', [ids]);
    expect(Number(gone.rows[0]!.n)).toBe(0);
    for (const id of ids) {
      const actions = await actionsFor(id);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.action).toBe('bulk_hard_delete');
      expect(actions[0]!.reason).toBe('Dọn nội dung vi phạm hàng loạt');
    }
    const s1View = await viewMessages(s1.token, groupConvId);
    expect(s1View.messages.map((m) => m.id)).not.toContain(ids[0]);
    expect(s1View.messages.map((m) => m.id)).not.toContain(ids[1]);
  });

  it('6. realtime: thu hồi phát message.deleted + conversation.invalidate cho phía kia; xoá-phía-mình không phát gì sang phía kia', async () => {
    // Conversation nhóm riêng cho ca realtime để bộ thu sự kiện sạch.
    const group2 = await createGroupViaApi(app, admin, courseId, 'Lớp realtime vòng đời');
    for (const p of [teacher, s1, s2]) await addGroupMember(app, admin, courseId, group2.id, p.id);
    const created = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${teacher.token}`).send({ groupId: group2.id });
    expect(created.status).toBe(201);
    const convId = created.body.id as string;

    // s2 nối socket SAU khi đã là thành viên: gateway cho vào room
    // của conversation ngay lúc bắt tay.
    const socketB = await connectSocket(base, s2.token);
    sockets.push(socketB);
    const newEvents: { message: { id: string } }[] = [];
    const deletedEvents: { messageId: string; conversationId: string }[] = [];
    const invalidateEvents: { conversationId: string }[] = [];
    socketB.on('message.new', (payload: { message: { id: string } }) => { newEvents.push(payload); });
    socketB.on('message.deleted', (payload: { messageId: string; conversationId: string }) => { deletedEvents.push(payload); });
    socketB.on('conversation.invalidate', (payload: { conversationId: string }) => { invalidateEvents.push(payload); });

    // Tin r1 đến s2 qua realtime như thường lệ.
    const r1 = await send(s1.token, convId, 'tin realtime sẽ thu hồi');
    expect(r1.status).toBe(201);
    const r1Id = r1.body.id as string;
    await waitUntil(() => newEvents.some((e) => e.message.id === r1Id));

    // THU HỒI: phía kia BẮT BUỘC nhận cả hai tín hiệu — gỡ nội dung
    // (message.deleted) và vô hiệu cache danh sách (conversation.invalidate).
    const recall = await http(app).post(`/api/v1/messages/${r1Id}/recall`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(recall.status).toBe(201);
    await waitUntil(() => deletedEvents.some((e) => e.messageId === r1Id));
    await waitUntil(() => invalidateEvents.some((e) => e.conversationId === convId));

    // XOÁ-PHÍA-MÌNH: phía kia không nhận BẤT KỲ tín hiệu nào — chờ
    // quá vài nhịp phân phối outbox (500ms/nhịp) rồi đối chiếu bộ đếm.
    const r2 = await send(s1.token, convId, 'tin realtime xoá phía mình');
    expect(r2.status).toBe(201);
    const r2Id = r2.body.id as string;
    await waitUntil(() => newEvents.some((e) => e.message.id === r2Id));
    const deletedBefore = deletedEvents.length;
    const invalidateBefore = invalidateEvents.length;
    const del = await http(app).delete(`/api/v1/messages/${r2Id}`)
      .set('Authorization', `Bearer ${s1.token}`);
    expect(del.status).toBe(200);
    await new Promise((resolve) => { setTimeout(resolve, 2500); });
    expect(deletedEvents).toHaveLength(deletedBefore);
    expect(invalidateEvents).toHaveLength(invalidateBefore);
    expect(deletedEvents.some((e) => e.messageId === r2Id)).toBe(false);
  });

  it('7. cổng chặn 1–1: đang chặn thì thu hồi và xoá-phía-mình đều 404 như hội thoại không tồn tại', async () => {
    // s1–s2 kết bạn rồi mở hội thoại riêng.
    const req = await http(app).post(`/api/v1/messages/contacts/${s2.id}`).set('Authorization', `Bearer ${s1.token}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${s1.id}/accept`).set('Authorization', `Bearer ${s2.token}`).send({});
    expect(acc.status).toBe(201);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${s1.token}`)
      .send({ type: 1, memberIds: [s2.id] });
    expect(conv.status).toBe(201);
    const convId = conv.body.id as string;
    const sent = await send(s1.token, convId, 'tin riêng trước khi bị chặn');
    expect(sent.status).toBe(201);
    const msgId = sent.body.id as string;

    // s2 chặn s1: từ đây hội thoại như không tồn tại với cả hai phía.
    const block = await http(app).post(`/api/v1/messages/contacts/${s1.id}/block`).set('Authorization', `Bearer ${s2.token}`).send({});
    expect(block.status).toBe(201);
    const recallBlocked = await http(app).post(`/api/v1/messages/${msgId}/recall`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(recallBlocked.status).toBe(404);
    expect(recallBlocked.body.code).toBe('messaging.conversation_not_found');
    const deleteBlocked = await http(app).delete(`/api/v1/messages/${msgId}`)
      .set('Authorization', `Bearer ${s1.token}`);
    expect(deleteBlocked.status).toBe(404);
    expect(deleteBlocked.body.code).toBe('messaging.conversation_not_found');
    // Không thao tác nào lọt qua: không dấu thu hồi, không dòng hành động.
    expect(await actionsFor(msgId)).toHaveLength(0);

    // Bỏ chặn: thu hồi lại chạy bình thường (tin vẫn trong cửa sổ).
    const unblock = await http(app).delete(`/api/v1/messages/contacts/${s1.id}/block`).set('Authorization', `Bearer ${s2.token}`);
    expect(unblock.status).toBe(200);
    const recall = await http(app).post(`/api/v1/messages/${msgId}/recall`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(recall.status).toBe(201);
    expect(recall.body.recalledBy).toBe(s1.id);
  });
}, 60000);
