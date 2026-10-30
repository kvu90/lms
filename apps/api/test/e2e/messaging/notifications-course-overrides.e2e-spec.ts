import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';

/**
 * NB-4 (issue #174): ghi đè thông báo theo khoá học — bề mặt API.
 *
 * Tiêu chí theo hồ sơ rà soát mục NB-4 + chính sách P3 đã chốt:
 *  - GET /messages/preferences/courses liệt kê mọi khoá người dùng
 *    thuộc về kèm chế độ ('all' mặc định); PUT đặt 'mute'/'all' lưu
 *    vào user_preferences dưới khoá `notif.course.<courseId>`; khoá
 *    ngoài phạm vi → 404; gỡ mute khôi phục ngay.
 *
 * Ca kiểm chứng đường consumer thật của NB-4 (khoá bị mute thì
 * thông báo thường của khoá đó không được sinh và có dispatch log
 * 'skipped-course-mute'; khoá khác vẫn nhận bình thường; hai loại
 * P3 — điểm mới và sắp hết hạn ghi danh — của chính khoá bị mute
 * vẫn tới; gỡ mute khôi phục) đã chuyển sang tầng integration của
 * worker cùng consumer thông báo sự kiện (issue con #520 của #491):
 * `apps/worker/test/integration/notifications/notification-events-delivery.int-spec.ts`.
 */
describe('Ghi đè thông báo theo khoá (NB-4, issue #174)', () => {
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

  interface CourseOverrideRow { courseId: string; courseName: string; mode: string }

  async function overridesOf(token: string): Promise<CourseOverrideRow[]> {
    const res = await http(app).get('/api/v1/messages/preferences/courses').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { courses: CourseOverrideRow[] }).courses;
  }

  async function setOverride(token: string, courseId: string, mode: string) {
    return http(app).put('/api/v1/messages/preferences/courses')
      .set('Authorization', `Bearer ${token}`).send({ courseId, mode });
  }

  /** Một học sinh ghi danh vào HAI khoá (A và B) — sân khấu cho kiểm chứng ghi đè theo khoá. */
  async function setupStudentInTwoCourses() {
    const cat = await createCategory(app, admin);
    const courseA = await createCourse(app, admin, cat.id);
    const courseB = await createCourse(app, admin, cat.id);
    const student = await createUserViaApi(app, admin);
    for (const course of [courseA, courseB]) {
      const instance = await createEnrolInstance(app, admin, course.id);
      await enrolUser(app, admin, course.id, instance.id, student.id);
    }
    const token = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { courseA, courseB, student, token };
  }

  it('GET liệt kê khoá học của tôi dạng all mặc định; PUT mute lưu tuỳ chọn notif.course.<id>; khoá lạ 404; mode sai 400', async () => {
    const { courseA, courseB, student, token } = await setupStudentInTwoCourses();

    const initial = await overridesOf(token);
    expect(initial.map((c) => c.courseId).sort()).toEqual([courseA.id, courseB.id].sort());
    for (const row of initial) expect(row.mode).toBe('all');
    expect(initial.find((c) => c.courseId === courseA.id)?.courseName).toBe(courseA.fullName);

    const put = await setOverride(token, courseA.id, 'mute');
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ courseId: courseA.id, mode: 'mute' });

    // Lưu đúng hình dạng khoá hồ sơ audit chốt trong user_preferences.
    const stored = await pg.query(
      `select value from user_preferences where user_id = $1 and name = $2`,
      [student.id, `notif.course.${courseA.id}`],
    );
    expect(stored.rows).toEqual([{ value: 'mute' }]);

    const after = await overridesOf(token);
    expect(after.find((c) => c.courseId === courseA.id)?.mode).toBe('mute');
    expect(after.find((c) => c.courseId === courseB.id)?.mode).toBe('all');

    // Khoá không thuộc về người dùng: 404 y hệt khoá không tồn tại.
    const foreign = await setOverride(token, randomUUID(), 'mute');
    expect(foreign.status).toBe(404);

    // Chế độ ngoài hợp đồng bị từ chối ở tầng schema.
    const badMode = await setOverride(token, courseA.id, 'sometimes');
    expect(badMode.status).toBe(400);

    // Người dùng không thuộc khoá nào: danh sách rỗng, không lỗi.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    expect(await overridesOf(outsiderToken)).toEqual([]);
  });
});
