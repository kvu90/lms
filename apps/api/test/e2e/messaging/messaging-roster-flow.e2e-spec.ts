import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { contextIdByLevelInstance, suspendUser } from '../../support/engagement-helpers';

/**
 * Mô hình khám phá bạn bè ĐÃ CHỐT LẠI của issue #33 (quyết định
 * 24/10/2026, thay toàn bộ cơ chế tìm người theo tên của PR #41):
 *  - Endpoint `GET /messages/people/search` ĐÃ GỠ — gọi vào là 404.
 *  - Khám phá bạn bè qua ROSTER thành viên khoá: thành viên = ghi
 *    danh đang hiệu lực ∪ gán vai tại context khoá (giáo viên chỉ
 *    được gán vai, không ghi danh, vẫn hiện với dấu hiệu teacher).
 *    Chỉ thành viên mới xem được; người ngoài khoá nhận đúng 404
 *    như khoá không tồn tại. Roster phân trang CON TRỎ (displayName,
 *    username, id), mỗi dòng đúng whitelist trường đã kiểm chứng +
 *    vai trò + trạng thái quan hệ; tài khoản tạm ngưng bị loại;
 *    quan hệ chặn (cả hai chiều) bị giấu.
 *  - Nhắn riêng 1-1 CHỈ giữa liên hệ đã kết bạn: cùng khoá không
 *    còn mở cổng, công tắc `core/messagingallusers` bật cũng không
 *    mở; hội thoại cũ với người đã gỡ liên hệ vẫn đọc được lịch
 *    sử nhưng gửi mới bị chặn. NGOẠI LỆ duy nhất (chốt bổ sung
 *    25/10/2026): giáo viên của khoá ↔ học sinh đang ghi danh chính
 *    khoá đó nhắn trực tiếp không cần kết bạn — spec riêng
 *    messaging-teacher-direct.e2e-spec.ts khoá hành vi đó; ở spec
 *    này actor là học sinh nên `canDirectMessage` luôn false.
 */

interface Person { id: string; username: string; token: string; displayName: string }

interface RosterMember {
  userId: string; displayName: string; username: string;
  role: 'teacher' | 'student'; relationship: string; canDirectMessage: boolean;
}

