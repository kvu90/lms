import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';

/**
 * Lát N2 (issue #51): trung tâm thông báo v2.
 *
 * Tiêu chí kiểm chứng theo issue + comment Bước 0:
 *  - GET /notifications là danh sách GỘP theo (loại × nguồn × ngày)
 *    kèm count/unreadCount, phân trang con trỏ không trùng/khuyết —
 *    không còn request tải toàn bộ lịch sử (đáp ứng dạng phong bì
 *    { items, nextCursor } thay cho mảng phẳng cũ).
 *  - Một đợt nhiều thông báo cùng loại × nguồn × ngày (mẫu "chấm
 *    điểm cả lớp": 30 thông báo điểm của một khoá trong một ngày)
 *    chỉ thành MỘT dòng gộp, mở ra xem đủ từng mục qua
 *    GET /notifications/items.
 *  - Lọc theo 3 nhóm (learning/people/system) và theo chưa đọc.
 *  - read-group đánh dấu đã đọc hàng loạt theo khoá gộp; xoá từng
 *    mục (của người khác → 404 không lộ tồn tại); clear-read chỉ dọn
 *    mục đã đọc.
 *
 * Dữ liệu được gieo thẳng vào bảng notifications qua pg để kiểm soát
 * tất định thời điểm tạo (khoá ngày) — đường phát thông báo thật từ
 * sự kiện nghiệp vụ đã được spec của N1 (notifications-providers-flow)
 * kiểm chứng riêng.
 */
