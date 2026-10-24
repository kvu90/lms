import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';

/**
 * Việc nối tiếp Lớp B của issue #33 (Lão gia chỉ ra 24/10/2026): tìm
 * bạn phải theo TÊN, không phải nhập UUID.
 *  - `GET /messages/people/search` tìm theo tên hiển thị/username CHỈ
 *    trong phạm vi cổng nhắn đã chốt: cùng khoá đang ghi danh hiệu
 *    lực + liên hệ đã duyệt; `core/messagingallusers` bật thì toàn hệ
 *    thống. Người đã chặn mình thì không xuất hiện trong kết quả của
 *    phía bị chặn; mỗi kết quả kèm trạng thái quan hệ đủ 5 loại.
 *  - Các response danh sách (danh bạ, hàng chờ kết bạn, conversation)
 *    trả kèm tên hiển thị để client hiện TÊN thay cho UUID thô.
 */

interface Person { id: string; username: string; token: string; displayName: string }

interface SearchResult {
  userId: string; displayName: string; username: string; relationship: string;
}

describe('Messaging — tìm bạn theo tên + hiển thị tên (việc nối tiếp Lớp B, issue #33)', () => {
  let app: INestApplication;
  let admin: string;
  let actor: Person;
  let binhTran: Person;
  let chiTran: Person;
  let dungPham: Person;
  let emHoang: Person;
  let giangVu: Person;
  let binhLe: Person;
  let haiDang: Person;

  async function person(firstName: string, lastName: string): Promise<Person> {
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken, displayName: `${firstName} ${lastName}` };
  }

  async function search(token: string, q: string): Promise<SearchResult[]> {
    const res = await http(app).get(`/api/v1/messages/people/search?q=${encodeURIComponent(q)}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.results as SearchResult[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    // Bắt đầu từ mặc định đã đăng ký (công tắc tắt) dù các lượt chạy trước để lại gì.
    await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);

    actor = await person('Tim', 'Kiem');
    binhTran = await person('Binh', 'Tran');
    chiTran = await person('Chi', 'Tran');
    dungPham = await person('Dung', 'Pham');
    emHoang = await person('Em', 'Hoang');
    giangVu = await person('Giang', 'Vu');
    binhLe = await person('Binh', 'Le');
    haiDang = await person('Hai', 'Dang');

    // Khoá chính: actor + 5 bạn cùng khoá. binhLe không ghi danh ở
    // đâu; haiDang chỉ ghi danh một khoá KHÁC.
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    for (const p of [actor, binhTran, chiTran, dungPham, emHoang, giangVu]) {
      await enrolUser(app, admin, course.id, instance.id, p.id);
    }
    const category2 = await createCategory(app, admin);
    const course2 = await createCourse(app, admin, category2.id);
    const instance2 = await createEnrolInstance(app, admin, course2.id);
    await enrolUser(app, admin, course2.id, instance2.id, haiDang.id);
  });
  afterAll(async () => {
    // Trả công tắc về mặc định để không rò trạng thái sang suite khác.
    await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);
    await app.close();
  });

  it('finds coursemates by display name (both name orders) and by username; excludes self and out-of-scope people while the switch is off', async () => {
    const byLastName = await search(actor.token, 'Tran');
    const tranIds = byLastName.map((r) => r.userId);
    expect(tranIds).toContain(binhTran.id);
    expect(tranIds).toContain(chiTran.id);
    expect(tranIds).not.toContain(actor.id);
    for (const r of byLastName) expect(r.relationship).toBe('none');
    const binh = byLastName.find((r) => r.userId === binhTran.id);
    expect(binh?.displayName).toBe('Binh Tran');
    expect(binh?.username).toBe(binhTran.username);

    // Thứ tự tên-họ (ngược thứ tự lưu) cũng khớp.
    const reversed = await search(actor.token, 'Tran Chi');
    expect(reversed.map((r) => r.userId)).toEqual([chiTran.id]);

    // Tìm theo username cũng ra đúng người.
    const byUsername = await search(actor.token, binhTran.username);
    expect(byUsername.map((r) => r.userId)).toContain(binhTran.id);

    // Cùng một phần tên nhưng người lạ không cùng khoá: không thấy.
    const binhs = await search(actor.token, 'Binh');
    expect(binhs.map((r) => r.userId)).toEqual([binhTran.id]);
    // Người của khoá khác cũng ngoài phạm vi.
    expect(await search(actor.token, 'Dang')).toEqual([]);
    // Chính mình bị loại khỏi kết quả dù tên khớp.
    expect(await search(actor.token, 'Kiem')).toEqual([]);
  });

  it('rejects too-short or missing queries with a 400', async () => {
    const short = await http(app).get('/api/v1/messages/people/search?q=T')
      .set('Authorization', `Bearer ${actor.token}`);
    expect(short.status).toBe(400);
    expect(short.body.code).toBe('messaging.search_query_too_short');
    const blank = await http(app).get('/api/v1/messages/people/search?q=%20%20')
      .set('Authorization', `Bearer ${actor.token}`);
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe('messaging.search_query_too_short');
    const missing = await http(app).get('/api/v1/messages/people/search')
      .set('Authorization', `Bearer ${actor.token}`);
    expect(missing.status).toBe(400);
  });

  it('reports all relationship states and hides the blocker from the blocked party', async () => {
    // pending_outgoing: actor gửi yêu cầu cho chiTran.
    const out = await http(app).post(`/api/v1/messages/contacts/${chiTran.id}`)
      .set('Authorization', `Bearer ${actor.token}`).send({});
    expect(out.status).toBe(201);
    const chi = await search(actor.token, 'Chi Tran');
    expect(chi).toHaveLength(1);
    expect(chi[0]?.relationship).toBe('pending_outgoing');

    // pending_incoming: dungPham gửi yêu cầu cho actor.
    const inc = await http(app).post(`/api/v1/messages/contacts/${actor.id}`)
      .set('Authorization', `Bearer ${dungPham.token}`).send({});
    expect(inc.status).toBe(201);
    const dung = await search(actor.token, 'Dung Pham');
    expect(dung[0]?.relationship).toBe('pending_incoming');
    // Hàng chờ kết bạn kèm tên hiển thị của phía kia.
    const queue = await http(app).get('/api/v1/messages/contacts/requests')
      .set('Authorization', `Bearer ${actor.token}`);
    const incomingRow = (queue.body.incoming as { userId: string; displayName: string; username: string }[])
      .find((r) => r.userId === dungPham.id);
    expect(incomingRow?.displayName).toBe('Dung Pham');
    expect(incomingRow?.username).toBe(dungPham.username);
    const outgoingRow = (queue.body.outgoing as { userId: string; displayName: string }[])
      .find((r) => r.userId === chiTran.id);
    expect(outgoingRow?.displayName).toBe('Chi Tran');

    // contact: actor và binhTran kết bạn xong (yêu cầu–chấp nhận).
    const req = await http(app).post(`/api/v1/messages/contacts/${binhTran.id}`)
      .set('Authorization', `Bearer ${actor.token}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${actor.id}/accept`)
      .set('Authorization', `Bearer ${binhTran.token}`).send({});
    expect(acc.status).toBe(201);
    const binh = await search(actor.token, 'Binh Tran');
    expect(binh[0]?.relationship).toBe('contact');
    // Danh bạ giữ nguyên trường cũ (mảng id) và kèm profiles theo id.
    const contactsRes = await http(app).get('/api/v1/messages/contacts')
      .set('Authorization', `Bearer ${actor.token}`);
    expect(contactsRes.body.contacts).toContain(binhTran.id);
    expect(contactsRes.body.profiles[binhTran.id]).toEqual({
      userId: binhTran.id, displayName: 'Binh Tran', username: binhTran.username,
    });

    // blocked (mình chặn họ): vẫn hiện trong kết quả với trạng thái blocked.
    const block = await http(app).post(`/api/v1/messages/contacts/${emHoang.id}/block`)
      .set('Authorization', `Bearer ${actor.token}`).send({});
    expect(block.status).toBe(201);
    const em = await search(actor.token, 'Em Hoang');
    expect(em).toHaveLength(1);
    expect(em[0]?.relationship).toBe('blocked');
    const blockedRes = await http(app).get('/api/v1/messages/contacts/blocked')
      .set('Authorization', `Bearer ${actor.token}`);
    expect(blockedRes.body.blocked).toContain(emHoang.id);
    expect(blockedRes.body.profiles[emHoang.id]?.displayName).toBe('Em Hoang');

    // Phía chặn biến mất khỏi kết quả của phía bị chặn: giangVu chặn actor.
    const blockMe = await http(app).post(`/api/v1/messages/contacts/${actor.id}/block`)
      .set('Authorization', `Bearer ${giangVu.token}`).send({});
    expect(blockMe.status).toBe(201);
    expect(await search(actor.token, 'Giang Vu')).toEqual([]);
    // Chiều ngược lại không bị ảnh hưởng: giangVu vẫn tìm thấy actor.
    const fromBlocker = await search(giangVu.token, 'Tim Kiem');
    expect(fromBlocker.map((r) => r.userId)).toContain(actor.id);
    expect(fromBlocker.find((r) => r.userId === actor.id)?.relationship).toBe('blocked');
  });

  it('attaches memberProfiles to conversation list and detail so clients render names (including the last message sender)', async () => {
    const conv = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${actor.token}`).send({ type: 1, memberIds: [binhTran.id] });
    expect(conv.status).toBe(201);
    const convId = conv.body.id as string;
    const sent = await http(app).post(`/api/v1/messages/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${binhTran.token}`).send({ text: 'chào bạn cùng lớp' });
    expect(sent.status).toBe(201);

    const list = await http(app).get('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${actor.token}`);
    const entry = (list.body as {
      id: string;
      memberProfiles: Record<string, { displayName: string; username: string }>;
      lastMessage: { userIdFrom: string } | null;
    }[]).find((c) => c.id === convId);
    expect(entry).toBeDefined();
    expect(entry?.lastMessage?.userIdFrom).toBe(binhTran.id);
    expect(entry?.memberProfiles[binhTran.id]?.displayName).toBe('Binh Tran');
    expect(entry?.memberProfiles[actor.id]?.displayName).toBe('Tim Kiem');

    const detail = await http(app).get(`/api/v1/messages/conversations/${convId}`)
      .set('Authorization', `Bearer ${actor.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.memberProfiles[binhTran.id]?.displayName).toBe('Binh Tran');
    expect(detail.body.memberProfiles[binhTran.id]?.username).toBe(binhTran.username);
    // Hình dạng cũ giữ nguyên: members vẫn là mảng id, markers vẫn theo userId.
    expect(detail.body.members).toContain(binhTran.id);
  });

  it('widens the scope to the whole site while messagingallusers is on, and narrows it back when off', async () => {
    const on = await http(app).put('/api/v1/site-config/core/messagingallusers')
      .set('Authorization', `Bearer ${admin}`).send({ value: true });
    expect(on.status).toBe(200);
    try {
      const binhs = await search(actor.token, 'Binh');
      const ids = binhs.map((r) => r.userId);
      expect(ids).toContain(binhTran.id);
      expect(ids).toContain(binhLe.id);
      expect(binhs.find((r) => r.userId === binhLe.id)?.relationship).toBe('none');
      const dang = await search(actor.token, 'Dang');
      expect(dang.map((r) => r.userId)).toContain(haiDang.id);
    } finally {
      await http(app).delete('/api/v1/site-config/core/messagingallusers')
        .set('Authorization', `Bearer ${admin}`);
    }
    const narrowed = await search(actor.token, 'Binh');
    expect(narrowed.map((r) => r.userId)).toEqual([binhTran.id]);
  });
});
