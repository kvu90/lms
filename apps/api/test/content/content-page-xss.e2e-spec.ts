import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from '../support/course-enrolment-helpers';

/**
 * Gác XSS lưu trữ của học liệu (trang đọc mod_page + URL tài nguyên
 * mod_resource):
 *  - Nội dung HTML của trang đọc được làm sạch THEO ALLOWLIST phía
 *    server ở cả đường ghi (tạo/sửa qua ContentService) lẫn đường đọc
 *    phục vụ trang học — bản ghi đã lưu payload độc từ trước khi có
 *    cổng ghi (mô phỏng bằng cách ghi thẳng xuống DB) cũng không
 *    được phát nguyên văn qua đáp ứng đọc/player của học viên.
 *  - Định dạng học liệu hợp lệ (đoạn văn, in đậm, liên kết https,
 *    ảnh) phải đi qua nguyên vẹn — làm sạch không được phá nội dung.
 *  - URL tài nguyên ngoài chỉ còn scheme http/https: `javascript:`/
 *    `data:` bị từ chối khi lưu (400) ở cả đường tạo lẫn đường sửa;
 *    bản ghi cũ mang scheme nguy hiểm (ghi thẳng xuống DB) không
 *    được phát ra đáp ứng đọc cho người xem.
 * Kiểm chứng âm tính ngược: vô hiệu hoá bước làm sạch trong
 * ContentService thì các ca payload độc dưới đây đỏ (đã chạy tay khi
 * thi công, xem thân PR).
 */
describe('Content stored-XSS guards (page content sanitising + resource URL schemes)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  const PAYLOAD = '<p>Bài đọc <strong>bình thường</strong></p>'
    + '<img src="x" onerror="alert(document.domain)">'
    + '<script>alert(1)</script>'
    + '<p><a href="https://example.com/tai-lieu">Tài liệu hợp lệ</a> <a href="javascript:alert(2)">Liên kết độc</a></p>';

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  }, 120_000);
  afterAll(async () => { await pg.end(); await app.close(); });

  interface Fixture {
    courseId: string;
    sectionId: string;
    studentToken: string;
  }

  async function setup(): Promise<Fixture> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { courseId: course.id, sectionId, studentToken };
  }

  /** Khẳng định một chuỗi nội dung trang không còn cấu trúc thực thi nhưng giữ định dạng hợp lệ. */
  function expectSanitised(content: string): void {
    expect(content).not.toContain('<script');
    expect(content).not.toContain('onerror');
    expect(content).not.toContain('javascript:');
    expect(content).not.toContain('alert');
    expect(content).toContain('<p>Bài đọc <strong>bình thường</strong></p>');
    expect(content).toContain('<a href="https://example.com/tai-lieu">Tài liệu hợp lệ</a>');
  }

  it('tạo trang với payload độc: đáp ứng tạo + đọc phía học viên + player đều đã làm sạch, định dạng hợp lệ giữ nguyên', async () => {
    const f = await setup();
    const created = await http(app).post(`/api/v1/courses/${f.courseId}/pages`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Bài đọc độc', content: PAYLOAD });
    expect(created.status).toBe(201);
    expectSanitised(created.body.content as string);

    const read = await http(app).get(`/api/v1/pages/${created.body.id}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(read.status).toBe(200);
    expectSanitised(read.body.content as string);

    const player = await http(app).get(`/api/v1/courses/${f.courseId}/player/${created.body.cmId}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(player.status).toBe(200);
    expect(player.body.content.type).toBe('page');
    expectSanitised(player.body.content.page.content as string);
  });

  it('sửa trang với payload độc: đáp ứng sửa và mọi đường đọc đều đã làm sạch', async () => {
    const f = await setup();
    const created = await http(app).post(`/api/v1/courses/${f.courseId}/pages`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Bài đọc thường', content: '<p>Nội dung sạch</p>' });
    expect(created.status).toBe(201);

    const patched = await http(app).patch(`/api/v1/pages/${created.body.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ content: PAYLOAD });
    expect(patched.status).toBe(200);
    expectSanitised(patched.body.content as string);

    const player = await http(app).get(`/api/v1/courses/${f.courseId}/player/${created.body.cmId}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(player.status).toBe(200);
    expectSanitised(player.body.content.page.content as string);
  });

  it('dữ kiện cũ: bản ghi trang mang payload độc ghi thẳng xuống DB vẫn sạch khi học viên đọc và mở player', async () => {
    const f = await setup();
    const created = await http(app).post(`/api/v1/courses/${f.courseId}/pages`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Bài đọc cũ', content: '<p>Nội dung sạch</p>' });
    expect(created.status).toBe(201);
    // Mô phỏng dữ kiện đã lưu trước khi có cổng làm sạch ở đường ghi:
    // ghi đè content thẳng xuống DB, bỏ qua hoàn toàn tầng service.
    await pg.query('UPDATE pages SET content = $1 WHERE id = $2', [PAYLOAD, created.body.id]);

    const read = await http(app).get(`/api/v1/pages/${created.body.id}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(read.status).toBe(200);
    expectSanitised(read.body.content as string);

    const player = await http(app).get(`/api/v1/courses/${f.courseId}/player/${created.body.cmId}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(player.status).toBe(200);
    expectSanitised(player.body.content.page.content as string);
  });

  it('URL tài nguyên: scheme javascript:/data: bị từ chối khi tạo và khi sửa; URL https bình thường qua và nhúng như cũ', async () => {
    const f = await setup();
    const badCreate = await http(app).post(`/api/v1/courses/${f.courseId}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Liên kết độc', kind: 'url', url: 'javascript:alert(document.domain)' });
    expect(badCreate.status).toBe(400);
    const badData = await http(app).post(`/api/v1/courses/${f.courseId}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Liên kết data', kind: 'url', url: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' });
    expect(badData.status).toBe(400);

    const good = await http(app).post(`/api/v1/courses/${f.courseId}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Video ngoài', kind: 'url', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(good.status).toBe(201);

    const badPatch = await http(app).patch(`/api/v1/resources/${good.body.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ url: 'javascript:alert(1)' });
    expect(badPatch.status).toBe(400);

    const read = await http(app).get(`/api/v1/resources/${good.body.id}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(read.status).toBe(200);
    expect(read.body.resource.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(read.body.embedUrl).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ');
  });

  it('dữ kiện cũ: tài nguyên mang URL javascript: đã lưu trong DB không được phát ra đáp ứng đọc cho người xem', async () => {
    const f = await setup();
    const good = await http(app).post(`/api/v1/courses/${f.courseId}/resources`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: f.sectionId, name: 'Liên kết cũ', kind: 'url', url: 'https://example.com/bai-hoc' });
    expect(good.status).toBe(201);
    // Mô phỏng bản ghi cũ lưu trước khi có cổng scheme.
    await pg.query('UPDATE resources SET url = $1 WHERE id = $2', ['javascript:alert(document.domain)', good.body.id]);

    const read = await http(app).get(`/api/v1/resources/${good.body.id}`).set('Authorization', `Bearer ${f.studentToken}`);
    expect(read.status).toBe(200);
    expect(read.body.resource.url).toBeNull();
    expect(read.body.embedUrl).toBeNull();
    expect(JSON.stringify(read.body)).not.toContain('javascript:');
  });
});