describe('Trung tâm thông báo v2 (N2, issue #51)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let platformTenantId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    // TENANT-1 (#196): thông báo gieo thẳng phải mang tenant của người
    // nhận (user tạo qua API thuộc tenant platform) — dòng không gắn
    // tenant chỉ hiển thị ở ngữ cảnh platform tường minh, không thuộc
    // phiên tenant của user.
    const t = await pg.query<{ id: string }>(`select id from tenants where kind = 'platform'`);
    platformTenantId = t.rows[0]!.id;
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  /** Ngày lịch Asia/Saigon dạng YYYY-MM-DD của một thời điểm (khớp khoá ngày phía API). */
  function saigonDay(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }

  interface SeedSpec {
    eventType: string;
    component: string;
    subject: string;
    contextUrl: string | null;
    at: Date;
    read?: boolean;
  }

  /** Gieo một thông báo cho user, trả id vừa tạo. */
  async function seed(userId: string, spec: SeedSpec): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `insert into notifications (user_id_from, user_id_to, subject, full_message, small_message, component, event_type, context_url, context_url_name, created_at, time_read, tenant_id)
       values (null, $1, $2, $3, $3, $4, $5, $6, null, $7, $8, $9) returning id`,
      [userId, spec.subject, `Nội dung của ${spec.subject}`, spec.component, spec.eventType, spec.contextUrl, spec.at, spec.read ? spec.at : null, platformTenantId],
    );
    return res.rows[0]!.id;
  }

  async function freshUser(): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, token };
  }

  interface GroupView {
    eventType: string; component: string; group: string; contextUrl: string | null; day: string;
    count: number; unreadCount: number;
    latest: { id: string; subject: string; createdAt: string; timeRead: string | null };
  }
  interface ItemView {
    id: string; eventType: string; subject: string; contextUrl: string | null; timeRead: string | null; createdAt: string;
  }

  async function groupsOf(token: string, query = ''): Promise<{ items: GroupView[]; nextCursor: string | null }> {
    const res = await http(app).get(`/api/v1/notifications${query}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { items: GroupView[]; nextCursor: string | null };
  }

  async function itemsOf(token: string, query: string): Promise<{ items: ItemView[]; nextCursor: string | null }> {
    const res = await http(app).get(`/api/v1/notifications/items${query}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { items: ItemView[]; nextCursor: string | null };
  }

  async function unreadOf(token: string): Promise<number> {
    const res = await http(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { unread: number }).unread;
  }

  it('gộp theo (loại × nguồn × ngày): 30 thông báo điểm một khoá một ngày thành một dòng gộp mở rộng được', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    const today = saigonDay(now);
    const yesterday = new Date(now.getTime() - 26 * 3_600_000);
    const yesterdayDay = saigonDay(yesterday);
    expect(yesterdayDay).not.toBe(today);

    // "Chấm điểm cả lớp": 30 thông báo điểm của cùng một khoá trong một ngày.
    for (let i = 1; i <= 30; i += 1) {
      await seed(id, {
        eventType: 'grade_updated', component: 'core_grades', subject: `Điểm mới ${i}`,
        contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + i * 1000),
      });
    }
    // Cùng loại nhưng nguồn khác (khoá khác) → dòng gộp riêng.
    await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: 'Điểm khoá B', contextUrl: '/courses/course-b/grades', at: now });
    // Cùng loại × nguồn nhưng khác ngày → dòng gộp riêng.
    await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: 'Điểm hôm qua', contextUrl: '/courses/course-a/grades', at: yesterday });
    // Loại khác, không có contextUrl → gộp theo component, nhóm people.
    await seed(id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Huy hiệu mới', contextUrl: null, at: now });

    const { items, nextCursor } = await groupsOf(token);
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(4);

    const bulk = items.find((g) => g.eventType === 'grade_updated' && g.contextUrl === '/courses/course-a/grades' && g.day === today);
    expect(bulk).toBeDefined();
    expect(bulk!.count).toBe(30);
    expect(bulk!.unreadCount).toBe(30);
    expect(bulk!.group).toBe('learning');
    expect(bulk!.latest.subject).toBe('Điểm mới 30');

    const otherCourse = items.find((g) => g.contextUrl === '/courses/course-b/grades');
    expect(otherCourse!.count).toBe(1);
    const oldDay = items.find((g) => g.contextUrl === '/courses/course-a/grades' && g.day === yesterdayDay);
    expect(oldDay!.count).toBe(1);
    const badge = items.find((g) => g.eventType === 'badge_awarded');
    expect(badge!.group).toBe('people');
    expect(badge!.contextUrl).toBeNull();

    // Mở dòng gộp: đủ 30 mục qua phân trang con trỏ, mới nhất trước.
    const firstPage = await itemsOf(token, `?eventType=grade_updated&contextUrl=${encodeURIComponent('/courses/course-a/grades')}&day=${today}&limit=25`);
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.items[0]!.subject).toBe('Điểm mới 30');
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await itemsOf(token, `?eventType=grade_updated&contextUrl=${encodeURIComponent('/courses/course-a/grades')}&day=${today}&limit=25&cursor=${firstPage.nextCursor}`);
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.nextCursor).toBeNull();
    const allIds = new Set([...firstPage.items, ...secondPage.items].map((n) => n.id));
    expect(allIds.size).toBe(30);
  });

  it('lọc theo 3 nhóm và theo chưa đọc; read-group hạ đúng số chưa đọc của khoá gộp', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    const today = saigonDay(now);
    for (let i = 1; i <= 3; i += 1) {
      await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: `Điểm ${i}`, contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + i * 1000) });
    }
    await seed(id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Huy hiệu', contextUrl: null, at: now });
    await seed(id, { eventType: 'calendar_reminder', component: 'core_calendar', subject: 'Nhắc lịch', contextUrl: null, at: now });
    expect(await unreadOf(token)).toBe(5);

    const learning = await groupsOf(token, '?group=learning');
    expect(learning.items).toHaveLength(1);
    expect(learning.items[0]!.eventType).toBe('grade_updated');
    const people = await groupsOf(token, '?group=people');
    expect(people.items.map((g) => g.eventType)).toEqual(['badge_awarded']);
    const system = await groupsOf(token, '?group=system');
    expect(system.items.map((g) => g.eventType)).toEqual(['calendar_reminder']);

    const marked = await http(app).post('/api/v1/notifications/read-group').set('Authorization', `Bearer ${token}`)
      .send({ eventType: 'grade_updated', contextUrl: '/courses/course-a/grades', day: today });
    expect(marked.status).toBe(201);
    expect(marked.body).toEqual({ marked: 3 });
    expect(await unreadOf(token)).toBe(2);

    // Sau read-group: lọc unreadOnly không còn dòng điểm; dòng phẳng của nhóm điểm đều đã đọc.
    const unreadGroups = await groupsOf(token, '?unreadOnly=true');
    expect(unreadGroups.items.map((g) => g.eventType).sort()).toEqual(['badge_awarded', 'calendar_reminder']);
    const gradeItems = await itemsOf(token, `?eventType=grade_updated&contextUrl=${encodeURIComponent('/courses/course-a/grades')}&day=${today}`);
    expect(gradeItems.items.every((n) => n.timeRead !== null)).toBe(true);
    const flatUnread = await itemsOf(token, '?unreadOnly=true');
    expect(flatUnread.items).toHaveLength(2);
  });

  it('phân trang con trỏ của danh sách gộp: không trùng, không khuyết, hết trang thì nextCursor null', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    for (let c = 1; c <= 5; c += 1) {
      await seed(id, {
        eventType: 'grade_updated', component: 'core_grades', subject: `Điểm khoá ${c}`,
        contextUrl: `/courses/course-${c}/grades`, at: new Date(now.getTime() + c * 60_000),
      });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const res = await groupsOf(token, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...res.items.map((g) => `${g.eventType}|${g.contextUrl}|${g.day}`));
      cursor = res.nextCursor;
      if (page < 2) expect(cursor).not.toBeNull();
    }
    expect(cursor).toBeNull();
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    // Hoạt động mới nhất trước: khoá 5 (gieo muộn nhất) đứng đầu trang đầu.
    expect(seen[0]).toContain('/courses/course-5/grades');

    // Cursor hỏng → 400 với mã lỗi rõ ràng; limit ngoài trần → 400.
    const badCursor = await http(app).get('/api/v1/notifications?cursor=khong-phai-cursor').set('Authorization', `Bearer ${token}`);
    expect(badCursor.status).toBe(400);
    expect((badCursor.body as { code?: string }).code).toBe('messaging.invalid_cursor');
    const badLimit = await http(app).get('/api/v1/notifications?limit=51').set('Authorization', `Bearer ${token}`);
    expect(badLimit.status).toBe(400);
  });

  it('xoá từng mục: của mình thì mất hẳn, của người khác → 404; clear-read chỉ dọn mục đã đọc', async () => {
    const mine = await freshUser();
    const other = await freshUser();
    const now = new Date();
    const readId = await seed(mine.id, { eventType: 'grade_updated', component: 'core_grades', subject: 'Đã đọc 1', contextUrl: '/courses/course-a/grades', at: now, read: true });
    const readId2 = await seed(mine.id, { eventType: 'grade_updated', component: 'core_grades', subject: 'Đã đọc 2', contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + 1000), read: true });
    const unreadId = await seed(mine.id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Chưa đọc', contextUrl: null, at: new Date(now.getTime() + 2000) });

    // Người khác xoá mục của mình → 404, mục còn nguyên.
    const foreign = await http(app).delete(`/api/v1/notifications/${unreadId}`).set('Authorization', `Bearer ${other.token}`);
    expect(foreign.status).toBe(404);
    const ghost = await http(app).delete('/api/v1/notifications/01900000-0000-7000-8000-000000000099').set('Authorization', `Bearer ${mine.token}`);
    expect(ghost.status).toBe(404);

    // Chủ sở hữu xoá được; xoá xong không còn trong danh sách phẳng.
    const removed = await http(app).delete(`/api/v1/notifications/${unreadId}`).set('Authorization', `Bearer ${mine.token}`);
    expect(removed.status).toBe(200);
    expect(removed.body).toEqual({ deleted: true });
    let flat = await itemsOf(mine.token, '');
    expect(flat.items.map((n) => n.id)).not.toContain(unreadId);
    expect(flat.items).toHaveLength(2);

    // Dọn đã đọc: hai mục đã đọc biến mất, không còn gì để dọn lần hai.
    const cleared = await http(app).post('/api/v1/notifications/clear-read').set('Authorization', `Bearer ${mine.token}`).send({});
    expect(cleared.status).toBe(201);
    expect(cleared.body).toEqual({ deleted: 2 });
    flat = await itemsOf(mine.token, '');
    expect(flat.items).toHaveLength(0);
    expect(flat.items.map((n) => n.id)).not.toContain(readId);
    expect(flat.items.map((n) => n.id)).not.toContain(readId2);
    const clearedAgain = await http(app).post('/api/v1/notifications/clear-read').set('Authorization', `Bearer ${mine.token}`).send({});
    expect(clearedAgain.body).toEqual({ deleted: 0 });
  });
});
