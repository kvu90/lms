import { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxRelayService } from '../src/infra/events/outbox-relay.service';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, ADMIN, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { createGradeItem, setGrade } from './assessment-helpers';

interface LogItem {
  id: string; seq: number; eventType: string; component: string | null; action: string;
  userId: string | null; relatedUserId: string | null; contextId: string | null;
  courseId: string | null; objectId: string | null; ip: string | null;
  payload: Record<string, unknown> | null; createdAt: string;
}
interface LogPage { items: LogItem[]; total: number; page: number; pageSize: number }

/**
 * Logstore flow (issue #22): real business actions over HTTP enqueue outbox
 * events; one relay pass (the call the worker scheduler makes every 5s)
 * mirrors them into event_log; the read API then serves them with filters
 * and context-scoped permission checks (Moodle report_log equivalent).
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

  beforeAll(async () => {
    app = await createTestApp();
    relay = app.get(OutboxRelayService);
    const adminLogin = await login(app, ADMIN.username, ADMIN.password);
    admin = adminLogin.accessToken;
    adminId = adminLogin.userId;

    // Business actions (each enqueues outbox events with the actor attached).
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

    // Teacher grades the student (grade_updated with the teacher as actor).
    const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
    teacherToken = teacherLogin.accessToken;
    const item = await createGradeItem(app, teacherToken, courseId);
    await setGrade(app, teacherToken, item.id, studentId, 8);

    const studentLogin = await login(app, student.username, STRONG_PASSWORD);
    studentToken = studentLogin.accessToken;

    // Admin unenrols the student again (user_unenrolled).
    const del = await http(app).delete(`/api/v1/courses/${courseId}/enrol/instances/${instanceId}/users/${studentId}`)
      .set('Authorization', `Bearer ${admin}`);
    expect([200, 204]).toContain(del.status);

    // One relay pass mirrors every pending outbox row into event_log.
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
    // The manual grade_updated (rawGrade 8, set by the teacher) records the
    // teacher as actor; cascade regrade events are system-driven (no actor).
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
