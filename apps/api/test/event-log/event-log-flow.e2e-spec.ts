import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelayService } from '../../src/infra/events/outbox-relay.service';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, ADMIN, STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';
import { createGradeItem, setGrade } from '../support/assessment-helpers';

interface LogItem {
  id: string; seq: number; eventType: string; component: string | null; action: string;
  userId: string | null; relatedUserId: string | null; contextId: string | null;
  courseId: string | null; objectId: string | null; ip: string | null;
  payload: Record<string, unknown> | null; createdAt: string;
}
interface LogPage { items: LogItem[]; total: number; page: number; pageSize: number }

/**
 * Luồng Logstore (issue #22): các hành động nghiệp vụ thật qua HTTP đưa vào hàng đợi outbox
 * các sự kiện; một lượt relay (lời gọi mà bộ lập lịch của worker thực hiện mỗi 5 giây)
 * phản chiếu chúng vào event_log; API đọc sau đó phục vụ chúng kèm bộ lọc
 * và kiểm tra quyền theo phạm vi context (tương đương report_log của Moodle).
 */
describe('Event log: outbox actions are mirrored and queryable with filters + permissions', () => {
  let app: INestApplication;
  let relay: OutboxRelayService;
  let admin: string;
  let adminId: string;
  let courseId: string;
  let courseContextId: string;
  let instanceId: string;
  let studentId: string;
  let studentToken: string;
  let teacherId: string;
  let teacherToken: string;

  async function queryLogs(token: string, query: Record<string, string>): Promise<{ status: number; body: LogPage }> {
    const qs = new URLSearchParams(query).toString();
    const res = await http(app).get(`/api/v1/event-logs${qs ? `?${qs}` : ''}`).set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body as LogPage };
  }

  // Trần hook 120s (không phải 30s mặc định): vòng xả relay ở cuối
  // beforeAll phải duyệt TUẦN TỰ toàn bộ outbox tồn đọng của cả suite
  // trên cùng DB (relay API không tự chạy theo lịch), nên dưới tải CI
  // nó vượt 30s dù mọi assertion đều đúng — xem bàn giao fix CI PR #76.
  beforeAll(async () => {
    // Dọn tồn đọng outbox của các spec đã chạy trước trên cùng DB:
    // relay ở app test chỉ chạy khi gọi tay, nên row chưa publish khi
    // app trước đóng là row chết — không test nào còn tiêu thụ.
    // Không dọn thì vòng xả ở cuối beforeAll này phải duyệt toàn bộ
    // tồn đọng của cả suite (O(backlog)) và vượt trần timeout dưới
    // tải CI dù mọi assertion đều đúng (CI run 40097046131 trên commit
    // chỉ nới trần 120s vẫn đỏ). Dọn xong, vòng xả chỉ còn duyệt
    // event của chính spec này.
    const stale = new Client({ connectionString: process.env.DATABASE_URL });
    await stale.connect();
    await stale.query('DELETE FROM outbox_events WHERE published_at IS NULL');
    await stale.end();
    app = await createTestApp();
    relay = app.get(OutboxRelayService);
    const adminLogin = await login(app, ADMIN.username, ADMIN.password);
    admin = adminLogin.accessToken;
    adminId = adminLogin.userId;

    // Các hành động nghiệp vụ (mỗi hành động đưa sự kiện outbox vào hàng đợi kèm người thực hiện).
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    courseId = course.id;
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    courseContextId = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === courseId)!.id;

    const student = await createUserViaApi(app, admin);
    studentId = student.id;
    const teacher = await createUserViaApi(app, admin);
    teacherId = teacher.id;

    const instance = await createEnrolInstance(app, admin, courseId);
    instanceId = instance.id;
    await enrolUser(app, admin, courseId, instanceId, studentId);

    const editingTeacher = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, teacherId, editingTeacher, courseContextId);

    // Giáo viên chấm điểm học viên (grade_updated với giáo viên là người thực hiện).
    const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
    teacherToken = teacherLogin.accessToken;
    const item = await createGradeItem(app, teacherToken, courseId);
    await setGrade(app, teacherToken, item.id, studentId, 8);

    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    studentToken = studentLogin.accessToken;

    // Admin huỷ ghi danh học viên lần nữa (user_unenrolled).
    const del = await http(app).delete(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/users/${studentId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect([200, 204]).toContain(del.status);

    // Một lượt relay phản chiếu mọi dòng outbox đang chờ vào event_log.
    let published = 0;
    for (let i = 0; i < 20; i += 1) {
      const n = await relay.publishPending(500);
      published += n;
      if (n === 0) break;
    }
    expect(published).toBeGreaterThan(0);
    // Trần 120s thay vì 60s: beforeAll này dựng app + chạy một chuỗi
    // dài gọi HTTP tạo user/khoá/ghi điểm + vòng relay; chạy riêng chỉ
    // mất ~16s nhưng dưới tải full suite (máy 2 CPU, load ~9, các đội
    // khác chạy suite song song) vẫn chạm trần 60s ở lượt chạy full
    // suite ngày 24/10/2026, trong khi mọi test đều pass khi đủ thời
    // gian — đây là trần tải, không phải lỗi logic.
  }, 120000);
  afterAll(async () => { await app.close(); });

  it('course_created is logged with actor, course and resolved course context', async () => {
    const { status, body } = await queryLogs(admin, { eventType: 'course_created', courseId });
    expect(status).toBe(200);
    const row = body.items.find((i) => i.courseId === courseId);
    expect(row).toBeDefined();
    expect(row!.userId).toBe(adminId);
    expect(row!.component).toBe('course');
    expect(row!.action).toBe('course_created');
    expect(row!.contextId).toBe(courseContextId);
    expect(row!.objectId).toBe(courseId);
  });

  it('user_logged_in carries the actor and the client IP', async () => {
    const { body } = await queryLogs(admin, { eventType: 'user_logged_in', userId: adminId });
    expect(body.total).toBeGreaterThanOrEqual(1);
    const row = body.items[0];
    expect(row.userId).toBe(adminId);
    expect(row.component).toBe('auth');
    expect(row.ip).toBeTruthy();
    expect(row.payload?.method).toBe('password');
  });

  it('filter by actor (userId) returns only that actor\u2019s events', async () => {
    const { body } = await queryLogs(admin, { userId: teacherId });
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body.items.every((i) => i.userId === teacherId)).toBe(true);
    expect(body.items.some((i) => i.eventType === 'grade_updated')).toBe(true);
  });

  it('filter by related user returns events where the user was acted upon', async () => {
    const { body } = await queryLogs(admin, { relatedUserId: studentId });
    const types = body.items.map((i) => i.eventType);
    expect(types).toContain('user_enrolled');
    expect(types).toContain('grade_updated');
    expect(types).toContain('user_unenrolled');
    expect(types).not.toContain('course_created');
    // grade_updated thủ công (rawGrade 8, do giáo viên đặt) ghi
    // giáo viên là người thực hiện; các sự kiện chấm lại theo tầng (cascade) do hệ thống điều khiển (không có người thực hiện).
    const grade = body.items.find((i) => i.eventType === 'grade_updated' && i.payload?.rawGrade === 8);
    expect(grade).toBeDefined();
    expect(grade!.userId).toBe(teacherId);
    expect(grade!.courseId).toBe(courseId);
  });

  it('filter by component and by event type narrows the result', async () => {
    const byComponent = await queryLogs(admin, { component: 'enrol', courseId });
    expect(byComponent.body.total).toBeGreaterThanOrEqual(2);
    expect(byComponent.body.items.every((i) => i.component === 'enrol')).toBe(true);

    const roleAssigned = await queryLogs(admin, { eventType: 'role_assigned', relatedUserId: teacherId });
    expect(roleAssigned.body.total).toBe(1);
    expect(roleAssigned.body.items[0].userId).toBe(adminId);
    expect(roleAssigned.body.items[0].component).toBe('access');
  });

  it('time-range filter: future window is empty, past window matches', async () => {
    const future = await queryLogs(admin, { courseId, from: new Date(Date.now() + 3600_000).toISOString() });
    expect(future.body.total).toBe(0);
    const past = await queryLogs(admin, { courseId, from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });
    expect(past.body.total).toBeGreaterThanOrEqual(3);
  });

  it('pagination is consistent: pages are disjoint and total is stable', async () => {
    const page1 = await queryLogs(admin, { courseId, page: '1', pageSize: '2' });
    const page2 = await queryLogs(admin, { courseId, page: '2', pageSize: '2' });
    expect(page1.body.pageSize).toBe(2);
    expect(page1.body.total).toBe(page2.body.total);
    expect(page1.body.total).toBeGreaterThanOrEqual(3);
    const ids1 = new Set(page1.body.items.map((i) => i.id));
    expect(page2.body.items.every((i) => !ids1.has(i.id))).toBe(true);
  });

  it('a user without the capability is denied, site-wide and per course', async () => {
    const siteWide = await queryLogs(studentToken, {});
    expect(siteWide.status).toBe(403);
    const perCourse = await queryLogs(studentToken, { courseId });
    expect(perCourse.status).toBe(403);
  });

  it('a teacher with the role at the course context can read that course\u2019s log but not the site log', async () => {
    const perCourse = await queryLogs(teacherToken, { courseId });
    expect(perCourse.status).toBe(200);
    expect(perCourse.body.total).toBeGreaterThanOrEqual(3);
    const siteWide = await queryLogs(teacherToken, {});
    expect(siteWide.status).toBe(403);
  });
});
