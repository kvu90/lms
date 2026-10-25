import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { addGroupMember, contextIdByLevelInstance, createGroupViaApi } from './engagement-helpers';

/**
 * Chat lớp CẤP KHOÁ (việc nối tiếp của issue #33, mở lại 25/10/2026
 * theo comment 6394860125): mỗi khoá có đúng một conversation toàn
 * lớp (type 2, component core_course, itemType 'course'), cấp phát
 * lười idempotent khi thành viên/staff mở; thành viên = ghi danh đang
 * hiệu lực ∪ staff khoá, đồng bộ lười; GV tắt được qua cờ `enabled`
 * (học viên dừng gửi, GV vẫn gửi); người ngoài khoá nhận 404 ở mọi
 * đường — không rò tồn tại của khoá/conversation.
 */

interface Person { id: string; username: string; token: string }

interface CourseConversationBody {
  id: string; type: number; component: string | null; itemType: string | null;
  itemId: string | null; enabled: boolean; createdBy: string | null; members: string[];
}

describe('Messaging — chat lớp cấp khoá (issue #33)', () => {
  let app: INestApplication;
  let admin: string;
  let courseA: string;
  let courseB: string;
  let instanceA: string;
  let teacher: Person;
  let s1: Person;
  let s2: Person;
  let sLate: Person;
  let outsider: Person;
  let studentB: Person;
  let convA: string;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function ensure(token: string, courseId: string) {
    return http(app).get(`/api/v1/messages/courses/${courseId}/conversation`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function send(token: string, conversationId: string, text: string) {
    return http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`).send({ text });
  }

  async function view(token: string, conversationId: string) {
    return http(app).get(`/api/v1/messages/conversations/${conversationId}`)
      .set('Authorization', `Bearer ${token}`);
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);

    // Khoá A: giáo viên phụ trách (editingteacher tại context khoá,
    // đồng thời ghi danh như thông lệ seed) + hai học viên ghi danh.
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    courseA = course.id;
    const instance = await createEnrolInstance(app, admin, courseA);
    instanceA = instance.id;
    teacher = await person();
    s1 = await person();
    s2 = await person();
    for (const p of [teacher, s1, s2]) await enrolUser(app, admin, courseA, instanceA, p.id);
    const courseCtx = await contextIdByLevelInstance(app, admin, 50, courseA);
    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacher.id, editingTeacher, courseCtx);

    // Khoá B độc lập với một học viên riêng — căn cứ kiểm chéo hai khoá.
    const categoryB = await createCategory(app, admin);
    const courseBRes = await createCourse(app, admin, categoryB.id);
    courseB = courseBRes.id;
    const instanceB = await createEnrolInstance(app, admin, courseB);
    studentB = await person();
    await enrolUser(app, admin, courseB, instanceB.id, studentB.id);

    // Học viên ghi danh MUỘN (chưa ghi danh lúc khoá A đã có chat) và
    // một người hoàn toàn ngoài khoá.
    sLate = await person();
    outsider = await person();
  });
  afterAll(async () => { await app.close(); });

  it('1. ensure cấp phát lười idempotent: học viên mở lần đầu tạo đúng một conversation cấp khoá, GV mở lại nhận cùng một conversation', async () => {
    const first = await ensure(s1.token, courseA);
    expect(first.status).toBe(200);
    const body = first.body as CourseConversationBody;
    expect(body.type).toBe(2);
    expect(body.component).toBe('core_course');
    expect(body.itemType).toBe('course');
    expect(body.itemId).toBe(courseA);
    expect(body.enabled).toBe(true);
    // Người tạo bản ghi là học viên mở đầu — nhưng thẩm quyền quản lý
    // vẫn theo staff khoá (kiểm chứng ở test 4).
    expect(body.createdBy).toBe(s1.id);
    for (const p of [teacher, s1, s2]) expect(body.members).toContain(p.id);
    expect(body.members).not.toContain(outsider.id);
    expect(body.members).not.toContain(studentB.id);
    expect(body.members).not.toContain(sLate.id);
    convA = body.id;

    const again = await ensure(teacher.token, courseA);
    expect(again.status).toBe(200);
    expect((again.body as CourseConversationBody).id).toBe(convA);
    const byS2 = await ensure(s2.token, courseA);
    expect((byS2.body as CourseConversationBody).id).toBe(convA);
  });

  it('2. mặc định hai chiều: học viên và GV đều gửi được, thành viên khác đọc được; quyền quản lý chỉ ở GV', async () => {
    const fromStudent = await send(s1.token, convA, 'em chào thầy, đây là chat lớp');
    expect(fromStudent.status).toBe(201);
    const fromTeacher = await send(teacher.token, convA, 'thầy chào cả lớp');
    expect(fromTeacher.status).toBe(201);

    const seenByS2 = await view(s2.token, convA);
    expect(seenByS2.status).toBe(200);
    const texts = (seenByS2.body.messages as { fullMessage: string }[]).map((m) => m.fullMessage);
    expect(texts).toContain('em chào thầy, đây là chat lớp');
    expect(texts).toContain('thầy chào cả lớp');
    expect(seenByS2.body.canManage).toBe(false);

    const seenByTeacher = await view(teacher.token, convA);
    expect(seenByTeacher.body.canManage).toBe(true);
  });

  it('3. người ngoài khoá: 404 ở mọi đường, không phân biệt được khoá có tồn tại hay không', async () => {
    const ensureOut = await ensure(outsider.token, courseA);
    expect(ensureOut.status).toBe(404);
    expect(ensureOut.body.code).toBe('messaging.course_not_found');

    const ensureMissing = await ensure(outsider.token, '00000000-0000-0000-0000-000000000000');
    expect(ensureMissing.status).toBe(404);
    expect(ensureMissing.body.code).toBe('messaging.course_not_found');

    const detail = await view(outsider.token, convA);
    expect(detail.status).toBe(404);
    expect(detail.body.code).toBe('messaging.conversation_not_found');

    const windowRes = await http(app).get(`/api/v1/messages/conversations/${convA}/messages`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(windowRes.status).toBe(404);

    const sendOut = await send(outsider.token, convA, 'người lạ gửi');
    expect(sendOut.status).toBe(404);

    const readOut = await http(app).post(`/api/v1/messages/conversations/${convA}/read`)
      .set('Authorization', `Bearer ${outsider.token}`).send({});
    expect(readOut.status).toBe(404);

    // Học viên khoá B: mở được chat của khoá mình (conversation khác
    // hẳn), nhưng với khoá A vẫn là người ngoài — 404 như trên.
    const ownB = await ensure(studentB.token, courseB);
    expect(ownB.status).toBe(200);
    expect((ownB.body as CourseConversationBody).id).not.toBe(convA);
    expect((ownB.body as CourseConversationBody).members).toContain(studentB.id);
    const crossEnsure = await ensure(studentB.token, courseA);
    expect(crossEnsure.status).toBe(404);
    const crossView = await view(studentB.token, convA);
    expect(crossView.status).toBe(404);
  });

  it('4. GV tắt chat: học viên bị chặn gửi nhưng vẫn đọc được, GV vẫn gửi được; người tạo bản ghi (học viên) không có quyền quản lý', async () => {
    // s1 là người tạo bản ghi conversation (mở đầu ở test 1) nhưng
    // KHÔNG thành người quản lý — PATCH tắt chat bị từ chối.
    const studentToggle = await http(app).patch(`/api/v1/messages/conversations/${convA}`)
      .set('Authorization', `Bearer ${s1.token}`).send({ enabled: false });
    expect(studentToggle.status).toBe(403);
    expect(studentToggle.body.code).toBe('messaging.conversation_manage_forbidden');

    const off = await http(app).patch(`/api/v1/messages/conversations/${convA}`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.enabled).toBe(false);

    const blockedSend = await send(s1.token, convA, 'em gửi khi lớp đã tắt chat');
    expect(blockedSend.status).toBe(403);
    expect(blockedSend.body.code).toBe('messaging.conversation_disabled');

    const teacherSend = await send(teacher.token, convA, 'thông báo một chiều của thầy');
    expect(teacherSend.status).toBe(201);

    // Học viên vẫn ĐỌC được khi chat tắt.
    const stillReadable = await view(s2.token, convA);
    expect(stillReadable.status).toBe(200);
    expect(stillReadable.body.enabled).toBe(false);

    // Bật lại: học viên gửi lại được.
    const on = await http(app).patch(`/api/v1/messages/conversations/${convA}`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ enabled: true });
    expect(on.status).toBe(200);
    const resumed = await send(s2.token, convA, 'lớp bật lại rồi');
    expect(resumed.status).toBe(201);
  });

  it('5. ghi danh muộn vào lớp lười qua đồng bộ; huỷ ghi danh thì mất đọc ở lần đọc/gửi kế', async () => {
    // Chưa ghi danh: ensure bị 404 như người ngoài.
    const before = await ensure(sLate.token, courseA);
    expect(before.status).toBe(404);

    await enrolUser(app, admin, courseA, instanceA, sLate.id);
    const joined = await view(sLate.token, convA);
    expect(joined.status).toBe(200);
    expect(joined.body.members).toContain(sLate.id);
    const canSend = await send(sLate.token, convA, 'em mới vào lớp');
    expect(canSend.status).toBe(201);

    const del = await http(app).delete(`/api/v1/courses/${courseA}/enrol/instances/${instanceA}/users/${sLate.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);

    const lostView = await view(sLate.token, convA);
    expect(lostView.status).toBe(404);
    const lostSend = await send(sLate.token, convA, 'em đã rời lớp');
    expect(lostSend.status).toBe(404);
    const list = await http(app).get('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${sLate.token}`);
    expect((list.body as { id: string }[]).map((c) => c.id)).not.toContain(convA);
  });

  it('6. danh sách Tin nhắn hiện conversation cấp khoá như conversation nhóm; đường group cũ không hồi quy', async () => {
    const mine = await http(app).get('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${s1.token}`);
    const entry = (mine.body as { id: string; itemType: string | null }[]).find((c) => c.id === convA);
    expect(entry).toBeDefined();
    expect(entry!.itemType).toBe('course');

    const listB = await http(app).get('/api/v1/messages/conversations')
      .set('Authorization', `Bearer ${studentB.token}`);
    expect((listB.body as { id: string }[]).map((c) => c.id)).not.toContain(convA);

    // Đường group cũ: tạo group trong khoá A, mở conversation nhóm,
    // gửi tin bình thường.
    const group = await createGroupViaApi(app, admin, courseA, 'Nhóm học tập A');
    for (const p of [s1, s2]) await addGroupMember(app, admin, courseA, group.id, p.id);
    const groupConv = await http(app).post('/api/v1/messages/conversations/group')
      .set('Authorization', `Bearer ${s1.token}`).send({ groupId: group.id });
    expect(groupConv.status).toBe(201);
    expect(groupConv.body.itemType).toBe('groups');
    const groupSend = await send(s2.token, groupConv.body.id as string, 'tin trong nhóm con');
    expect(groupSend.status).toBe(201);
  });

  it('7. đua ensure song song: 6 lượt mở đồng thời của một khoá MỚI chỉ tạo đúng một conversation cấp khoá (khẳng định ở DB)', async () => {
    // Khoá C hoàn toàn mới (chưa ai mở chat) với 5 thành viên ghi danh.
    const categoryC = await createCategory(app, admin);
    const courseCRes = await createCourse(app, admin, categoryC.id);
    const courseC = courseCRes.id;
    const instanceC = await createEnrolInstance(app, admin, courseC);
    const membersC: Person[] = [];
    for (let i = 0; i < 5; i++) {
      const p = await person();
      await enrolUser(app, admin, courseC, instanceC.id, p.id);
      membersC.push(p);
    }

    // 6 lượt ensure bắn ĐỒNG THỜI (luân phiên 5 thành viên): trước
    // bản vá, probe của đội đánh giá trên head a41a216 đo được 4
    // conversation trùng cho cùng một khoá vì find nằm ngoài
    // transaction và insert không có điểm đồng bộ nào.
    const racers = [membersC[0]!, membersC[1]!, membersC[2]!, membersC[3]!, membersC[4]!, membersC[0]!];
    const results = await Promise.all(racers.map((p) => ensure(p.token, courseC)));
    for (const r of results) expect(r.status).toBe(200);
    const ids = new Set(results.map((r) => (r.body as CourseConversationBody).id));
    expect(ids.size).toBe(1);
    for (const r of results) {
      for (const p of membersC) expect((r.body as CourseConversationBody).members).toContain(p.id);
    }

    // Khẳng định ở mức DB — bất biến của lát: mỗi khoá đúng MỘT
    // conversation cấp khoá, không phải chỉ "các response trùng id".
    const pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    try {
      const counted = await pg.query<{ n: number }>(
        `select count(*)::int as n from message_conversations
         where component = 'core_course' and item_type = 'course' and item_id = $1`,
        [courseC],
      );
      expect(counted.rows[0]!.n).toBe(1);
    } finally {
      await pg.end();
    }
  });
});