describe('Messaging — roster thành viên khoá + cổng nhắn riêng chỉ liên hệ (issue #33)', () => {
  let app: INestApplication;
  let admin: string;
  let courseA: string;
  let courseB: string;
  let actor: Person;
  let teacherRoleOnly: Person;
  let teacherBoth: Person;
  let s2: Person;
  let s3: Person;
  let outsider: Person;

  async function person(firstName: string, lastName: string): Promise<Person> {
    const u = await createUserViaApi(app, admin, { firstName, lastName });
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken, displayName: `${firstName} ${lastName}` };
  }

  async function roster(token: string, courseId: string, query = '') {
    return http(app).get(`/api/v1/messages/courses/${courseId}/members${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function befriend(requester: Person, accepter: Person): Promise<void> {
    const req = await http(app).post(`/api/v1/messages/contacts/${accepter.id}`)
      .set('Authorization', `Bearer ${requester.token}`).send({});
    expect(req.status).toBe(201);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${requester.id}/accept`)
      .set('Authorization', `Bearer ${accepter.token}`).send({});
    expect(acc.status).toBe(201);
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    // Bắt đầu từ mặc định đã đăng ký (công tắc tắt) dù các lượt chạy trước để lại gì.
    await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);

    actor = await person('An', 'Actor');
    teacherRoleOnly = await person('Giao', 'Vien');
    teacherBoth = await person('Giao', 'Hai');
    s2 = await person('Binh', 'Tran');
    s3 = await person('Chi', 'Tran');
    outsider = await person('Ngoai', 'Khoa');
    const ghost = await person('Ghi', 'Danh');

    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id, { fullName: 'Khoá Roster A' });
    courseA = course.id;
    const instance = await createEnrolInstance(app, admin, courseA);
    // teacherRoleOnly KHÔNG ghi danh — chỉ gán vai editingteacher tại
    // context khoá. teacherBoth vừa ghi danh vừa gán vai.
    for (const p of [actor, teacherBoth, s2, s3, ghost]) {
      await enrolUser(app, admin, courseA, instance.id, p.id);
    }
    const courseCtx = await contextIdByLevelInstance(app, admin, 50, courseA);
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacherRoleOnly.id, editingTeacher, courseCtx);
    // teacherBoth: trạng thái lẫn vai (vừa ghi danh học viên đang hoạt
    // động vừa có gán vai giảng dạy tại chính khoá) — từ issue #425,
    // API KHÔNG còn đường nào tạo được trạng thái này (cả hai chiều
    // gán vai/ghi danh đều bị chốt tách vai chặn); nó chỉ còn tồn tại
    // như DỮ KIỆN TỒN TẠI từ trước chốt, và hành vi phân loại roster
    // trên dữ kiện đó vẫn phải được kiểm. Fixture vì vậy ghi thẳng
    // dòng gán vai vào DB thay vì đi qua API gán vai.
    const fixtureDb = new Client({ connectionString: process.env.DATABASE_URL });
    await fixtureDb.connect();
    try {
      await fixtureDb.query(
        `insert into role_assignments (role_id, user_id, context_id, component) values ($1, $2, $3, '')`,
        [editingTeacher, teacherBoth.id, courseCtx],
      );
    } finally {
      await fixtureDb.end();
    }
    // Thành viên bị tạm ngưng: vẫn ghi danh nhưng không được hiện ở roster.
    await suspendUser(app, admin, ghost.id);

    const category2 = await createCategory(app, admin);
    const course2 = await createCourse(app, admin, category2.id, { fullName: 'Khoá Roster B' });
    courseB = course2.id;
    const instance2 = await createEnrolInstance(app, admin, courseB);
    await enrolUser(app, admin, courseB, instance2.id, outsider.id);
  });
  afterAll(async () => {
    await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);
    await app.close();
  });

  it('endpoint tìm kiếm people đã biến mất (404)', async () => {
    const res = await http(app).get('/api/v1/messages/people/search?q=Tran')
      .set('Authorization', `Bearer ${actor.token}`);
    expect(res.status).toBe(404);
  });

  it('liệt kê khoá học của tôi theo thành viên (ghi danh hoặc gán vai trò ngữ cảnh khoá học)', async () => {
    const mine = await http(app).get('/api/v1/messages/courses').set('Authorization', `Bearer ${actor.token}`);
    expect(mine.status).toBe(200);
    const ids = (mine.body.courses as { courseId: string }[]).map((c) => c.courseId);
    expect(ids).toContain(courseA);
    expect(ids).not.toContain(courseB);
    // Giáo viên chỉ gán vai (không ghi danh) vẫn thấy khoá là của mình.
    const teacherCourses = await http(app).get('/api/v1/messages/courses').set('Authorization', `Bearer ${teacherRoleOnly.token}`);
    expect((teacherCourses.body.courses as { courseId: string }[]).map((c) => c.courseId)).toContain(courseA);
    const outsiderCourses = await http(app).get('/api/v1/messages/courses').set('Authorization', `Bearer ${outsider.token}`);
    const outsiderIds = (outsiderCourses.body.courses as { courseId: string }[]).map((c) => c.courseId);
    expect(outsiderIds).toContain(courseB);
    expect(outsiderIds).not.toContain(courseA);
  });

  it('roster hiện thành viên khoá học kèm dấu vai trò và đúng whitelist trường; bản thân, người ngoài và thành viên bị đình chỉ bị loại', async () => {
    const res = await roster(actor.token, courseA);
    expect(res.status).toBe(200);
    const members = res.body.members as RosterMember[];
    const byId = new Map(members.map((m) => [m.userId, m]));
    // Giáo viên chỉ gán vai hiện diện với dấu hiệu teacher.
    expect(byId.get(teacherRoleOnly.id)).toMatchObject({
      displayName: 'Giao Vien', username: teacherRoleOnly.username, role: 'teacher', relationship: 'none',
    });
    // Vừa ghi danh vừa gán vai staff: vẫn là teacher, chỉ một dòng.
    expect(members.filter((m) => m.userId === teacherBoth.id)).toHaveLength(1);
    expect(byId.get(teacherBoth.id)?.role).toBe('teacher');
    expect(byId.get(s2.id)).toMatchObject({ displayName: 'Binh Tran', role: 'student', relationship: 'none' });
    expect(byId.get(s3.id)?.role).toBe('student');
    // Loại trừ: chính mình, người ngoài khoá, thành viên bị tạm ngưng.
    expect(byId.has(actor.id)).toBe(false);
    expect(byId.has(outsider.id)).toBe(false);
    expect(members.map((m) => m.displayName)).not.toContain('Ghi Danh');
    // Whitelist trường: đúng 6 khoá, không rò thêm dữ kiện ghi danh/hồ sơ.
    // (canDirectMessage thêm theo ngoại lệ GV–HS chốt 25/10/2026; actor
    // là học sinh nên mọi dòng đều false ở góc nhìn này.)
    for (const m of members) {
      expect(Object.keys(m).sort()).toEqual(['canDirectMessage', 'displayName', 'relationship', 'role', 'userId', 'username']);
      expect(m.canDirectMessage).toBe(false);
    }
    expect(res.body.nextCursor).toBeNull();
  });

  it('người không phải thành viên nhận cùng 404 như khoá không tồn tại (không lộ oracle tồn tại)', async () => {
    const asOutsider = await roster(outsider.token, courseA);
    expect(asOutsider.status).toBe(404);
    expect(asOutsider.body.code).toBe('messaging.course_not_found');
    const missing = await roster(actor.token, '123e4567-e89b-72d3-a456-426614174000');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('messaging.course_not_found');
    expect(missing.body.message).toBe(asOutsider.body.message);
  });

  it('roster phản ánh trạng thái quan hệ và ẩn quan hệ bị chặn cả hai chiều', async () => {
    // pending_outgoing: actor gửi yêu cầu cho s2.
    const out = await http(app).post(`/api/v1/messages/contacts/${s2.id}`)
      .set('Authorization', `Bearer ${actor.token}`).send({});
    expect(out.status).toBe(201);
    // pending_incoming: s3 gửi yêu cầu cho actor.
    const inc = await http(app).post(`/api/v1/messages/contacts/${actor.id}`)
      .set('Authorization', `Bearer ${s3.token}`).send({});
    expect(inc.status).toBe(201);

    const res = await roster(actor.token, courseA);
    const byId = new Map((res.body.members as RosterMember[]).map((m) => [m.userId, m]));
    expect(byId.get(s2.id)?.relationship).toBe('pending_outgoing');
    expect(byId.get(s3.id)?.relationship).toBe('pending_incoming');

    // s3 chặn actor: s3 biến mất khỏi roster của actor (chiều bị chặn),
    // và actor cũng biến mất khỏi roster của s3 (chiều chặn) — cả hai
    // chiều đều giấu theo brief đã chốt.
    const block = await http(app).post(`/api/v1/messages/contacts/${actor.id}/block`)
      .set('Authorization', `Bearer ${s3.token}`).send({});
    expect(block.status).toBe(201);
    const afterBlock = await roster(actor.token, courseA);
    expect((afterBlock.body.members as RosterMember[]).map((m) => m.userId)).not.toContain(s3.id);
    const s3View = await roster(s3.token, courseA);
    expect((s3View.body.members as RosterMember[]).map((m) => m.userId)).not.toContain(actor.id);
  });

  it('học viên có thể kết bạn với giáo viên được gán vai từ roster rồi nhắn tin cho họ', async () => {
    await befriend(actor, teacherRoleOnly);
    const res = await roster(actor.token, courseA);
    const byId = new Map((res.body.members as RosterMember[]).map((m) => [m.userId, m]));
    expect(byId.get(teacherRoleOnly.id)?.relationship).toBe('contact');

    const conv = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${actor.token}`).send({ type: 1, memberIds: [teacherRoleOnly.id] });
    expect(conv.status).toBe(201);
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${actor.token}`).send({ text: 'em chào cô' });
    expect(sent.status).toBe(201);
    const reply = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${teacherRoleOnly.token}`).send({ text: 'cô chào em' });
    expect(reply.status).toBe(201);
  });

  it('tin nhắn trực tiếp chỉ-dành-cho-liên-hệ: khoá chung không mở cổng, messagingallusers không còn mở cổng, xoá liên hệ đóng gửi nhưng lịch sử vẫn đọc được', async () => {
    const gateA = await person('Cong', 'Mot');
    const gateB = await person('Cong', 'Hai');
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id, { fullName: 'Khoá Cổng Liên Hệ' });
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, gateA.id);
    await enrolUser(app, admin, course.id, instance.id, gateB.id);

    // Cùng khoá, chưa kết bạn: tạo conversation 1-1 bị từ chối.
    const blockedCreate = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${gateA.token}`).send({ type: 1, memberIds: [gateB.id] });
    expect(blockedCreate.status).toBe(403);
    expect(blockedCreate.body.code).toBe('messaging.not_a_contact');

    // Công tắc site bật: cổng VẪN đóng (công tắc đã mất hiệu lực với tin nhắn).
    const on = await http(app).put('/api/v1/site-config/core/messagingallusers')
      .set('Authorization', `Bearer ${admin}`).send({ value: true });
    expect(on.status).toBe(200);
    try {
      const stillBlocked = await http(app).post('/api/v1/messages/conversations')
        .set('Authorization', `Bearer ${gateA.token}`).send({ type: 1, memberIds: [gateB.id] });
      expect(stillBlocked.status).toBe(403);
      expect(stillBlocked.body.code).toBe('messaging.not_a_contact');
    } finally {
      await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);
    }

    // Yêu cầu đang chờ vẫn chưa đủ — chấp nhận xong mới mở cổng.
    const req = await http(app).post(`/api/v1/messages/contacts/${gateB.id}`)
      .set('Authorization', `Bearer ${gateA.token}`).send({});
    expect(req.status).toBe(201);
    const pendingCreate = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${gateA.token}`).send({ type: 1, memberIds: [gateB.id] });
    expect(pendingCreate.status).toBe(403);
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${gateA.id}/accept`)
      .set('Authorization', `Bearer ${gateB.token}`).send({});
    expect(acc.status).toBe(201);
    const conv = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${gateA.token}`).send({ type: 1, memberIds: [gateB.id] });
    expect(conv.status).toBe(201);
    const convId = conv.body.id as string;
    const sent = await http(app).post(`/api/v1/messages/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${gateA.token}`).send({ text: 'tin khi đã kết bạn' });
    expect(sent.status).toBe(201);

    // Gỡ liên hệ: gửi mới bị chặn, lịch sử vẫn đọc được.
    const removed = await http(app).delete(`/api/v1/messages/contacts/${gateB.id}`)
      .set('Authorization', `Bearer ${gateA.token}`);
    expect(removed.status).toBe(200);
    const blockedSend = await http(app).post(`/api/v1/messages/conversations/${convId}/messages`)
      .set('Authorization', `Bearer ${gateA.token}`).send({ text: 'tin sau khi gỡ liên hệ' });
    expect(blockedSend.status).toBe(403);
    expect(blockedSend.body.code).toBe('messaging.not_a_contact');
    const history = await http(app).get(`/api/v1/messages/conversations/${convId}`)
      .set('Authorization', `Bearer ${gateA.token}`);
    expect(history.status).toBe(200);
    expect((history.body.messages as { fullMessage: string }[]).map((m) => m.fullMessage)).toContain('tin khi đã kết bạn');
  });

  it('roster phân trang bằng con trỏ theo thứ tự (displayName, username, id) không trùng lặp hay thiếu hụt', async () => {
    const me = await person('Chu', 'Trang');
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id, { fullName: 'Khoá Phân Trang' });
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, me.id);
    const names = ['PageA', 'PageB', 'PageC', 'PageD', 'PageE', 'PageF', 'PageG', 'PageH'];
    for (const firstName of names) {
      const p = await person(firstName, 'Test');
      await enrolUser(app, admin, course.id, instance.id, p.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = cursor ? `?limit=3&cursor=${encodeURIComponent(cursor)}` : '?limit=3';
      const res = await roster(me.token, course.id, q);
      expect(res.status).toBe(200);
      const members = res.body.members as RosterMember[];
      expect(members.length).toBeLessThanOrEqual(3);
      seen.push(...members.map((m) => m.displayName));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(names.map((n) => `${n} Test`));

    // Con trỏ hỏng bị từ chối rõ ràng.
    const bad = await roster(me.token, course.id, '?cursor=khong-phai-con-tro');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('messaging.roster_cursor_invalid');
  });

  it('danh sách trò chuyện và liên hệ vẫn mang tên hiển thị (hồ sơ) sau khi bỏ tìm kiếm', async () => {
    const a = await person('Ten', 'Hien');
    const b = await person('Ten', 'Ban');
    await befriend(a, b);
    const conv = await http(app).post('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${a.token}`).send({ type: 1, memberIds: [b.id] });
    expect(conv.status).toBe(201);
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`)
      .set('Authorization', `Bearer ${b.token}`).send({ text: 'chào bạn' });
    expect(sent.status).toBe(201);

    const contactsRes = await http(app).get('/api/v1/messages/contacts').set('Authorization', `Bearer ${a.token}`);
    expect(contactsRes.body.contacts).toContain(b.id);
    expect(contactsRes.body.profiles[b.id]).toEqual({ userId: b.id, displayName: 'Ten Ban', username: b.username });

    const list = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${a.token}`);
    const entry = (list.body as { id: string; memberProfiles: Record<string, { displayName: string }> }[])
      .find((c) => c.id === conv.body.id);
    expect(entry?.memberProfiles[b.id]?.displayName).toBe('Ten Ban');
    const detail = await http(app).get(`/api/v1/messages/conversations/${conv.body.id}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(detail.body.memberProfiles[b.id]?.displayName).toBe('Ten Ban');
    expect(detail.body.members).toContain(b.id);
  });
});
