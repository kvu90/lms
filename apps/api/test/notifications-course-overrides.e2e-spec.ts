import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';

/**
 * NB-4 (issue #174): ghi đè thông báo theo khoá học.
 *
 * Tiêu chí theo hồ sơ rà soát mục NB-4 + chính sách P3 đã chốt:
 *  - GET /messages/preferences/courses liệt kê mọi khoá người dùng
 *    thuộc về kèm chế độ ('all' mặc định); PUT đặt 'mute'/'all' lưu
 *    vào user_preferences dưới khoá `notif.course.<courseId>`; khoá
 *    ngoài phạm vi → 404; gỡ mute khôi phục ngay.
 *  - Đường consumer thật (sự kiện outbox → NotificationEventsConsumer
 *    → notify()): khoá bị mute thì thông báo THƯỜNG của khoá đó
 *    (activity_due_soon) không được sinh và có dispatch log
 *    'skipped-course-mute'; khoá khác của cùng người dùng vẫn nhận
 *    bình thường.
 *  - P3: điểm mới (grade_updated) + sắp hết hạn ghi danh
 *    (enrol_expiry_warning) của CHÍNH khoá bị mute vẫn tới.
 */
describe('Notification course overrides (NB-4, issue #174)', () => {
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

  interface Notif { id: string; eventType: string; subject: string; fullMessage: string; contextUrl: string | null; timeRead: string | null }
  interface CourseOverrideRow { courseId: string; courseName: string; mode: string }

  async function notificationsOf(token: string): Promise<Notif[]> {
    const res = await http(app).get('/api/v1/notifications/items').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { items: Notif[] }).items;
  }

  async function waitForNotification(token: string, eventType: string, predicate: (n: Notif) => boolean, timeoutMs = 20000): Promise<Notif> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = (await notificationsOf(token)).find((n) => n.eventType === eventType && predicate(n));
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`notification ${eventType} did not arrive within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async function overridesOf(token: string): Promise<CourseOverrideRow[]> {
    const res = await http(app).get('/api/v1/messages/preferences/courses').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { courses: CourseOverrideRow[] }).courses;
  }

  async function setOverride(token: string, courseId: string, mode: string) {
    return http(app).put('/api/v1/messages/preferences/courses')
      .set('Authorization', `Bearer ${token}`).send({ courseId, mode });
  }

  /** Đúng hình dạng sự kiện mà worker quét hạn phát (xem providers-flow). */
  async function emitDueReminder(userId: string, courseId: string): Promise<string> {
    const quizId = randomUUID();
    const timeClose = new Date(Date.now() + 12 * 3600_000);
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('activity', 'activity_due_reminder', $1::jsonb)`,
      [JSON.stringify({ userId, courseId, quizId, activityType: 'quiz', activityName: 'Bài kiểm tra chương 1', timeClose: timeClose.toISOString() })],
    );
    return quizId;
  }

  async function waitForDispatchLog(userId: string, provider: string, status: string, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await pg.query(
        `select id from notification_dispatch_log where user_id = $1 and provider = $2 and status = $3`,
        [userId, provider, status],
      );
      if (rows.rowCount && rows.rowCount > 0) return;
      if (Date.now() > deadline) throw new Error(`dispatch log ${provider}/${status} not found within ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 400));
    }
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

  it('GET lists my courses as all by default; PUT mute persists the notif.course.<id> preference; foreign course 404; bad mode 400', async () => {
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

  it('muted course: regular notifications blocked + logged, other course normal, grades and enrol-expiry of the muted course still arrive, unmute restores', async () => {
    const { courseA, courseB, student, token } = await setupStudentInTwoCourses();
    expect((await setOverride(token, courseA.id, 'mute')).status).toBe(200);

    // (1) Thông báo thường: A bị chặn (có log truy vết), B tới bình thường.
    const quizA = await emitDueReminder(student.id, courseA.id);
    const quizB = await emitDueReminder(student.id, courseB.id);
    const notifB = await waitForNotification(token, 'activity_due_soon', (n) => n.contextUrl === `/courses/${courseB.id}/quizzes/${quizB}`);
    expect(notifB.subject).toContain('Bài kiểm tra chương 1');
    await waitForDispatchLog(student.id, 'activity_due_soon', 'skipped-course-mute');
    // Chờ thêm vài nhịp quét để chắc chắn bản của A không tới muộn.
    await new Promise((r) => setTimeout(r, 3000));
    const dueSoons = (await notificationsOf(token)).filter((n) => n.eventType === 'activity_due_soon');
    expect(dueSoons.map((n) => n.contextUrl)).not.toContain(`/courses/${courseA.id}/quizzes/${quizA}`);

    // (2) P3 — điểm mới của chính khoá bị mute vẫn tới.
    const item = await createGradeItem(app, admin, courseA.id, { itemName: 'Bài kiểm tra 15 phút', gradeMax: 100 });
    await setGrade(app, admin, item.id, student.id, 61);
    const gradeNotif = await waitForNotification(token, 'grade_updated', (n) => n.contextUrl === `/courses/${courseA.id}/grades`);
    expect(gradeNotif.subject.length).toBeGreaterThan(0);

    // (3) P3 — sắp hết hạn ghi danh của chính khoá bị mute vẫn tới
    // (đúng hình dạng sự kiện worker enrol-expiry phát).
    const timeEnd = new Date(Date.now() + 3 * 24 * 3600_000);
    await pg.query(
      `insert into outbox_events (aggregate, type, payload) values ('enrol', 'enrol_expiry_warning', $1::jsonb)`,
      [JSON.stringify({ userId: student.id, enrolmentId: randomUUID(), enrolId: randomUUID(), courseId: courseA.id, timeEnd: timeEnd.toISOString() })],
    );
    const expiryNotif = await waitForNotification(token, 'enrol_expiry_warning', (n) => n.contextUrl === `/courses/${courseA.id}`);
    expect(expiryNotif.subject.length).toBeGreaterThan(0);

    // (4) Gỡ mute khôi phục ngay ở lần phát kế tiếp.
    const unmute = await setOverride(token, courseA.id, 'all');
    expect(unmute.status).toBe(200);
    expect(unmute.body).toMatchObject({ courseId: courseA.id, mode: 'all' });
    const quizA2 = await emitDueReminder(student.id, courseA.id);
    const restored = await waitForNotification(token, 'activity_due_soon', (n) => n.contextUrl === `/courses/${courseA.id}/quizzes/${quizA2}`);
    expect(restored.subject).toContain('Bài kiểm tra chương 1');
  });
});
