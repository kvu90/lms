import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelayService } from '../src/infra/events/outbox-relay.service';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from './engagement-helpers';

/**
 * Lớp B (nghiệp vụ) của issue #33 — bộ chính sách Lão gia đã chốt
 * (comment 6367872889 + 6368023587 trên issue):
 *  1. Nhắn riêng CHỈ giữa liên hệ đã duyệt kết bạn (yêu cầu–chấp
 *     nhận thay danh bạ một chiều) — mô hình chốt lại 24/10/2026:
 *     cùng khoá không còn mở cổng nhắn riêng, công tắc site
 *     `core/messagingallusers` mất hiệu lực với tin nhắn (kiểm chứng
 *     đầy đủ ở messaging-roster-flow + messaging-calendar-flow);
 *     khám phá bạn bè đi qua roster thành viên khoá.
 *  2. Học sinh KHÔNG tự lập nhóm — chặn tại tầng service.
 *  3. Nhóm lớp chat hai chiều mặc định; giáo viên tắt được qua cột
 *     `enabled` (đường gửi phải tôn trọng); tắt thì học sinh dừng gửi,
 *     giáo viên vẫn gửi được.
 *  4. Xoá mềm có truy vết theo vai trò: giáo viên xoá → học sinh không
 *     thấy; học sinh xoá tin mình → học sinh không thấy nhưng giáo viên
 *     vẫn truy vết được nội dung; người không có thẩm quyền không xoá
 *     được tin của người khác.
 *  5. Báo cáo trong conversation → giáo viên phụ trách + admin; chỉ
 *     người có thẩm quyền theo phạm vi mới xem lại được nội dung của
 *     đúng conversation bị báo cáo; mọi lần xem ghi event_log.
 */

interface Person { id: string; username: string; token: string }

interface MessageBody {
  id: string; fullMessage: string; userIdFrom: string; seq: number;
  deletedAt: string | null; deletedBy: string | null;
}

