import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId } from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';
import { addGroupMember, createGroupViaApi, suspendUser } from '../../support/engagement-helpers';

/**
 * Kiểm thử luồng Messaging + Calendar.
 * Oracle (Moodle MOODLE_503_STABLE, đọc ngày 2026-10-22):
 *  - public/message/tests/api_test.php: test_count_blocked_users,
 *    test_mark_all_read_for_user_touser(_with_fromuser), create_conversation
 *    với các loại individual/group.
 *  - Các bất biến của báo cáo §2#12: message ≠ notification; tin nhắn đã gửi
 *    KHÔNG được SỬA; người dùng bị đình chỉ hoặc đang chặn thì không nhận
 *    được gì; tuỳ chọn gác việc phát theo (provider × channel × loggedin/
 *    loggedoff). Việc XOÁ tuân theo chính sách Lớp B sau này của issue #33
 *    (xoá mềm có để lại vết), chính sách này thay thế tính bất biến tuyệt
 *    đối của §2#12 — xem kiểm thử sửa/xoá bên dưới.
 *  - public/calendar/tests/lib_test.php: test_add_subscription (số lượng
 *    khi nhập ICS), test_get_legacy_events_with_overrides (khả năng hiển thị
 *    theo phạm vi nhóm), test_update_subscription; luật hiển thị của báo cáo §2#13.
 *  - public/calendar/tests/behat/export.feature: người dùng xuất lịch của
 *    mình thành file ICS và qua URL xuất bí mật (calendar key); file/URL
 *    chỉ chứa các sự kiện mà người dùng đó được phép thấy, và việc đặt lại
 *    khoá sẽ vô hiệu hoá URL cũ.
 */
