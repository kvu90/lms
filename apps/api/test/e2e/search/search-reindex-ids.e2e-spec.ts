import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse } from '../../support/course-enrolment-helpers';
import { courseContextId } from '../../support/engagement-helpers';

/**
 * Dựng lại chỉ mục tìm kiếm qua HTTP — phần bề mặt endpoint của
 * spec integration `test/integration/search/search-reindex-ids.int-spec.ts`
 * (issue #483).
 *
 * Endpoint `POST /api/v1/search/reindex` được gác bằng capability
 * `search:manage` ở chế độ bảo trì: vai không có quyền bị chặn, admin
 * gọi được và nhận `{ indexed }` — số tài liệu khâu dựng lại vừa nạp.
 * Bộ đếm này phải dịch đúng theo điều kiện hợp lệ của từng area:
 * thêm một nội dung contentbank `public` thì tăng đúng 1; thêm một
 * nội dung `draft` thì không đổi; đình chỉ một user đang hoạt động
 * thì giảm đúng 1.
 *
 * Các khẳng định theo từng id trong kho tài liệu (tập id đủ điều
 * kiện của từng area, `countDocs` so với số dòng thật của bảng
 * `search_documents`) không có bề mặt HTTP — route tìm kiếm không
 * phơi bày tập tài liệu của chỉ mục — nên nằm ở spec integration
 * đi kèm, nơi act gọi thẳng `SearchService.reindexAll()`.
 */
describe('Search reindex — dựng lại toàn bộ chỉ mục qua HTTP', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function reindex(token: string) {
    return http(app).post('/api/v1/search/reindex').set('Authorization', `Bearer ${token}`).send({});
  }

  it('dựng lại qua HTTP: bộ đếm indexed chỉ tính nội dung đủ điều kiện và dịch đúng khi điều kiện thay đổi', async () => {
    // Fixture: một user đang hoạt động (sẽ bị đình chỉ ở bước cuối),
    // một khoá học, một giáo viên và hai nội dung contentbank —
    // một public, một draft — làm mốc cho bộ đếm.
    const activeUser = await createUserViaApi(app, admin);
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const ctxId = await courseContextId(app, admin, course.id);
    const teacher = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), ctxId);
    const teacherToken = (await login(app, teacher.username, STRONG_PASSWORD)).accessToken;
    const publicItem = await http(app).post('/api/v1/contentbank').set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: 'Reindex public resource', contextId: ctxId });
    expect(publicItem.status).toBeLessThan(300);
    const publish = await http(app).patch(`/api/v1/contentbank/${publicItem.body.id}`).set('Authorization', `Bearer ${teacherToken}`)
      .send({ visibility: 'public' });
    expect(publish.status).toBeLessThan(300);
    const draftItem = await http(app).post('/api/v1/contentbank').set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: 'Reindex draft resource', contextId: ctxId });
    expect(draftItem.status).toBeLessThan(300);
    expect(draftItem.body.visibility).toBe('draft');

    // Lượt dựng đầu bằng vai có quyền: chạy qua guard và trả bộ đếm.
    const first = await reindex(admin);
    expect(first.status).toBe(201);
    expect(typeof first.body.indexed).toBe('number');
    const base = first.body.indexed as number;

    // Thêm một nội dung public: bộ đếm tăng đúng 1.
    const public2 = await http(app).post('/api/v1/contentbank').set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: 'Reindex public resource 2', contextId: ctxId });
    expect(public2.status).toBeLessThan(300);
    const publish2 = await http(app).patch(`/api/v1/contentbank/${public2.body.id}`).set('Authorization', `Bearer ${teacherToken}`)
      .send({ visibility: 'public' });
    expect(publish2.status).toBeLessThan(300);
    const second = await reindex(admin);
    expect(second.status).toBe(201);
    expect(second.body.indexed).toBe(base + 1);

    // Thêm một nội dung draft: không đủ điều kiện, bộ đếm không đổi.
    const draft2 = await http(app).post('/api/v1/contentbank').set('Authorization', `Bearer ${teacherToken}`)
      .send({ name: 'Reindex draft resource 2', contextId: ctxId });
    expect(draft2.status).toBeLessThan(300);
    expect(draft2.body.visibility).toBe('draft');
    const third = await reindex(admin);
    expect(third.status).toBe(201);
    expect(third.body.indexed).toBe(base + 1);

    // Đình chỉ user đang hoạt động: user rời tập đủ điều kiện của
    // area users, bộ đếm giảm đúng 1.
    const suspend = await http(app).post(`/api/v1/users/${activeUser.id}/suspend`).set('Authorization', `Bearer ${admin}`).send({});
    expect(suspend.status).toBeLessThan(300);
    const fourth = await reindex(admin);
    expect(fourth.status).toBe(201);
    expect(fourth.body.indexed).toBe(base);
  });

  it('dựng lại qua HTTP: user thường không có quyền search:manage bị chặn 403', async () => {
    const plain = await createUserViaApi(app, admin);
    const plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    const res = await reindex(plainToken);
    expect(res.status).toBe(403);
  });
});