describe('Messaging Lớp B — chính sách nghiệp vụ (issue #33)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let teacher: Person;
  let otherTeacher: Person;
  let s1: Person;
  let s2: Person;
  let groupConvId: string;

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
    return res.body as { messages: MessageBody[]; canModerate: boolean; canManage: boolean; enabled: boolean };
  }

  beforeAll(async () => {
    // Dọn tồn đọng outbox của các spec đã chạy trước trên cùng DB:
    // relay ở app test chỉ chạy khi gọi tay, nên row chưa publish khi
    // app trước đóng là row chết — không test nào còn tiêu thụ.
    // Không dọn thì vòng xả ở test 5 phải duyệt toàn bộ tồn đọng của
    // cả suite (O(backlog)) và vượt trần timeout dưới tải CI dù mọi
    // assertion đều đúng (CI run 40097046131 trên commit chỉ nới trần
    // 120s vẫn đỏ, chênh đúng ~2×90s so với run cũ). Dọn xong, vòng xả
    // chỉ còn duyệt event của chính spec này.
    const stale = new Client({ connectionString: process.env.DATABASE_URL });
    await stale.connect();
    await stale.query('DELETE FROM outbox_events WHERE published_at IS NULL');
    await stale.end();
    app = await createTestApp();
    admin = await adminToken(app);
    adminId = (await login(app, 'admin', 'Admin123!')).userId;

    // Khoá chính: giáo viên (editingteacher tại context khoá) + 2 học sinh.
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

    // Giáo viên của một khoá KHÁC — ngoài phạm vi phụ trách của khoá chính.
    const category2 = await createCategory(app, admin);
    const course2 = await createCourse(app, admin, category2.id);
    otherTeacher = await person();
    const course2Ctx = await contextIdByLevelInstance(app, admin, 50, course2.id);
    await assignRole(app, admin, otherTeacher.id, editingTeacher, course2Ctx);

    // Nhóm lớp (course group) gồm giáo viên + 2 học sinh; conversation
    // gắn group do một học sinh là thành viên group tạo (đường cấu trúc
    // lớp/khoá — khác với nhóm tự do bị cấm ở test 2).
    const group = await createGroupViaApi(app, admin, course.id, 'Lớp B Team');
    for (const p of [teacher, s1, s2]) await addGroupMember(app, admin, course.id, group.id, p.id);
    const created = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${s1.token}`).send({ groupId: group.id });
    expect(created.status).toBe(201);
    groupConvId = created.body.id as string;
  });
  afterAll(async () => { await app.close(); });

  it('1. contact requests: decline keeps the gate closed, a blocked user cannot even request, and the recipient is notified of the request', async () => {
    const a = await person();
    const b = await person();

    // A xin kết bạn; B nhận được notification về yêu cầu.
    const req = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${a.token}`).send({});
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    const bNotifications = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${b.token}`);
    expect((bNotifications.body.items as { eventType: string }[]).some((n) => n.eventType === 'contact_request')).toBe(true);

    // B TỪ CHỐI: hàng chờ sạch cả hai phía, quan hệ không hình thành,
    // cổng liên lạc vẫn đóng (A tạo conversation 1-1 bị 403).
    const declined = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/decline`).set('Authorization', `Bearer ${b.token}`).send({});
    expect(declined.status).toBe(201);
    expect(declined.body.declined).toBe(true);
    const bQueue = await http(app).get('/api/v1/messages/contacts/requests').set('Authorization', `Bearer ${b.token}`);
    expect(bQueue.body.incoming).toEqual([]);
    const aQueue = await http(app).get('/api/v1/messages/contacts/requests').set('Authorization', `Bearer ${a.token}`);
    expect(aQueue.body.outgoing).toEqual([]);
    const blockedCreate = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${a.token}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(blockedCreate.status).toBe(403);
    expect(blockedCreate.body.code).toBe('messaging.not_a_contact');
    // Từ chối lần nữa (không còn yêu cầu) → 404 rõ ràng.
    const declineAgain = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/decline`).set('Authorization', `Bearer ${b.token}`).send({});
    expect(declineAgain.status).toBe(404);
    expect(declineAgain.body.code).toBe('messaging.contact_request_not_found');

    // B chặn A: A không gửi nổi yêu cầu nữa.
    await http(app).post(`/api/v1/messages/contacts/${a.id}/block`).set('Authorization', `Bearer ${b.token}`).send({});
    const reqBlocked = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${a.token}`).send({});
    expect(reqBlocked.status).toBe(403);
    expect(reqBlocked.body.code).toBe('messaging.contact_blocked');
  });

  it('2. students cannot create free groups at the service layer; a teacher can', async () => {
    const extra = await person();
    // Học sinh (dù đang ghi danh một khoá thật) tạo nhóm tự do → 403.
    const byStudent = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${s1.token}`)
      .send({ type: 2, memberIds: [s2.id, extra.id], name: 'Nhóm tự lập' });
    expect(byStudent.status).toBe(403);
    expect(byStudent.body.code).toBe('messaging.group_creation_forbidden');
    // Người dùng không vai trò gì cũng bị chặn như vậy.
    const byNobody = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${extra.token}`)
      .send({ type: 2, memberIds: [s1.id, s2.id], name: 'Nhóm của người lạ' });
    expect(byNobody.status).toBe(403);
    expect(byNobody.body.code).toBe('messaging.group_creation_forbidden');
    // Giáo viên (có gán vai trò staff) tạo được, thành viên đúng như khai.
    const byTeacher = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${teacher.token}`)
      .send({ type: 2, memberIds: [s1.id, s2.id], name: 'Nhóm giáo viên tạo' });
    expect(byTeacher.status).toBe(201);
    expect(new Set(byTeacher.body.members as string[])).toEqual(new Set([teacher.id, s1.id, s2.id]));
    expect(byTeacher.body.createdBy).toBe(teacher.id);
  });

  it('3. class group chat is two-way by default; when the teacher switches it off, students stop sending but the teacher still can', async () => {
    // Mặc định hai chiều: học sinh gửi được.
    const warm = await send(s1.token, groupConvId, 'tin mở đầu lớp');
    expect(warm.status).toBe(201);

    // Học sinh (kể cả người đã tạo conversation gắn group này) không có
    // quyền quản lý: PATCH tắt chat → 403.
    const studentToggle = await http(app).patch(`/api/v1/messages/conversations/${groupConvId}`)
      .set('Authorization', `Bearer ${s1.token}`).send({ enabled: false });
    expect(studentToggle.status).toBe(403);
    expect(studentToggle.body.code).toBe('messaging.conversation_manage_forbidden');
    // Giáo viên của khoá khác cũng ngoài phạm vi.
    const otherToggle = await http(app).patch(`/api/v1/messages/conversations/${groupConvId}`)
      .set('Authorization', `Bearer ${otherTeacher.token}`).send({ enabled: false });
    expect(otherToggle.status).toBe(403);

    // Giáo viên phụ trách tắt chat.
    const off = await http(app).patch(`/api/v1/messages/conversations/${groupConvId}`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);

    // Học sinh dừng gửi (cả hai em), đúng mã lỗi conversation_disabled.
    for (const student of [s1, s2]) {
      const res = await send(student.token, groupConvId, 'em gửi khi đã tắt');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('messaging.conversation_disabled');
    }
    // Giáo viên vẫn gửi được — đường thông báo một chiều.
    const teacherSends = await send(teacher.token, groupConvId, 'Thông báo của giáo viên khi lớp tắt chat');
    expect(teacherSends.status).toBe(201);

    // Bật lại: học sinh gửi lại bình thường.
    const on = await http(app).patch(`/api/v1/messages/conversations/${groupConvId}`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    const again = await send(s2.token, groupConvId, 'lớp mở lại rồi');
    expect(again.status).toBe(201);

    // Nhóm tự do do giáo viên tạo: người tạo quản lý được nhóm của
    // mình (tắt → học sinh dừng, giáo viên gửi được).
    const freeGroup = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${teacher.token}`)
      .send({ type: 2, memberIds: [s1.id], name: 'Nhóm ôn tập' });
    expect(freeGroup.status).toBe(201);
    const freeId = freeGroup.body.id as string;
    const freeOff = await http(app).patch(`/api/v1/messages/conversations/${freeId}`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ enabled: false });
    expect(freeOff.status).toBe(200);
    const studentFree = await send(s1.token, freeId, 'em gửi vào nhóm ôn tập');
    expect(studentFree.status).toBe(403);
    expect(studentFree.body.code).toBe('messaging.conversation_disabled');
    const teacherFree = await send(teacher.token, freeId, 'giáo viên gửi vào nhóm ôn tập');
    expect(teacherFree.status).toBe(201);
  });

  it('4. soft delete with trace: students lose sight of deleted messages, the teacher still traces content, and only author/moderator can delete', async () => {
    const m1 = await send(s2.token, groupConvId, 'tin của s2 giữ lại sau');
    expect(m1.status).toBe(201);
    // s2 đọc hết tới hiện tại (kể cả các tin khởi động của test 3) để
    // mốc chưa đọc đo dưới đây chỉ còn phản ánh đúng m2.
    const marked = await http(app).post(`/api/v1/messages/conversations/${groupConvId}/read`)
      .set('Authorization', `Bearer ${s2.token}`).send({});
    expect(marked.status).toBe(201);
    const m2 = await send(s1.token, groupConvId, 'tin s1 sẽ tự xoá');
    expect(m2.status).toBe(201);
    const m1Id = m1.body.id as string;
    const m2Id = m2.body.id as string;

    // Học sinh này xoá tin của học sinh khác → 403.
    const foreign = await http(app).delete(`/api/v1/messages/messages/${m2Id}`).set('Authorization', `Bearer ${s2.token}`);
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('messaging.message_delete_forbidden');
    // Người ngoài conversation cũng không xoá được.
    const outsider = await person();
    const outsiderDelete = await http(app).delete(`/api/v1/messages/messages/${m2Id}`).set('Authorization', `Bearer ${outsider.token}`);
    expect(outsiderDelete.status).toBe(403);

    // s2 đang có 1 tin chưa đọc (m2 của s1) trong danh sách của mình.
    const listBefore = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${s2.token}`);
    const entryBefore = (listBefore.body as { id: string; unread: number }[]).find((c) => c.id === groupConvId);
    expect(entryBefore?.unread).toBe(1);

    // s1 xoá tin của chính mình: đánh dấu có truy vết, không mất dòng.
    const del = await http(app).delete(`/api/v1/messages/messages/${m2Id}`).set('Authorization', `Bearer ${s1.token}`);
    expect(del.status).toBe(200);
    expect(del.body.deletedAt).toBeTruthy();
    expect(del.body.deletedBy).toBe(s1.id);
    expect(del.body.fullMessage).toBe('tin s1 sẽ tự xoá');

    // Mọi học sinh đều không còn thấy m2 — kể cả chính tác giả; số chưa
    // đọc và tin cuối trong danh sách của s2 lùi về m1.
    const s2View = await viewMessages(s2.token, groupConvId);
    expect(s2View.messages.map((m) => m.id)).not.toContain(m2Id);
    expect(s2View.canModerate).toBe(false);
    const s1View = await viewMessages(s1.token, groupConvId);
    expect(s1View.messages.map((m) => m.id)).not.toContain(m2Id);
    const listAfter = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${s2.token}`);
    const entryAfter = (listAfter.body as { id: string; unread: number; lastMessage: MessageBody | null }[])
      .find((c) => c.id === groupConvId);
    expect(entryAfter?.unread).toBe(0);
    expect(entryAfter?.lastMessage?.id).toBe(m1Id);

    // Giáo viên vẫn truy vết được: m2 hiện ra với nguyên nội dung + dấu xoá.
    const teacherView = await viewMessages(teacher.token, groupConvId);
    expect(teacherView.canModerate).toBe(true);
    const traced = teacherView.messages.find((m) => m.id === m2Id);
    expect(traced).toBeDefined();
    expect(traced!.fullMessage).toBe('tin s1 sẽ tự xoá');
    expect(traced!.deletedBy).toBe(s1.id);
    expect(traced!.deletedAt).toBeTruthy();

    // Giáo viên xoá tin của s2: học sinh mất dấu, giáo viên còn truy vết.
    const teacherDel = await http(app).delete(`/api/v1/messages/messages/${m1Id}`).set('Authorization', `Bearer ${teacher.token}`);
    expect(teacherDel.status).toBe(200);
    expect(teacherDel.body.deletedBy).toBe(teacher.id);
    const s2ViewAfter = await viewMessages(s2.token, groupConvId);
    expect(s2ViewAfter.messages.map((m) => m.id)).not.toContain(m1Id);
    const teacherViewAfter = await viewMessages(teacher.token, groupConvId);
    const tracedM1 = teacherViewAfter.messages.find((m) => m.id === m1Id);
    expect(tracedM1?.fullMessage).toBe('tin của s2 giữ lại sau');
    expect(tracedM1?.deletedBy).toBe(teacher.id);
    // Xoá lại tin đã xoá: idempotent, dấu vết lần đầu giữ nguyên.
    const again = await http(app).delete(`/api/v1/messages/messages/${m1Id}`).set('Authorization', `Bearer ${teacher.token}`);
    expect(again.status).toBe(200);
    expect(again.body.deletedBy).toBe(teacher.id);
  });

  // Trần 120s (không phải 30s mặc định): vòng xả relay ở cuối test phải
  // duyệt TUẦN TỰ toàn bộ outbox tồn đọng của cả suite trên cùng DB
  // (relay API không tự chạy theo lịch), nên dưới tải CI nó vượt 30s
  // dù mọi assertion đều đúng — xem bàn giao fix CI PR #76. Không bỏ
  // assertion nào, chỉ nới trần cho thao tác xả tồn đọng này.
  it('5. reports reach the teacher in charge and admins only; reviewing is scope-checked and every view is written to event_log', async () => {
    // Một tin riêng 1-1 (s1–s2 kết bạn trước vì cổng nhắn riêng nay
    // chỉ mở cho liên hệ đã duyệt) bị chính tác giả xoá — nội dung
    // chỉ còn truy vết được qua đường báo cáo có thẩm quyền.
    const friendReq = await http(app).post(`/api/v1/messages/contacts/${s2.id}`).set('Authorization', `Bearer ${s1.token}`).send({});
    expect(friendReq.status).toBe(201);
    const friendAcc = await http(app).post(`/api/v1/messages/contacts/requests/${s1.id}/accept`).set('Authorization', `Bearer ${s2.token}`).send({});
    expect(friendAcc.status).toBe(201);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${s1.token}`)
      .send({ type: 1, memberIds: [s2.id] });
    expect(conv.status).toBe(201);
    const convId = conv.body.id as string;
    const secret = await send(s1.token, convId, 'tin riêng sẽ bị xoá');
    expect(secret.status).toBe(201);
    const secretId = secret.body.id as string;
    const delOwn = await http(app).delete(`/api/v1/messages/messages/${secretId}`).set('Authorization', `Bearer ${s1.token}`);
    expect(delOwn.status).toBe(200);

    // Người ngoài conversation không báo cáo được.
    const outsider = await person();
    const outsiderReport = await http(app).post(`/api/v1/messages/conversations/${convId}/report`)
      .set('Authorization', `Bearer ${outsider.token}`).send({ reason: 'người ngoài' });
    expect(outsiderReport.status).toBe(403);
    expect(outsiderReport.body.code).toBe('messaging.not_member');
    // Conversation không tồn tại → 404.
    const missing = await http(app).post('/api/v1/messages/conversations/123e4567-e89b-72d3-a456-426614174000/report')
      .set('Authorization', `Bearer ${s2.token}`).send({});
    expect(missing.status).toBe(404);

    // s2 (người nhận) báo cáo.
    const report = await http(app).post(`/api/v1/messages/conversations/${convId}/report`)
      .set('Authorization', `Bearer ${s2.token}`).send({ reason: 'Nghi bắt nạt qua tin nhắn riêng' });
    expect(report.status).toBe(201);
    expect(report.body.status).toBe('open');
    expect(report.body.reporterId).toBe(s2.id);
    const reportId = report.body.id as string;

    // Thông báo về đúng nơi: giáo viên phụ trách + admin nhận được.
    const teacherNotifications = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${teacher.token}`);
    expect((teacherNotifications.body.items as { eventType: string }[]).some((n) => n.eventType === 'conversation_reported')).toBe(true);
    const adminNotifications = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${admin}`);
    expect((adminNotifications.body.items as { eventType: string }[]).some((n) => n.eventType === 'conversation_reported')).toBe(true);

    // Hàng đợi theo phạm vi: admin thấy, giáo viên phụ trách thấy,
    // giáo viên khoá khác KHÔNG, học sinh KHÔNG.
    const adminQueue = await http(app).get('/api/v1/messages/reports').set('Authorization', `Bearer ${admin}`);
    expect((adminQueue.body as { id: string }[]).map((r) => r.id)).toContain(reportId);
    const teacherQueue = await http(app).get('/api/v1/messages/reports').set('Authorization', `Bearer ${teacher.token}`);
    expect((teacherQueue.body as { id: string }[]).map((r) => r.id)).toContain(reportId);
    const otherQueue = await http(app).get('/api/v1/messages/reports').set('Authorization', `Bearer ${otherTeacher.token}`);
    expect((otherQueue.body as { id: string }[]).map((r) => r.id)).not.toContain(reportId);
    const studentQueue = await http(app).get('/api/v1/messages/reports').set('Authorization', `Bearer ${s1.token}`);
    expect((studentQueue.body as { id: string }[]).map((r) => r.id)).not.toContain(reportId);

    // Xem lại nội dung: học sinh (kể cả người báo cáo) và giáo viên
    // ngoài phạm vi bị chặn; giáo viên phụ trách và admin xem được —
    // gồm cả tin đã xoá mềm với nguyên nội dung.
    const studentView = await http(app).get(`/api/v1/messages/reports/${reportId}/conversation`).set('Authorization', `Bearer ${s2.token}`);
    expect(studentView.status).toBe(403);
    expect(studentView.body.code).toBe('messaging.report_review_forbidden');
    const otherView = await http(app).get(`/api/v1/messages/reports/${reportId}/conversation`).set('Authorization', `Bearer ${otherTeacher.token}`);
    expect(otherView.status).toBe(403);
    const teacherView = await http(app).get(`/api/v1/messages/reports/${reportId}/conversation`).set('Authorization', `Bearer ${teacher.token}`);
    expect(teacherView.status).toBe(200);
    const tracedSecret = (teacherView.body.conversation.messages as MessageBody[]).find((m) => m.id === secretId);
    expect(tracedSecret?.fullMessage).toBe('tin riêng sẽ bị xoá');
    expect(tracedSecret?.deletedBy).toBe(s1.id);
    const adminView = await http(app).get(`/api/v1/messages/reports/${reportId}/conversation`).set('Authorization', `Bearer ${admin}`);
    expect(adminView.status).toBe(200);
    expect(adminView.body.report.id).toBe(reportId);

    // Mọi lần xem đều vào event_log: chạy một lượt relay (đúng việc
    // worker làm mỗi 5 giây) rồi truy vấn logstore bằng tài khoản admin.
    const relay = app.get(OutboxRelayService);
    for (let i = 0; i < 20; i += 1) {
      const n = await relay.publishPending(500);
      if (n === 0) break;
    }
    const logs = await http(app).get('/api/v1/event-logs?eventType=message_conversation_report_viewed')
      .set('Authorization', `Bearer ${admin}`);
    expect(logs.status).toBe(200);
    const items = (logs.body as { items: { userId: string; objectId: string; payload: Record<string, unknown> }[] }).items;
    const teacherRow = items.find((i) => i.userId === teacher.id && i.objectId === convId);
    expect(teacherRow).toBeDefined();
    expect(teacherRow!.payload.reportId).toBe(reportId);
    const adminRow = items.find((i) => i.userId === adminId && i.objectId === convId);
    expect(adminRow).toBeDefined();

    // Xử lý báo cáo: học sinh đổi trạng thái → 403; giáo viên phụ trách
    // đóng báo cáo được, dấu người xử lý được ghi.
    const studentResolve = await http(app).patch(`/api/v1/messages/reports/${reportId}`)
      .set('Authorization', `Bearer ${s1.token}`).send({ status: 'resolved' });
    expect(studentResolve.status).toBe(403);
    const resolved = await http(app).patch(`/api/v1/messages/reports/${reportId}`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ status: 'resolved' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe('resolved');
    expect(resolved.body.resolvedBy).toBe(teacher.id);
    expect(resolved.body.resolvedAt).toBeTruthy();
    // Trần 120s: main đã nới 30s → 60s vì test này chạy ~25 gọi HTTP +
    // tạo user (argon2) + nhiều lượt relay, từng chạm trần 30s khi máy
    // tải nặng; PR #76 giữ 120s (vòng xả tồn đọng) — lấy max hai phía,
    // không bỏ assertion nào.
  }, 120000);
});