describe('Nhắn tin và lịch', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function twoUsers() {
    const a = await createUserViaApi(app, admin);
    const b = await createUserViaApi(app, admin);
    const aLogin = await login(app, a.username, STRONG_PASSWORD);
    const bLogin = await login(app, b.username, STRONG_PASSWORD);
    return { a, b, aToken: aLogin.accessToken, bToken: bLogin.accessToken };
  }

  /**
   * Hai user thành liên hệ ĐÃ ĐƯỢC DUYỆT của nhau qua luồng yêu cầu–chấp
   * nhận (Lớp B của issue #33 thay danh bạ một chiều): requester gửi yêu
   * cầu, accepter chấp nhận — chỉ khi đó quan hệ mới tồn tại và cổng
   * liên lạc mới mở.
   */
  async function befriend(requester: { id: string; token: string }, accepter: { id: string; token: string }) {
    const req = await http(app).post(`/api/v1/messages/contacts/${accepter.id}`).set('Authorization', `Bearer ${requester.token}`).send({});
    expect(req.status).toBe(201);
    expect(req.body.status).toBe('pending');
    const acc = await http(app).post(`/api/v1/messages/contacts/requests/${requester.id}/accept`).set('Authorization', `Bearer ${accepter.token}`).send({});
    expect(acc.status).toBe(201);
    expect(acc.body.contacts).toContain(requester.id);
  }

  /**
   * Bộ phân tích ICS tối thiểu trong test — cùng quy ước với parser phía
   * worker (apps/worker/src/domain/ics.ts): tách VEVENT, đọc
   * UID/SUMMARY/DESCRIPTION/DTSTART/DTEND dạng UTC, gỡ escape \, và \n.
   * Dùng để chứng minh file export parse lại được (round-trip).
   */
  function parseExportedIcs(text: string) {
    const parseDate = (value: string) => new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}Z`);
    const events: { uid: string; summary: string; description: string; start: Date; end?: Date }[] = [];
    let current: Record<string, string> | null = null;
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
      const line = rawLine.trim();
      if (line === 'BEGIN:VEVENT') { current = {}; continue; }
      if (line === 'END:VEVENT') {
        if (current?.DTSTART) {
          events.push({
            uid: current.UID ?? '', summary: current.SUMMARY ?? '', description: current.DESCRIPTION ?? '',
            start: parseDate(current.DTSTART), end: current.DTEND ? parseDate(current.DTEND) : undefined,
          });
        }
        current = null;
        continue;
      }
      if (!current) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).split(';')[0]!.toUpperCase();
      current[key] = line.slice(colon + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';');
    }
    return events;
  }

  it('trò chuyện: hai người trao đổi tin nhắn; số chưa đọc theo dõi trò chuyện và đọc sẽ xoá chúng (api_test mark_all_read)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    // Cổng liên hệ (mô hình contacts-only): hai người dùng trước hết là
    // liên hệ đã được chấp nhận của nhau (người nhận đã gửi yêu cầu, người gửi đã chấp nhận).
    await befriend({ id: b.id, token: bToken }, { id: a.id, token: aToken });
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(conv.status).toBe(201);
    const conversationId = conv.body.id as string;
    // Tạo lại cùng một cuộc trò chuyện cá nhân sẽ trả về chính cuộc trò chuyện đó.
    const again = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${bToken}`)
      .send({ type: 1, memberIds: [a.id] });
    expect(again.body.id).toBe(conversationId);

    const sent = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Hello from A' });
    expect(sent.status).toBe(201);
    await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Second message' });

    const unreadB = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${bToken}`);
    expect(unreadB.body.conversations).toBe(1);
    const view = await http(app).get(`/api/v1/messages/conversations/${conversationId}`).set('Authorization', `Bearer ${bToken}`);
    expect(view.body.messages).toHaveLength(2);
    expect(view.body.messages[0].fullMessage).toBe('Hello from A');

    await http(app).post(`/api/v1/messages/conversations/${conversationId}/read`).set('Authorization', `Bearer ${bToken}`).send({});
    const after = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${bToken}`);
    expect(after.body.conversations).toBe(0);
    // Người gửi không bao giờ tính tin nhắn của chính mình là chưa đọc.
    const unreadA = await http(app).get('/api/v1/messages/unread-count').set('Authorization', `Bearer ${aToken}`);
    expect(unreadA.body.conversations).toBe(0);
  });

  it('trò chuyện: thành viên nêu trong memberIds lúc tạo là thành viên thật của trò chuyện mới (không bị rơi)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    // Cổng liên hệ (mô hình contacts-only): hai người dùng trước hết là liên hệ đã được chấp nhận của nhau.
    await befriend({ id: b.id, token: bToken }, { id: a.id, token: aToken });
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    expect(conv.status).toBe(201);
    // Chính phản hồi tạo mới liệt kê cả người thực hiện lẫn thành viên được chỉ định.
    expect(conv.body.members).toEqual(expect.arrayContaining([a.id, b.id]));
    // Thành viên được chỉ định có thể mở cuộc trò chuyện (tư cách thành viên được cưỡng chế) và thấy cả hai thành viên.
    const view = await http(app).get(`/api/v1/messages/conversations/${conv.body.id}`).set('Authorization', `Bearer ${bToken}`);
    expect(view.status).toBe(200);
    expect(view.body.members).toEqual(expect.arrayContaining([a.id, b.id]));
    // Và cuộc trò chuyện xuất hiện trong danh sách của chính thành viên được chỉ định, kèm cả hai thành viên.
    const list = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${bToken}`);
    const mine = (list.body as { id: string; members: string[] }[]).find((c) => c.id === conv.body.id);
    expect(mine).toBeDefined();
    expect(mine!.members).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('tin nhắn đã gửi không thể SỬA; xoá tuân theo vòng đời vai trò — xoá-cho-tôi ẩn nó chỉ với tác giả, thu hồi vô hiệu nó với mọi người (bổ sung PR #94)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    // Cổng liên hệ: hai người dùng là liên hệ đã được chấp nhận nên chính thao tác gửi thành công.
    await befriend({ id: b.id, token: bToken }, { id: a.id, token: aToken });
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Words I regret' });
    const messageId = sent.body.id as string;
    // Việc sửa vẫn bị từ chối — vòng đời chỉ điều tiết việc xoá/thu hồi.
    const patch = await http(app).patch(`/api/v1/messages/${messageId}`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Edited!' });
    expect(patch.status).toBe(403);
    expect(patch.body.code).toBe('messaging.message_immutable');
    // DELETE nay là DELETE-FOR-ME (vòng đời theo vai, lớp (a)): dòng
    // KHÔNG bị đánh dấu đã xoá — chỉ một cờ theo từng người dùng ẩn nó khỏi
    // người viết. Phản hồi là dòng nguyên vẹn chưa bị đụng tới.
    const del = await http(app).delete(`/api/v1/messages/${messageId}`).set('Authorization', `Bearer ${aToken}`);
    expect(del.status).toBe(200);
    expect(del.body.id).toBe(messageId);
    expect(del.body.deletedAt).toBeNull();
    expect(del.body.deletedBy).toBeNull();
    expect(del.body.fullMessage).toBe('Words I regret');
    // NGƯỜI VIẾT ngừng nhìn thấy nó…
    const viewA = await http(app).get(`/api/v1/messages/conversations/${conv.body.id}`).set('Authorization', `Bearer ${aToken}`);
    expect((viewA.body.messages as { id: string }[]).map((m) => m.id)).not.toContain(messageId);
    // …nhưng NGƯỜI NHẬN vẫn thấy nó đầy đủ: delete-for-me không bao giờ
    // rò rỉ sang phía bên kia (đó là việc của thu hồi).
    const viewB = await http(app).get(`/api/v1/messages/conversations/${conv.body.id}`).set('Authorization', `Bearer ${bToken}`);
    const forB = (viewB.body.messages as { id: string; fullMessage: string }[]).find((m) => m.id === messageId);
    expect(forB?.fullMessage).toBe('Words I regret');
    // RECALL (lớp (b), vẫn nằm trong cửa sổ mặc định 15 phút)
    // vô hiệu hoá nội dung đối với người nhận: dòng vẫn ở lại dưới dạng
    // phần giữ chỗ kèm vết thu hồi, nội dung của nó bị xoá trắng.
    const recall = await http(app).post(`/api/v1/messages/${messageId}/recall`).set('Authorization', `Bearer ${aToken}`).send({});
    expect(recall.status).toBe(201);
    expect(recall.body.recalledBy).toBe(a.id);
    const viewBAfter = await http(app).get(`/api/v1/messages/conversations/${conv.body.id}`).set('Authorization', `Bearer ${bToken}`);
    const recalledForB = (viewBAfter.body.messages as { id: string; fullMessage: string; recalledAt: string | null }[])
      .find((m) => m.id === messageId);
    expect(recalledForB).toBeDefined();
    expect(recalledForB!.fullMessage).toBe('');
    expect(recalledForB!.recalledAt).toBeTruthy();
  });

  it('liên hệ bị chặn không thể gửi: danh sách chặn của người nhận dừng phân phối (api_test test_count_blocked_users)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    // Cổng liên hệ: hai người dùng là liên hệ đã được chấp nhận; danh sách chặn là một luật riêng, mạnh hơn, được kiểm tra trước tại thời điểm gửi.
    await befriend({ id: b.id, token: bToken }, { id: a.id, token: aToken });
    const blocked = await http(app).post(`/api/v1/messages/contacts/${a.id}/block`).set('Authorization', `Bearer ${bToken}`).send({});
    expect(blocked.body.blocked).toContain(a.id);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'You should not get this' });
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('messaging.contact_blocked');
    // Bỏ chặn khôi phục việc gửi.
    await http(app).delete(`/api/v1/messages/contacts/${a.id}/block`).set('Authorization', `Bearer ${bToken}`);
    const ok = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Now it works' });
    expect(ok.status).toBe(201);
  });

  it('người nhận bị đình chỉ không nhận cả tin nhắn lẫn thông báo (§2#12 DoD)', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    // Cổng liên hệ: hai người dùng trở thành liên hệ đã được chấp nhận trước khi bị đình chỉ, nên luật đình chỉ là thứ chặn việc gửi.
    await befriend({ id: b.id, token: bToken }, { id: a.id, token: aToken });
    await suspendUser(app, admin, b.id);
    const conv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${aToken}`)
      .send({ type: 1, memberIds: [b.id] });
    const sent = await http(app).post(`/api/v1/messages/conversations/${conv.body.id}/messages`).set('Authorization', `Bearer ${aToken}`)
      .send({ text: 'Anyone there?' });
    expect(sent.status).toBe(403);
    expect(sent.body.code).toBe('messaging.recipient_suspended');

    const notify = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: b.id, provider: 'grade_updated', subject: 'Grade posted', body: 'Your grade is in' });
    expect(notify.status).toBe(201);
    expect(notify.body.skipped).toBe('suspended');
    expect(notify.body.notificationId).toBeNull();
    const bLogin = await login(app, a.username, STRONG_PASSWORD).catch(() => null);
    void bLogin;
    const listAsAdmin = await http(app).get('/api/v1/notifications/dispatch-log').set('Authorization', `Bearer ${admin}`);
    void listAsAdmin;
  });

  it('thông báo: phân phối provider tôn trọng tuỳ chọn (provider × kênh × loggedin); tắt popup không lưu gì (DoD)', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    // NB-7: đặt tuỳ chọn theo loại qua API chỉ còn cho nhân sự — ca
    // kiểm này nhắm cơ chế phát theo tuỳ chọn nên fixture mang vai
    // teacher ở context hệ thống; phần chặn học sinh có spec riêng.
    await assignRole(app, admin, user.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    // Mốc cơ sở: tuỳ chọn mặc định phát thông báo trong ứng dụng.
    const first = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: user.id, provider: 'badge_awarded', subject: 'Badge!', body: 'You earned a badge' });
    expect(first.body.channels.popup).toBe('delivered');
    expect(first.body.channels.email).toBe('queued');
    let list = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${accessToken}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].eventType).toBe('badge_awarded');
    // Thông báo KHÔNG phải tin nhắn: không cuộc trò chuyện nào được tạo.
    const convs = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${accessToken}`);
    expect(convs.body).toHaveLength(0);

    // Tắt popup cho badge_awarded (mô hình v2, NB-2): không có gì được
    // lưu, nhật ký phát ghi lại việc chặn này, email vẫn nằm trong hàng đợi.
    const pref = await http(app).put('/api/v1/messages/preferences').set('Authorization', `Bearer ${accessToken}`)
      .send({ provider: 'badge_awarded', popupEnabled: false });
    expect(pref.status).toBe(200);
    const second = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: user.id, provider: 'badge_awarded', subject: 'Badge 2', body: 'Another badge' });
    expect(second.body.channels.popup).toBe('skipped-preference');
    expect(second.body.channels.email).toBe('queued');
    list = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${accessToken}`);
    expect(list.body.items).toHaveLength(1);
    const log = await http(app).get('/api/v1/notifications/dispatch-log').set('Authorization', `Bearer ${accessToken}`);
    const entries = log.body as { provider: string; channel: string; status: string }[];
    expect(entries.some((e) => e.provider === 'badge_awarded' && e.channel === 'popup' && e.status === 'delivered')).toBe(true);
    expect(entries.some((e) => e.provider === 'badge_awarded' && e.channel === 'popup' && e.status === 'skipped-preference')).toBe(true);

    // Luồng đọc: số chưa đọc giảm sau thao tác mark-read.
    const unread = await http(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${accessToken}`);
    expect(unread.body.unread).toBe(1);
    await http(app).post('/api/v1/notifications/mark-read').set('Authorization', `Bearer ${accessToken}`).send({ scope: 'all' });
    const after = await http(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${accessToken}`);
    expect(after.body.unread).toBe(0);
    // Danh sách tuỳ chọn phản ánh đúng trạng thái bật/tắt.
    const prefs = await http(app).get('/api/v1/messages/preferences').set('Authorization', `Bearer ${accessToken}`);
    const popupPref = (prefs.body as { provider: string; popupEnabled: boolean }[])
      .find((p) => p.provider === 'badge_awarded');
    expect(popupPref?.popupEnabled).toBe(false);
  });

  it('hiển thị lịch: sự kiện site cho mọi người, sự kiện user chỉ chủ sở hữu, sự kiện khoá chỉ người đã ghi danh, sự kiện danh mục cho học viên của danh mục', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    const outsider = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const soon = new Date(Date.now() + 3600_000).toISOString();

    const site = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Site day', eventType: 'site', timeStart: soon });
    expect(site.status).toBe(201);
    const courseEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Course lecture', eventType: 'course', courseId: course.id, timeStart: soon });
    expect(courseEv.status).toBe(201);
    const catEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Category fair', eventType: 'category', categoryId: category.id, timeStart: soon });
    expect(catEv.status).toBe(201);
    const userEv = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${studentToken}`)
      .send({ name: 'My dentist', eventType: 'user', timeStart: soon });
    expect(userEv.status).toBe(201);

    const names = async (token: string) => {
      const res = await http(app).get('/api/v1/calendar/events').set('Authorization', `Bearer ${token}`);
      return (res.body as { name: string }[]).map((e) => e.name);
    };
    const studentNames = await names(studentToken);
    expect(studentNames).toContain('Site day');
    expect(studentNames).toContain('Course lecture');
    expect(studentNames).toContain('Category fair');
    expect(studentNames).toContain('My dentist');
    const outsiderNames = await names(outsiderToken);
    expect(outsiderNames).toContain('Site day');
    expect(outsiderNames).not.toContain('Course lecture');
    expect(outsiderNames).not.toContain('Category fair');
    expect(outsiderNames).not.toContain('My dentist');
  });

  it('sự kiện nhóm trên lịch chỉ hiện với thành viên nhóm (và staff) của khoá học (DoD)', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const member = await createUserViaApi(app, admin);
    const nonMember = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, member.id);
    await enrolUser(app, admin, course.id, instance.id, nonMember.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Team Alpha');
    await addGroupMember(app, admin, course.id, group.id, member.id);
    const soon = new Date(Date.now() + 3600_000).toISOString();
    const ev = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Alpha standup', eventType: 'group', courseId: course.id, groupId: group.id, timeStart: soon });
    expect(ev.status).toBe(201);

    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const nonMemberToken = (await login(app, nonMember.username, STRONG_PASSWORD)).accessToken;
    const forMember = await http(app).get('/api/v1/calendar/events').query({ eventType: 'group' }).set('Authorization', `Bearer ${memberToken}`);
    expect((forMember.body as { name: string }[]).map((e) => e.name)).toContain('Alpha standup');
    const forNonMember = await http(app).get('/api/v1/calendar/events').query({ eventType: 'group' }).set('Authorization', `Bearer ${nonMemberToken}`);
    expect((forNonMember.body as { name: string }[]).map((e) => e.name)).not.toContain('Alpha standup');
  });

  it('chuỗi lịch: lặp hàng tuần tạo một chuỗi; ngoại lệ thay thế lần xuất hiện của nó trong danh sách', async () => {
    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const start = new Date(Date.now() + 86400_000);
    const created = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Weekly yoga', eventType: 'user', timeStart: start.toISOString(), repeat: { freq: 'WEEKLY', count: 3 } });
    expect(created.status).toBe(201);
    expect(created.body.occurrences).toHaveLength(3);
    const root = created.body.event as { id: string; rrule: string; repeatId: string };
    expect(root.rrule).toContain('FREQ=WEEKLY');
    expect(root.repeatId).toBe(root.id);
    const secondOccurrence = created.body.occurrences[1] as { id: string; timeStart: string };

    const moved = new Date(new Date(secondOccurrence.timeStart).getTime() + 7200_000).toISOString();
    const exception = await http(app).post(`/api/v1/calendar/events/${secondOccurrence.id}/exception`).set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Yoga (moved)', timeStart: moved });
    expect(exception.status).toBe(201);
    expect(exception.body.isException).toBe(true);

    const list = await http(app).get('/api/v1/calendar/events').query({ eventType: 'user' }).set('Authorization', `Bearer ${accessToken}`);
    const names = (list.body as { name: string }[]).map((e) => e.name);
    expect(names.filter((n) => n === 'Weekly yoga')).toHaveLength(2); // lần xuất hiện 1 và 3
    expect(names).toContain('Yoga (moved)');
    // Xoá nút gốc sẽ xoá toàn bộ chuỗi.
    const del = await http(app).delete(`/api/v1/calendar/events/${root.id}`).set('Authorization', `Bearer ${accessToken}`);
    expect(del.body.seriesDeleted).toBe(4); // 3 lần xuất hiện + 1 ngoại lệ
  });

  it('đăng ký lịch: tạo một đăng ký xếp hàng nhập ICS; nhắc nhở có thể lên lịch cho sự kiện nhìn thấy được', async () => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:sub-test-1@lms',
      'SUMMARY:Imported keynote', 'DTSTART:20270105T090000Z', 'DTEND:20270105T100000Z',
      'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const sub = await http(app).post('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Conf feed', eventType: 'site', icsData: ics });
    expect(sub.status).toBe(201);
    const subs = await http(app).get('/api/v1/calendar/subscriptions').set('Authorization', `Bearer ${admin}`);
    expect((subs.body as { name: string }[]).some((s) => s.name === 'Conf feed')).toBe(true);

    const user = await createUserViaApi(app, admin);
    const { accessToken } = await login(app, user.username, STRONG_PASSWORD);
    const ev = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Deadline', eventType: 'user', timeStart: new Date(Date.now() + 7200_000).toISOString() });
    const remind = await http(app).post(`/api/v1/calendar/events/${ev.body.event.id}/remind`).set('Authorization', `Bearer ${accessToken}`)
      .send({ minutesBefore: 30 });
    expect(remind.status).toBe(201);
    expect(remind.body.delayMs).toBeGreaterThan(0);
    // Người lạ không thể tự nhắc mình về sự kiện riêng tư của người khác.
    const stranger = await createUserViaApi(app, admin);
    const strangerToken = (await login(app, stranger.username, STRONG_PASSWORD)).accessToken;
    const forbidden = await http(app).post(`/api/v1/calendar/events/${ev.body.event.id}/remind`).set('Authorization', `Bearer ${strangerToken}`)
      .send({ minutesBefore: 30 });
    expect(forbidden.status).toBe(403);
  });

  it('xuất lịch (tải ICS): chỉ sự kiện người xuất được thấy, trong VCALENDAR phân tích được (behat/export.feature)', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const member = await createUserViaApi(app, admin);
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, member.id);
    await enrolUser(app, admin, course.id, instance.id, other.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Export Team');
    await addGroupMember(app, admin, course.id, group.id, member.id);
    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const otherToken = (await login(app, other.username, STRONG_PASSWORD)).accessToken;
    const soon = new Date(Date.now() + 3600_000);
    const soonIso = soon.toISOString();

    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Export site day', eventType: 'site', timeStart: soonIso });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Export course lecture', eventType: 'course', courseId: course.id, timeStart: soonIso });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Export alpha standup', eventType: 'group', courseId: course.id, groupId: group.id, timeStart: soonIso });
    const dentist = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Export my dentist', eventType: 'user', timeStart: soonIso, timeDuration: 3600, description: 'Checkup, cleaning', location: 'Clinic' });
    expect(dentist.status).toBe(201);
    const dentistId = dentist.body.event.id as string;
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${otherToken}`)
      .send({ name: 'Export B secret plan', eventType: 'user', timeStart: soonIso });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Export later event', eventType: 'user', timeStart: new Date(Date.now() + 30 * 86400_000).toISOString() });
    const series = await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Export weekly series', eventType: 'user', timeStart: new Date(Date.now() + 1800_000).toISOString(), repeat: { freq: 'WEEKLY', count: 2 } });
    expect(series.status).toBe(201);

    // Việc tải xuống yêu cầu đăng nhập.
    const anonymous = await http(app).get('/api/v1/calendar/exports?format=ics');
    expect(anonymous.status).toBe(401);

    const download = await http(app).get('/api/v1/calendar/exports?format=ics').set('Authorization', `Bearer ${memberToken}`);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('text/calendar');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['content-disposition']).toContain('.ics');
    expect(download.text).toContain('BEGIN:VCALENDAR');
    expect(download.text).toContain('VERSION:2.0');
    expect(download.text).toContain('END:VCALENDAR');

    // Phân tích khứ hồi (round-trip) qua bộ phân tích ICS theo quy ước của parser phía worker.
    const parsed = parseExportedIcs(download.text);
    const summaries = parsed.map((e) => e.summary);
    expect(summaries).toContain('Export site day');
    expect(summaries).toContain('Export course lecture');
    expect(summaries).toContain('Export alpha standup');
    expect(summaries).toContain('Export my dentist');
    expect(summaries).toContain('Export later event');
    // Sự kiện riêng tư của người dùng khác không bao giờ rò rỉ vào bản xuất của tôi.
    expect(summaries).not.toContain('Export B secret plan');
    // Chuỗi được xuất dưới dạng các lần xuất hiện đã vật chất hoá của nó, mỗi lần một VEVENT.
    expect(summaries.filter((n) => n === 'Export weekly series')).toHaveLength(2);
    // UID ổn định theo từng id sự kiện; DTEND = DTSTART + timeDuration.
    const dentistParsed = parsed.find((e) => e.summary === 'Export my dentist')!;
    expect(dentistParsed.uid).toBe(`${dentistId}@lms`);
    expect(dentistParsed.start.getTime()).toBe(Math.floor(soon.getTime() / 1000) * 1000);
    expect(dentistParsed.end!.getTime() - dentistParsed.start.getTime()).toBe(3600_000);
    expect(dentistParsed.description).toBe('Checkup, cleaning');
    expect(download.text).toContain('DTSTAMP:');

    // Người dùng đã ghi danh còn lại: thấy sự kiện site/course + sự kiện riêng tư của mình, nhưng
    // KHÔNG thấy sự kiện nhóm (không phải thành viên) và KHÔNG thấy sự kiện riêng tư của thành viên kia.
    const otherDownload = await http(app).get('/api/v1/calendar/exports?format=ics').set('Authorization', `Bearer ${otherToken}`);
    const otherSummaries = parseExportedIcs(otherDownload.text).map((e) => e.summary);
    expect(otherSummaries).toContain('Export site day');
    expect(otherSummaries).toContain('Export course lecture');
    expect(otherSummaries).toContain('Export B secret plan');
    expect(otherSummaries).not.toContain('Export alpha standup');
    expect(otherSummaries).not.toContain('Export my dentist');
    expect(otherSummaries).not.toContain('Export later event');

    // Truy vấn from/to thu hẹp bản xuất đúng như danh sách.
    const ranged = await http(app).get('/api/v1/calendar/exports?format=ics')
      .query({ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 2 * 3600_000).toISOString() })
      .set('Authorization', `Bearer ${memberToken}`);
    const rangedSummaries = parseExportedIcs(ranged.text).map((e) => e.summary);
    expect(rangedSummaries).toContain('Export my dentist');
    expect(rangedSummaries).not.toContain('Export later event');
    expect(rangedSummaries.filter((n) => n === 'Export weekly series')).toHaveLength(1);
  });

  it('URL xuất lịch: token bí mật mỗi người tải được mà không cần đăng nhập; xoay hoặc thu hồi nó huỷ URL cũ (behat/export.feature)', async () => {
    const { aToken, bToken } = await twoUsers();
    const soon = new Date(Date.now() + 3600_000).toISOString();
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${aToken}`)
      .send({ name: 'Token export A private', eventType: 'user', timeStart: soon });
    await http(app).post('/api/v1/calendar/events').set('Authorization', `Bearer ${bToken}`)
      .send({ name: 'Token export B private', eventType: 'user', timeStart: soon });

    // Việc tạo token yêu cầu đăng nhập; endpoint trạng thái khởi đầu trống.
    const anonymousCreate = await http(app).post('/api/v1/calendar/export-token').send({});
    expect(anonymousCreate.status).toBe(401);
    const before = await http(app).get('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(before.body.hasToken).toBe(false);

    const created = await http(app).post('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`).send({});
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    // Một token ngẫu nhiên dài — không bao giờ là UUID, không bao giờ là id của chính người dùng.
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(created.body.exportUrl).toBe(`/api/v1/calendar/export/${token}.ics`);

    // Token (hoặc hàm băm của nó) không bao giờ xuất hiện trong bất kỳ phản hồi nào khác.
    const status = await http(app).get('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(status.body.hasToken).toBe(true);
    expect(JSON.stringify(status.body)).not.toContain(token);
    const listing = await http(app).get('/api/v1/calendar/events').set('Authorization', `Bearer ${aToken}`);
    expect(JSON.stringify(listing.body)).not.toContain(token);

    // URL công khai hoạt động mà không cần header Authorization nào cả và chỉ mang
    // các sự kiện mà chủ token được phép thấy.
    const viaUrl = await http(app).get(created.body.exportUrl as string);
    expect(viaUrl.status).toBe(200);
    expect(viaUrl.headers['content-type']).toContain('text/calendar');
    const viaSummaries = parseExportedIcs(viaUrl.text).map((e) => e.summary);
    expect(viaSummaries).toContain('Token export A private');
    expect(viaSummaries).not.toContain('Token export B private');

    // Token đúng định dạng nhưng không tồn tại bị từ chối.
    const unknown = await http(app).get(`/api/v1/calendar/export/${'0'.repeat(64)}.ics`);
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('calendar.export_token_invalid');

    // Xoay token sẽ vô hiệu hoá URL cũ ngay lập tức; URL mới hoạt động.
    const rotated = await http(app).post('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`).send({});
    expect(rotated.status).toBe(201);
    const newToken = rotated.body.token as string;
    expect(newToken).not.toBe(token);
    const oldUrl = await http(app).get(created.body.exportUrl as string);
    expect(oldUrl.status).toBe(401);
    expect(oldUrl.body.code).toBe('calendar.export_token_invalid');
    const newUrl = await http(app).get(rotated.body.exportUrl as string);
    expect(newUrl.status).toBe(200);
    expect(parseExportedIcs(newUrl.text).map((e) => e.summary)).toContain('Token export A private');

    // Thu hồi cũng vô hiệu hoá URL hiện tại, và trạng thái phản ánh điều đó.
    const revoked = await http(app).delete('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(revoked.body.revoked).toBe(true);
    const afterRevoke = await http(app).get(rotated.body.exportUrl as string);
    expect(afterRevoke.status).toBe(401);
    const afterStatus = await http(app).get('/api/v1/calendar/export-token').set('Authorization', `Bearer ${aToken}`);
    expect(afterStatus.body.hasToken).toBe(false);
  });

  it('contacts: request–accept flow replaces the one-way address book (Lớp B); requesting yourself is refused and unknown users are 404', async () => {
    const { a, b, aToken, bToken } = await twoUsers();
    const self = await http(app).post(`/api/v1/messages/contacts/${a.id}`).set('Authorization', `Bearer ${aToken}`).send({});
    expect(self.status).toBe(400);
    expect(self.body.code).toBe('messaging.contact_self');
    const unknown = await http(app).post('/api/v1/messages/contacts/123e4567-e89b-72d3-a456-426614174000').set('Authorization', `Bearer ${aToken}`).send({});
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('user.not_found');

    // Gửi yêu cầu CHƯA tạo liên hệ — thao tác này chỉ đưa vào hàng đợi.
    const requested = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${aToken}`).send({});
    expect(requested.status).toBe(201);
    expect(requested.body.status).toBe('pending');
    expect(requested.body.contacts).toEqual([]);
    const listBefore = await http(app).get('/api/v1/messages/contacts').set('Authorization', `Bearer ${aToken}`);
    expect(listBefore.body.contacts).toEqual([]);
    // Yêu cầu hiển thị ở cả hai phía của hàng đợi.
    const bQueue = await http(app).get('/api/v1/messages/contacts/requests').set('Authorization', `Bearer ${bToken}`);
    expect((bQueue.body.incoming as { userId: string }[]).map((r) => r.userId)).toEqual([a.id]);
    expect(bQueue.body.outgoing).toEqual([]);
    const aQueue = await http(app).get('/api/v1/messages/contacts/requests').set('Authorization', `Bearer ${aToken}`);
    expect((aQueue.body.outgoing as { userId: string }[]).map((r) => r.userId)).toEqual([b.id]);
    // Gửi yêu cầu hai lần vẫn giữ tính lũy đẳng (idempotent): vẫn chỉ một yêu cầu đang chờ.
    const again = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${aToken}`).send({});
    expect(again.body.status).toBe('pending');
    const bQueue2 = await http(app).get('/api/v1/messages/contacts/requests').set('Authorization', `Bearer ${bToken}`);
    expect(bQueue2.body.incoming).toHaveLength(1);

    // Chấp nhận tạo quan hệ ở CẢ HAI phía và rút cạn hàng đợi.
    const accepted = await http(app).post(`/api/v1/messages/contacts/requests/${a.id}/accept`).set('Authorization', `Bearer ${bToken}`).send({});
    expect(accepted.status).toBe(201);
    expect(accepted.body.contacts).toEqual([a.id]);
    const aList = await http(app).get('/api/v1/messages/contacts').set('Authorization', `Bearer ${aToken}`);
    expect(aList.body.contacts).toEqual([b.id]);
    const bQueueAfter = await http(app).get('/api/v1/messages/contacts/requests').set('Authorization', `Bearer ${bToken}`);
    expect(bQueueAfter.body.incoming).toEqual([]);
    // Gửi yêu cầu tới một liên hệ đã tồn tại là thao tác không đổi (no-op) có tính lũy đẳng.
    const noop = await http(app).post(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${aToken}`).send({});
    expect(noop.body.status).toBe('accepted');
    expect(noop.body.contacts).toEqual([b.id]);

    // Xoá liên hệ phá bỏ quan hệ ở CẢ HAI phía.
    const removed = await http(app).delete(`/api/v1/messages/contacts/${b.id}`).set('Authorization', `Bearer ${aToken}`);
    expect(removed.body.contacts).toEqual([]);
    const bList = await http(app).get('/api/v1/messages/contacts').set('Authorization', `Bearer ${bToken}`);
    expect(bList.body.contacts).toEqual([]);
  });

  it('cổng liên hệ (mô hình chốt lại 24/10/2026 tại issue #33): tin nhắn trực tiếp chỉ-dành-cho-liên-hệ — khoá chung không còn mở cổng và messagingallusers không còn tác dụng với nhắn tin', async () => {
    // Bắt đầu từ giá trị mặc định đã đăng ký, bất kể các lượt chạy trước để lại gì.
    await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);

    // 1. Người lạ: việc tạo cuộc trò chuyện cá nhân mới bị từ chối 403.
    const strangers = await twoUsers();
    const blockedCreate = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${strangers.aToken}`)
      .send({ type: 1, memberIds: [strangers.b.id] });
    expect(blockedCreate.status).toBe(403);
    expect(blockedCreate.body.code).toBe('messaging.not_a_contact');

    // 2. Chung khoá học: cả hai đều đang ghi danh tích cực trong cùng một khoá — cổng
    //    VẪN đóng (đường bạn cùng khoá cũ đã bị loại bỏ bởi mô hình
    //    được quyết lại; bạn cùng khoá kết bạn với nhau qua danh sách lớp).
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    await enrolUser(app, admin, course.id, instance.id, strangers.a.id);
    await enrolUser(app, admin, course.id, instance.id, strangers.b.id);
    const courseBlocked = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${strangers.aToken}`)
      .send({ type: 1, memberIds: [strangers.b.id] });
    expect(courseBlocked.status).toBe(403);
    expect(courseBlocked.body.code).toBe('messaging.not_a_contact');

    // 3. Liên hệ (request–accept): một yêu cầu ĐANG CHỜ từ người gửi là
    //    chưa đủ — cổng chỉ mở khi quan hệ đã được chấp nhận.
    //    Ở đây người nhận đáp lại bằng một yêu cầu của chính mình, yêu cầu này
    //    chấp nhận yêu cầu đang chờ (đồng thuận hai phía).
    const pair = await twoUsers();
    const senderRequests = await http(app).post(`/api/v1/messages/contacts/${pair.b.id}`).set('Authorization', `Bearer ${pair.aToken}`).send({});
    expect(senderRequests.status).toBe(201);
    expect(senderRequests.body.status).toBe('pending');
    const stillBlocked = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${pair.aToken}`)
      .send({ type: 1, memberIds: [pair.b.id] });
    expect(stillBlocked.status).toBe(403);
    expect(stillBlocked.body.code).toBe('messaging.not_a_contact');
    const recipientAnswers = await http(app).post(`/api/v1/messages/contacts/${pair.a.id}`).set('Authorization', `Bearer ${pair.bToken}`).send({});
    expect(recipientAnswers.body.status).toBe('accepted');
    const contactConv = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${pair.aToken}`)
      .send({ type: 1, memberIds: [pair.b.id] });
    expect(contactConv.status).toBe(201);
    const contactSent = await http(app).post(`/api/v1/messages/conversations/${contactConv.body.id}/messages`).set('Authorization', `Bearer ${pair.aToken}`)
      .send({ text: 'Hello contact' });
    expect(contactSent.status).toBe(201);

    // 4. messagingallusers = true (admin qua API site-config): thiết
    //    lập này nay KHÔNG còn tác dụng với nhắn tin — người lạ vẫn bị
    //    từ chối, đúng như khi nó tắt. (Mục trong registry vẫn ở lại;
    //    không cổng nhắn tin nào đọc nó nữa.)
    const on = await http(app).put('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`).send({ value: true });
    expect(on.status).toBe(200);
    expect(on.body.value).toBe(true);
    const open = await twoUsers();
    const openBlocked = await http(app).post('/api/v1/messages/conversations').set('Authorization', `Bearer ${open.aToken}`)
      .send({ type: 1, memberIds: [open.b.id] });
    expect(openBlocked.status).toBe(403);
    expect(openBlocked.body.code).toBe('messaging.not_a_contact');

    // 5. Xoá liên hệ đóng cổng cả trên cuộc trò chuyện ĐANG TỒN TẠI
    //    nữa: lịch sử vẫn đọc được, các lần gửi mới bị
    //    từ chối (cổng được kiểm tra ở mọi lần gửi — không có ngoại lệ bảo lưu).
    const removed = await http(app).delete(`/api/v1/messages/contacts/${pair.b.id}`).set('Authorization', `Bearer ${pair.aToken}`);
    expect(removed.status).toBe(200);
    const sendAgain = await http(app).post(`/api/v1/messages/conversations/${contactConv.body.id}/messages`).set('Authorization', `Bearer ${pair.aToken}`)
      .send({ text: 'Still there?' });
    expect(sendAgain.status).toBe(403);
    expect(sendAgain.body.code).toBe('messaging.not_a_contact');
    const history = await http(app).get(`/api/v1/messages/conversations/${contactConv.body.id}`).set('Authorization', `Bearer ${pair.aToken}`);
    expect(history.status).toBe(200);
    expect((history.body.messages as { fullMessage: string }[]).map((m) => m.fullMessage)).toContain('Hello contact');

    // Thông báo hệ thống KHÔNG bị gác cổng: thông báo của admin vẫn
    // tới được người lạ trong khi cổng đang bật.
    const fresh = await twoUsers();
    const notify = await http(app).post('/api/v1/notifications/send').set('Authorization', `Bearer ${admin}`)
      .send({ userId: fresh.b.id, provider: 'grade_updated', subject: 'Grade posted', body: 'Your grade is in' });
    expect(notify.status).toBe(201);
    expect(notify.body.notificationId).not.toBeNull();

    // Không để lại ghi đè nào đã lưu: cơ sở dữ liệu kiểm thử dùng chung phải trở về
    // giá trị mặc định đã đăng ký (tắt, source 'default') cho các suite khác.
    const cleared = await http(app).delete('/api/v1/site-config/core/messagingallusers').set('Authorization', `Bearer ${admin}`);
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ value: false, source: 'default' });
  });

  it('đồng bộ trò chuyện nhóm: thành viên phản chiếu nhóm khoá học một cách lười — người vào hiện khi mở/liệt kê, người ra biến mất, tin nhắn còn lại (behat group conversation sync)', async () => {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const m1 = await createUserViaApi(app, admin);
    const m2 = await createUserViaApi(app, admin);
    const m3 = await createUserViaApi(app, admin);
    for (const m of [m1, m2, m3]) await enrolUser(app, admin, course.id, instance.id, m.id);
    const group = await createGroupViaApi(app, admin, course.id, 'Sync Team');
    await addGroupMember(app, admin, course.id, group.id, m1.id);
    await addGroupMember(app, admin, course.id, group.id, m2.id);
    const m1Token = (await login(app, m1.username, STRONG_PASSWORD)).accessToken;
    const m2Token = (await login(app, m2.username, STRONG_PASSWORD)).accessToken;
    const m3Token = (await login(app, m3.username, STRONG_PASSWORD)).accessToken;

    // Nhóm không tồn tại → 404.
    const noGroup = await http(app).post('/api/v1/messages/conversations/group').set('Authorization', `Bearer ${admin}`)
      .send({ groupId: '123e4567-e89b-72d3-a456-426614174000' });
    expect(noGroup.status).toBe(404);
    expect(noGroup.body.code).toBe('messaging.group_not_found');
    // Người đã ghi danh nhưng không phải thành viên và không phải nhân sự khoá học thì không tạo được.
    const outsider = await http(app).post('/api/v1/messages/conversations/group').set('Authorization', `Bearer ${m3Token}`)
      .send({ groupId: group.id });
    expect(outsider.status).toBe(403);
    expect(outsider.body.code).toBe('messaging.group_conversation_forbidden');

    // Một thành viên nhóm tạo nó; tư cách thành viên phản chiếu đúng nhóm.
    const created = await http(app).post('/api/v1/messages/conversations/group').set('Authorization', `Bearer ${m1Token}`)
      .send({ groupId: group.id });
    expect(created.status).toBe(201);
    expect(created.body.type).toBe(2);
    expect(created.body.component).toBe('core_group');
    expect(created.body.itemType).toBe('groups');
    expect(created.body.itemId).toBe(group.id);
    expect(new Set(created.body.members as string[])).toEqual(new Set([m1.id, m2.id]));
    const conversationId = created.body.id as string;
    // Tạo lại trả về cùng một cuộc trò chuyện (mỗi nhóm một cuộc).
    const again = await http(app).post('/api/v1/messages/conversations/group').set('Authorization', `Bearer ${m2Token}`)
      .send({ groupId: group.id });
    expect(again.body.id).toBe(conversationId);

    // Cuộc trò chuyện nhóm không bị gác cổng liên hệ: các thành viên trao đổi tin nhắn.
    const hello = await http(app).post(`/api/v1/messages/conversations/${conversationId}/messages`).set('Authorization', `Bearer ${m1Token}`)
      .send({ text: 'Hello team' });
    expect(hello.status).toBe(201);

    // m3 tham gia nhóm (admin, API groups) → mở ra sẽ đồng bộ họ vào, và
    // cuộc trò chuyện cũng xuất hiện trong danh sách của họ.
    await addGroupMember(app, admin, course.id, group.id, m3.id);
    const openedByM3 = await http(app).get(`/api/v1/messages/conversations/${conversationId}`).set('Authorization', `Bearer ${m3Token}`);
    expect(openedByM3.status).toBe(200);
    expect(new Set(openedByM3.body.members as string[])).toEqual(new Set([m1.id, m2.id, m3.id]));
    const m3List = await http(app).get('/api/v1/messages/conversations').set('Authorization', `Bearer ${m3Token}`);
    expect((m3List.body as { id: string }[]).map((c) => c.id)).toContain(conversationId);

    // m2 rời nhóm → lần mở tiếp theo đồng bộ họ ra ngoài; tin nhắn cũ
    // vẫn ở lại, và m2 không còn mở được cuộc trò chuyện nữa.
    const removed = await http(app).delete(`/api/v1/courses/${course.id}/groups/${group.id}/members/${m2.id}`).set('Authorization', `Bearer ${admin}`);
    expect([200, 204]).toContain(removed.status);
    const openedByM1 = await http(app).get(`/api/v1/messages/conversations/${conversationId}`).set('Authorization', `Bearer ${m1Token}`);
    expect(openedByM1.status).toBe(200);
    expect(new Set(openedByM1.body.members as string[])).toEqual(new Set([m1.id, m3.id]));
    expect((openedByM1.body.messages as { fullMessage: string }[]).map((m) => m.fullMessage)).toContain('Hello team');
    const openedByM2 = await http(app).get(`/api/v1/messages/conversations/${conversationId}`).set('Authorization', `Bearer ${m2Token}`);
    expect(openedByM2.status).toBe(403);
    expect(openedByM2.body.code).toBe('messaging.not_member');
  });
});
