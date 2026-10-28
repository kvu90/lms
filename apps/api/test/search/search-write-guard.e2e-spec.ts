import type { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createCourse } from '../support/course-enrolment-helpers';
import { courseContextId } from '../support/engagement-helpers';

/**
 * Vá H2+H5 (sổ rà soát gác quyền #134): 4 route ghi của search
 * (POST /search/index, POST /search/index-raw, POST /search/reindex,
 * DELETE /search/:area/:itemId) phải đòi capability search:manage tại
 * system context. Trước vá, mọi user đăng nhập đều chèn được tài liệu giả
 * vào chỉ mục (index-raw) và xoá/reindex tuỳ ý.
 * Luồng nạp index hợp lệ trong hệ thống (content-bank) gọi thẳng
 * SearchService ở tầng service, không qua các route này — spec
 * platform-search-webservice-flow (ca content bank) là bằng chứng giữ nguyên.
 */
describe('Search write routes guard (H2+H5, #134)', () => {
  let app: INestApplication;
  let admin: string;
  let courseId: string;
  let ctxId: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    courseId = course.id;
    ctxId = await courseContextId(app, admin, courseId);
  });
  afterAll(async () => { await app.close(); });

  async function expectAllWriteRoutesForbidden(token: string) {
    const idx = await http(app).post('/api/v1/search/index').set('Authorization', `Bearer ${token}`)
      .send({ area: 'courses', itemId: courseId });
    expect(idx.status).toBe(403);
    const raw = await http(app).post('/api/v1/search/index-raw').set('Authorization', `Bearer ${token}`)
      .send({ area: 'courses', itemId: uuidv7(), title: 'GuardFakeDoc', content: 'GuardFakeDoc poisoned content', contextId: ctxId });
    expect(raw.status).toBe(403);
    const reindex = await http(app).post('/api/v1/search/reindex').set('Authorization', `Bearer ${token}`).send({});
    expect(reindex.status).toBe(403);
    const del = await http(app).delete(`/api/v1/search/courses/${uuidv7()}`).set('Authorization', `Bearer ${token}`);
    expect(del.status).toBe(403);
  }

  it('user thường không vai: 403 cả 4 route ghi, tài liệu giả không lọt vào index, route đọc giữ nguyên', async () => {
    const plain = await createUserViaApi(app, admin);
    const token = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    await expectAllWriteRoutesForbidden(token);
    // Tài liệu giả bị chặn ở cổng nên không tồn tại trong chỉ mục.
    const probe = await http(app).get('/api/v1/search?q=GuardFakeDoc').set('Authorization', `Bearer ${admin}`);
    expect((probe.body as unknown[]).length).toBe(0);
    // Hành vi truy vấn/tìm kiếm cho user thường không đổi.
    const areas = await http(app).get('/api/v1/search/areas').set('Authorization', `Bearer ${token}`);
    expect(areas.status).toBe(200);
    const q = await http(app).get('/api/v1/search?q=Course').set('Authorization', `Bearer ${token}`);
    expect(q.status).toBe(200);
  });

  it('giáo viên (editingteacher tại context khoá) vẫn 403: search:manage chỉ cấp cho manager tại system context', async () => {
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacher.id, teacherRole, ctxId);
    const token = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    await expectAllWriteRoutesForbidden(token);
  });

  it('admin (manager) gọi được cả 4 route: index, index-raw, reindex, delete', async () => {
    const idx = await http(app).post('/api/v1/search/index').set('Authorization', `Bearer ${admin}`)
      .send({ area: 'courses', itemId: courseId });
    expect(idx.status).toBe(201);
    expect(idx.body.indexed).toBe(true);
    const rawItemId = uuidv7();
    const raw = await http(app).post('/api/v1/search/index-raw').set('Authorization', `Bearer ${admin}`)
      .send({ area: 'courses', itemId: rawItemId, title: 'GuardAdminDoc', content: 'GuardAdminDoc content', contextId: ctxId });
    expect(raw.status).toBeLessThan(300);
    const reindex = await http(app).post('/api/v1/search/reindex').set('Authorization', `Bearer ${admin}`).send({});
    expect(reindex.status).toBeLessThan(300);
    const del = await http(app).delete(`/api/v1/search/courses/${rawItemId}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
  });
});
