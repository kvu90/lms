import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from './engagement-helpers';

/**
 * Lát M4 — TÌM KIẾM trong bề mặt nhắn tin (issue #237): lọc nội dung
 * tin CHỈ tồn tại trong từng conversation, qua đúng cổng của đường
 * đọc tin. Các ca kiểm chứng đúng luồng nghiệp vụ:
 *  - thành viên tìm trong conversation của mình: chỉ tin khớp, mới
 *    nhất trước, excerpt quanh chỗ khớp, khớp không phân biệt hoa
 *    thường; không khớp → rỗng;
 *  - truy vấn rỗng/toàn khoảng trắng → 400 xác định; thiếu q → 400;
 *  - người ngoài conversation bị chặn như đường đọc tin; conversation
 *    không tồn tại → 404;
 *  - tin đã THU HỒI không bao giờ khớp (kể cả qua excerpt của tin trả
 *    lời trích dẫn nó) với người thường, nhưng người có thẩm quyền
 *    kiểm duyệt vẫn tìm thấy theo tầm nhìn truy vết;
 *  - tin tác giả đã ẩn-phía-mình: chính tác giả tìm không ra, phía
 *    kia tìm vẫn ra;
 *  - CHẶN thắng mọi bề mặt: trong nhóm, kết quả của cả hai phía đều
 *    loại tin của phía có quan hệ chặn; hội thoại 1–1 đang bị chặn
 *    thì tìm cũng 404 như không tồn tại.
 */

interface Person { id: string; username: string; token: string }

interface SearchResultBody {
  id: string; conversationId: string; userIdFrom: string; seq: number; excerpt: string; createdAt: string;
}

let app: INestApplication;
let admin: string;

