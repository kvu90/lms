import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';

/**
 * PROBE-ONLY Q (chẩn đoán CI PR #76): dò từng thành phần của đường
 * GET /notifications khi user CÓ dữ liệu — trạng thái HTTP và từng
 * nguyên liệu SQL (múi giờ, to_char, array_agg, câu SQL gộp đầy đủ).
 */
describe('Probe N2 Q ingredients', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let userId = '';
  let token = '';

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const user = await createUserViaApi(app, admin);
    userId = user.id;
    token = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    const now = new Date();
    for (let i = 1; i <= 3; i += 1) {
      await pg.query(
        `insert into notifications (user_id_from, user_id_to, subject, full_message, small_message, component, event_type, context_url, context_url_name, created_at, time_read)
         values (null, $1, $2, $3, $3, 'core_grades', 'grade_updated', '/courses/course-a/grades', null, $4, null)`,
        [userId, `Điểm ${i}`, `Nội dung ${i}`, new Date(now.getTime() + i * 1000)],
      );
    }
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('Q0 tz name resolves', async () => {
    const res = await pg.query(`select (now() at time zone 'Asia/Saigon') as wall`);
    expect(res.rows).toHaveLength(1);
  });

  it('Q1 to_char day expression', async () => {
    const res = await pg.query(`select to_char((now() at time zone 'Asia/Saigon')::date, 'YYYY-MM-DD') as day`);
    expect(res.rows[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('Q2 array_agg uuid order', async () => {
    const res = await pg.query(`select (array_agg(id order by created_at desc, id desc))[1] as latest_id from notifications where user_id_to = $1`, [userId]);
    expect(res.rows[0]!.latest_id).toBeTruthy();
  });

  it('Q3 full group sql', async () => {
    const res = await pg.query(
      `select event_type as "eventType", component as "component",
        coalesce(nullif(context_url, ''), '') as "sourceKey",
        to_char((created_at at time zone 'Asia/Saigon')::date, 'YYYY-MM-DD') as "day",
        count(*)::int as "count",
        (count(*) filter (where time_read is null))::int as "unreadCount",
        max(created_at) as "latestAt",
        (array_agg(id order by created_at desc, id desc))[1]::text as "latestId"
       from notifications
       where user_id_to = $1
       group by event_type, component, coalesce(nullif(context_url, ''), ''), (created_at at time zone 'Asia/Saigon')::date
       order by max(created_at) desc, (array_agg(id order by created_at desc, id desc))[1] desc
       limit 21`,
      [userId],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.count).toBe(3);
  });

  it('Q4 groups endpoint is 500', async () => {
    const res = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
  });

  it('Q5 groups endpoint is 200 wrong length', async () => {
    const res = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items = (res.body as { items: unknown[] }).items;
    expect(Array.isArray(items)).toBe(true);
    expect(items).not.toHaveLength(1);
  });

  it('Q6 items without day filter ok', async () => {
    const res = await http(app).get('/api/v1/notifications/items?eventType=grade_updated').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as { items: unknown[] }).items).toHaveLength(3);
  });

  it('Q7 items with day filter is 500', async () => {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Saigon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const res = await http(app).get(`/api/v1/notifications/items?eventType=grade_updated&day=${day}`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(500);
  });
});
