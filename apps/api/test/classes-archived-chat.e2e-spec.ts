import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD,
} from './identity-access-helpers';

/**
 * Ca e2e còn nợ của cụm lớp (ghi trên issue #184, comment 6410263474 —
 * đối chiếu ĐG MSG-T2): lớp ARCHIVED thì chat cấp lớp đóng băng —
 * ensure conversation và roster chat lớp trả 404 cho cả học sinh lẫn
 * giáo viên, tập thành viên của conversation không đổi bất chấp thao
 * tác sau đó. Hành vi đã thi công ở MSG-T2 (PR #271); file này là bằng
 * chứng e2e riêng còn thiếu, bổ sung ở CLASS-3. Đổi luật đóng băng
 * (archived vẫn mở được chat / thành viên vẫn trôi) thì ca phải đỏ.
 */
interface Person { id: string; username: string; token: string }

describe('Chat cấp lớp khi lớp archived — đóng băng (issue #184, nợ ĐG MSG-T2)', () => {
  let app: INestApplication;
  let pg: Client;
  let admin: string;
  let teacher: Person;
  let s1: Person;
  let s2: Person;
  let classId: string;
  let conversationId: string;

  async function person(): Promise<Person> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  async function ensure(token: string) {
    return http(app).get(`/api/v1/messages/classes/${classId}/conversation`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function chatRoster(token: string) {
    return http(app).get(`/api/v1/messages/classes/${classId}/members`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function memberIds(): Promise<string[]> {
    const rows = await pg.query(
      'select user_id from message_conversation_members where conversation_id = $1 order by user_id',
      [conversationId],
    );
    return rows.rows.map((r) => r.user_id as string);
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    admin = await adminToken(app);

    teacher = await person();
    s1 = await person();
    s2 = await person();
    const current = await http(app).get('/api/v1/tenants/current').set('Authorization', `Bearer ${admin}`);
    const tenantId = (current.body as { id: string }).id;
    for (const p of [teacher, s1, s2]) {
      await http(app).post(`/api/v1/tenants/${tenantId}/members`)
        .set('Authorization', `Bearer ${admin}`).send({ userId: p.id });
    }

    const created = await http(app).post('/api/v1/classes')
      .set('Authorization', `Bearer ${admin}`).send({ name: 'Lớp lưu trữ chat', ownerId: teacher.id });
    expect(created.status).toBe(201);
    classId = (created.body as { id: string }).id;
    const add = await http(app).post(`/api/v1/classes/${classId}/roster`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ userId: s1.id });
    expect(add.status).toBe(201);
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('trước archived: ensure mở được chat lớp, roster chat thấy thành viên', async () => {
    const res = await ensure(s1.token);
    expect(res.status).toBe(200);
    conversationId = (res.body as { id: string }).id;
    expect(conversationId).toBeTruthy();
    const roster = await chatRoster(s1.token);
    expect(roster.status).toBe(200);
    const before = await memberIds();
    expect(before).toContain(s1.id);
    expect(before).toContain(teacher.id);
  });

  it('sau archived: ensure + roster chat 404 cho cả học sinh và giáo viên; membership đóng băng', async () => {
    const frozenMembers = await memberIds();

    const archived = await http(app).post(`/api/v1/classes/${classId}/archive`)
      .set('Authorization', `Bearer ${teacher.token}`).send({});
    expect(archived.status).toBeLessThan(300);
    expect((archived.body as { status: string }).status).toBe('archived');

    // Ensure và roster chat lớp: 404 đồng nhất cho mọi vai thuộc lớp.
    expect((await ensure(s1.token)).status).toBe(404);
    expect((await ensure(teacher.token)).status).toBe(404);
    expect((await chatRoster(s1.token)).status).toBe(404);
    expect((await chatRoster(teacher.token)).status).toBe(404);

    // Roster lớp cũng đóng băng: thêm học sinh mới bị chặn ở API lớp.
    const addLate = await http(app).post(`/api/v1/classes/${classId}/roster`)
      .set('Authorization', `Bearer ${teacher.token}`).send({ userId: s2.id });
    expect(addLate.status).toBe(400);
    expect(JSON.stringify(addLate.body)).toContain('class.archived');

    // Tập thành viên của conversation không hề đổi sau mọi thao tác trên.
    expect(await memberIds()).toEqual(frozenMembers);
    expect(await memberIds()).not.toContain(s2.id);
  });
});