let counter = 0;
async function person(): Promise<Person> {
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

async function search(token: string, conversationId: string, q: string) {
  return http(app).get(`/api/v1/messages/conversations/${conversationId}/search?q=${encodeURIComponent(q)}`)
    .set('Authorization', `Bearer ${token}`);
}

async function searchResults(token: string, conversationId: string, q: string): Promise<SearchResultBody[]> {
  const res = await search(token, conversationId, q);
  expect(res.status).toBe(200);
  return res.body.results as SearchResultBody[];
}

describe('Messaging M4 — tìm kiếm trong conversation (issue #237)', () => {
  let a: Person; let b: Person; let outsider: Person; let convId: string;
  let teacher: Person; let s1: Person; let s2: Person; let groupConvId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);

    a = await person();
    b = await person();
    outsider = await person();
    await befriend(a, b);
    convId = await openConversation(a, b);

    // Bối cảnh nhóm khoá (khuôn M3/lifecycle): giáo viên kiểm duyệt +
    // hai học sinh cùng nhóm — nơi luật chặn và tầm nhìn truy vết áp.
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    teacher = await person();
    s1 = await person();
    s2 = await person();
    for (const p of [teacher, s1, s2]) await enrolUser(app, admin, course.id, instance.id, p.id);
    const courseCtx = await contextIdByLevelInstance(app, admin, 50, course.id);
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacher.id, editingTeacher, courseCtx);
    const group = await createGroupViaApi(app, admin, course.id, 'Nhóm tìm kiếm M4');
    for (const p of [teacher, s1, s2]) await addGroupMember(app, admin, course.id, group.id, p.id);
    const created = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${s1.token}`).send({ groupId: group.id });
    expect(created.status).toBe(201);
    groupConvId = created.body.id as string;
  }, 180000);

  afterAll(async () => {
    await app.close();
  });

  it('1. thành viên tìm: chỉ tin khớp, mới nhất trước, excerpt chứa chỗ khớp, không phân biệt hoa thường', async () => {
    const m1 = await send(a.token, convId, 'Hôm nay học bài hàm số nhé');
    expect(m1.status).toBe(201);
    const m2 = await send(b.token, convId, 'Mai kiểm tra chương hàm số đấy');
    expect(m2.status).toBe(201);
    const m3 = await send(a.token, convId, 'Ăn trưa chưa bạn');
    expect(m3.status).toBe(201);

    const results = await searchResults(b.token, convId, 'hàm số');
    expect(results.map((r) => r.id)).toEqual([m2.body.id, m1.body.id]);
    expect(results[0]).toMatchObject({ conversationId: convId, userIdFrom: b.id, seq: m2.body.seq });
    expect(results[0]!.excerpt).toContain('hàm số');
    expect(results[1]!.excerpt).toContain('hàm số');

    // Không phân biệt hoa thường.
    const upper = await searchResults(b.token, convId, 'HÀM SỐ');
    expect(upper.map((r) => r.id)).toEqual([m2.body.id, m1.body.id]);

    // Không khớp → danh sách rỗng, vẫn 200.
    expect(await searchResults(b.token, convId, 'không hề tồn tại')).toEqual([]);

    // Giới hạn kết quả được tôn trọng.
    const limited = await http(app).get(`/api/v1/messages/conversations/${convId}/search?q=${encodeURIComponent('hàm số')}&limit=1`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(limited.status).toBe(200);
    expect(limited.body.results).toHaveLength(1);
    expect(limited.body.results[0].id).toBe(m2.body.id);
  });

  it('2. excerpt của tin dài rút gọn quanh chỗ khớp (≤120 ký tự + dấu … phía bị cắt)', async () => {
    const longText = `${'a'.repeat(100)}từkhoágiữa${'b'.repeat(100)}`;
    const sent = await send(a.token, convId, longText);
    expect(sent.status).toBe(201);
    const results = await searchResults(b.token, convId, 'từkhoágiữa');
    expect(results).toHaveLength(1);
    const excerpt = results[0]!.excerpt;
    expect(excerpt).toContain('từkhoágiữa');
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(122);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('3. truy vấn rỗng/toàn khoảng trắng → 400 xác định; thiếu q hoặc limit vượt trần → 400', async () => {
    const blank = await search(a.token, convId, '   ');
    expect(blank.status).toBe(400);
    expect(blank.body.code).toBe('messaging.search_query_empty');

    const missing = await http(app).get(`/api/v1/messages/conversations/${convId}/search`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(missing.status).toBe(400);

    const badLimit = await http(app).get(`/api/v1/messages/conversations/${convId}/search?q=x&limit=51`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(badLimit.status).toBe(400);
  });

  it('4. người ngoài conversation bị chặn như đường đọc tin; conversation không tồn tại → 404', async () => {
    // Cùng cổng với GET .../messages: người ngoài nhận 403 not_member.
    const readAttempt = await http(app).get(`/api/v1/messages/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${outsider.token}`);
    const searchAttempt = await search(outsider.token, convId, 'hàm số');
    expect(searchAttempt.status).toBe(readAttempt.status);
    expect(searchAttempt.body.code).toBe(readAttempt.body.code);

    const missing = await search(a.token, '0192c3b4-1111-7000-8000-000000000000', 'hàm số');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('messaging.conversation_not_found');
  });

  it('5. tin đã thu hồi không khớp với người thường — kể cả qua excerpt của tin trả lời trích dẫn nó', async () => {
    const secret = 'mật khẩu wifi là abc123';
    const original = await send(a.token, convId, secret);
    expect(original.status).toBe(201);
    const reply = await send(b.token, convId, 'đã nhận nhé', original.body.id as string);
    expect(reply.status).toBe(201);

    const recall = await http(app).post(`/api/v1/messages/${original.body.id as string}/recall`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(recall.status).toBe(201);

    const res = await search(b.token, convId, 'wifi');
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('abc123');
    // Chính tác giả (cũng là người thường ở hội thoại 1–1) cũng không khớp lại nội dung đã thu hồi.
    expect(await searchResults(a.token, convId, 'wifi')).toEqual([]);
  });

  it('6. tác giả ẩn tin phía mình: chính tác giả tìm không ra, phía kia tìm vẫn ra', async () => {
    const sent = await send(a.token, convId, 'tin a tự ẩn phía mình m4');
    expect(sent.status).toBe(201);

    const hide = await http(app).delete(`/api/v1/messages/${sent.body.id as string}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(hide.status).toBe(200);

    expect(await searchResults(a.token, convId, 'tự ẩn phía mình')).toEqual([]);
    const forB = await searchResults(b.token, convId, 'tự ẩn phía mình');
    expect(forB.map((r) => r.id)).toEqual([sent.body.id]);
  });

  it('7. người có thẩm quyền kiểm duyệt tìm thấy tin đã thu hồi theo tầm nhìn truy vết; học sinh thì không', async () => {
    const sent = await send(s2.token, groupConvId, 'nội dung kiểm duyệt sẽ thu hồi m4');
    expect(sent.status).toBe(201);
    const recall = await http(app).post(`/api/v1/messages/${sent.body.id as string}/recall`)
      .set('Authorization', `Bearer ${s2.token}`).send({});
    expect(recall.status).toBe(201);

    expect(await searchResults(s1.token, groupConvId, 'kiểm duyệt sẽ thu hồi')).toEqual([]);
    const forTeacher = await searchResults(teacher.token, groupConvId, 'kiểm duyệt sẽ thu hồi');
    expect(forTeacher.map((r) => r.id)).toEqual([sent.body.id]);
    expect(forTeacher[0]!.excerpt).toContain('kiểm duyệt sẽ thu hồi');
  });

  it('8. trong nhóm: phía có quan hệ chặn bị loại khỏi kết quả của cả hai phía; giáo viên không chặn thì thấy đủ', async () => {
    const fromS1 = await send(s1.token, groupConvId, 'nhiệm vụ nhóm m4 tuần này');
    expect(fromS1.status).toBe(201);
    const fromS2 = await send(s2.token, groupConvId, 'báo cáo nhóm m4 đã xong');
    expect(fromS2.status).toBe(201);

    // Chưa chặn: cả hai phía tìm thấy cả hai tin.
    expect((await searchResults(s1.token, groupConvId, 'nhóm m4')).map((r) => r.id).sort())
      .toEqual([fromS1.body.id, fromS2.body.id].sort());

    const block = await http(app).post(`/api/v1/messages/contacts/${s2.id}/block`)
      .set('Authorization', `Bearer ${s1.token}`).send({});
    expect(block.status).toBe(201);

    // S1 đã chặn S2: kết quả của S1 loại tin của S2.
    expect((await searchResults(s1.token, groupConvId, 'nhóm m4')).map((r) => r.id))
      .toEqual([fromS1.body.id]);
    // Chiều ngược cũng thắng: S2 (phía bị chặn) cũng không thấy tin của S1 qua tìm kiếm.
    expect((await searchResults(s2.token, groupConvId, 'nhóm m4')).map((r) => r.id))
      .toEqual([fromS2.body.id]);
    // Giáo viên không có quan hệ chặn với ai: thấy đủ cả hai.
    expect((await searchResults(teacher.token, groupConvId, 'nhóm m4')).map((r) => r.id).sort())
      .toEqual([fromS1.body.id, fromS2.body.id].sort());
  });

  it('9. hội thoại 1–1 đang bị chặn: tìm cũng 404 như không tồn tại ở cả hai phía', async () => {
    const block = await http(app).post(`/api/v1/messages/contacts/${b.id}/block`)
      .set('Authorization', `Bearer ${a.token}`).send({});
    expect(block.status).toBe(201);

    for (const viewer of [a, b]) {
      const res = await search(viewer.token, convId, 'hàm số');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('messaging.conversation_not_found');
    }
  });
});
