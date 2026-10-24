import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * PROBE-ONLY (chẩn đoán CI PR #76): tách các assertion của
 * notifications-center-v2-flow thành các test hạt mịn tên ASCII để
 * kết luận từng bước CI chỉ đúng assertion nào fail trên runner.
 */
describe('Probe N2 micro assertions', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  function saigonDay(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }

  interface SeedSpec { eventType: string; component: string; subject: string; contextUrl: string | null; at: Date; read?: boolean }

  async function seed(userId: string, spec: SeedSpec): Promise<string> {
    const res = await pg.query<{ id: string }>(
      `insert into notifications (user_id_from, user_id_to, subject, full_message, small_message, component, event_type, context_url, context_url_name, created_at, time_read)
       values (null, $1, $2, $3, $3, $4, $5, $6, null, $7, $8) returning id`,
      [userId, spec.subject, `Nội dung của ${spec.subject}`, spec.component, spec.eventType, spec.contextUrl, spec.at, spec.read ? spec.at : null],
    );
    return res.rows[0]!.id;
  }

  async function freshUser(): Promise<{ id: string; token: string }> {
    const user = await createUserViaApi(app, admin);
    const token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    return { id: user.id, token };
  }

  async function groupsOf(token: string, query = '') {
    const res = await http(app).get(`/api/v1/notifications${query}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { items: any[]; nextCursor: string | null };
  }

  async function itemsOf(token: string, query: string) {
    const res = await http(app).get(`/api/v1/notifications/items${query}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as { items: any[]; nextCursor: string | null };
  }

  async function unreadOf(token: string): Promise<number> {
    const res = await http(app).get('/api/v1/notifications/unread-count').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { unread: number }).unread;
  }

  async function seedBulk33(id: string, now: Date): Promise<void> {
    for (let i = 1; i <= 30; i += 1) {
      await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: `Điểm mới ${i}`, contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + i * 1000) });
    }
    await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: 'Điểm khoá B', contextUrl: '/courses/course-b/grades', at: now });
    await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: 'Điểm hôm qua', contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() - 26 * 3_600_000) });
    await seed(id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Huy hiệu mới', contextUrl: null, at: now });
  }

  it('P0 empty groups ok', async () => {
    const { token } = await freshUser();
    const { items, nextCursor } = await groupsOf(token);
    expect(items).toHaveLength(0);
    expect(nextCursor).toBeNull();
    expect(await unreadOf(token)).toBe(0);
  });

  it('P1 unread five', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    for (let i = 1; i <= 3; i += 1) {
      await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: `Điểm ${i}`, contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + i * 1000) });
    }
    await seed(id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Huy hiệu', contextUrl: null, at: now });
    await seed(id, { eventType: 'calendar_reminder', component: 'core_calendar', subject: 'Nhắc lịch', contextUrl: null, at: now });
    expect(await unreadOf(token)).toBe(5);
  });

  it('P2 groups four', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    await seedBulk33(id, now);
    const { items, nextCursor } = await groupsOf(token);
    expect(nextCursor).toBeNull();
    expect(items).toHaveLength(4);
  });

  it('P3 bulk latest', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    const today = saigonDay(now);
    await seedBulk33(id, now);
    const { items } = await groupsOf(token);
    const bulk = items.find((g) => g.eventType === 'grade_updated' && g.contextUrl === '/courses/course-a/grades' && g.day === today);
    expect(bulk).toBeDefined();
    expect(bulk!.count).toBe(30);
    expect(bulk!.unreadCount).toBe(30);
    expect(bulk!.group).toBe('learning');
    expect(bulk!.latest.subject).toBe('Điểm mới 30');
  });

  it('P4 items pages', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    const today = saigonDay(now);
    await seedBulk33(id, now);
    const firstPage = await itemsOf(token, `?eventType=grade_updated&contextUrl=${encodeURIComponent('/courses/course-a/grades')}&day=${today}&limit=25`);
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.items[0]!.subject).toBe('Điểm mới 30');
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await itemsOf(token, `?eventType=grade_updated&contextUrl=${encodeURIComponent('/courses/course-a/grades')}&day=${today}&limit=25&cursor=${firstPage.nextCursor}`);
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.nextCursor).toBeNull();
  });

  it('P5 group filters', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    for (let i = 1; i <= 3; i += 1) {
      await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: `Điểm ${i}`, contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + i * 1000) });
    }
    await seed(id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Huy hiệu', contextUrl: null, at: now });
    await seed(id, { eventType: 'calendar_reminder', component: 'core_calendar', subject: 'Nhắc lịch', contextUrl: null, at: now });
    const learning = await groupsOf(token, '?group=learning');
    expect(learning.items).toHaveLength(1);
    const people = await groupsOf(token, '?group=people');
    expect(people.items.map((g) => g.eventType)).toEqual(['badge_awarded']);
    const system = await groupsOf(token, '?group=system');
    expect(system.items.map((g) => g.eventType)).toEqual(['calendar_reminder']);
  });

  it('P6 read group', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    const today = saigonDay(now);
    for (let i = 1; i <= 3; i += 1) {
      await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: `Điểm ${i}`, contextUrl: '/courses/course-a/grades', at: new Date(now.getTime() + i * 1000) });
    }
    await seed(id, { eventType: 'badge_awarded', component: 'core_badges', subject: 'Huy hiệu', contextUrl: null, at: now });
    await seed(id, { eventType: 'calendar_reminder', component: 'core_calendar', subject: 'Nhắc lịch', contextUrl: null, at: now });
    const marked = await http(app).post('/api/v1/notifications/read-group').set('Authorization', `Bearer ${token}`)
      .send({ eventType: 'grade_updated', contextUrl: '/courses/course-a/grades', day: today });
    expect(marked.status).toBe(201);
    expect(marked.body).toEqual({ marked: 3 });
    expect(await unreadOf(token)).toBe(2);
    const unreadGroups = await groupsOf(token, '?unreadOnly=true');
    expect(unreadGroups.items.map((g) => g.eventType).sort()).toEqual(['badge_awarded', 'calendar_reminder']);
  });

  it('P7 pagination five', async () => {
    const { id, token } = await freshUser();
    const now = new Date();
    for (let c = 1; c <= 5; c += 1) {
      await seed(id, { eventType: 'grade_updated', component: 'core_grades', subject: `Điểm khoá ${c}`, contextUrl: `/courses/course-${c}/grades`, at: new Date(now.getTime() + c * 60_000) });
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
    expect(seen[0]).toContain('/courses/course-5/grades');
  });

  it('P8 bad cursor', async () => {
    const { token } = await freshUser();
    const badCursor = await http(app).get('/api/v1/notifications?cursor=khong-phai-cursor').set('Authorization', `Bearer ${token}`);
    expect(badCursor.status).toBe(400);
    expect((badCursor.body as { code?: string }).code).toBe('messaging.invalid_cursor');
    const badLimit = await http(app).get('/api/v1/notifications?limit=51').set('Authorization', `Bearer ${token}`);
    expect(badLimit.status).toBe(400);
  });
});
