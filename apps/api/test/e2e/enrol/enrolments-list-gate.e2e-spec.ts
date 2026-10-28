import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../../support/course-enrolment-helpers';

/**
 * Issue #44 — cổng xem danh sách ghi danh của khoá học
 * (GET /courses/:courseId/enrolments).
 *
 * Trước đợt này handler không nhận actor: bất kỳ tài khoản đăng nhập nào
 * cũng lấy được toàn bộ bản ghi ghi danh của mọi khoá. Nay chỉ (a) người
 * thuộc khoá — ghi danh đang hiệu lực hoặc gán vai tại context khoá — hoặc
 * (b) người có capability `enrol:manage` tại context khoá mới xem được;
 * người ngoài nhận 404 `course.not_found`, giống hệt khoá không tồn tại,
 * để không lộ sự tồn tại của khoá.
 */
describe('Enrolments list gate (issue #44)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setupCourse() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    return { course, instance };
  }

  async function courseContextId(courseId: string): Promise<string> {
    const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set('Authorization', `Bearer ${admin}`);
    return content.body.contextId as string;
  }

  it('outsider gets 404 indistinguishable from a nonexistent course', async () => {
    const { course } = await setupCourse();
    const outsider = await createUserViaApi(app, admin);
    const outsiderLogin = await login(app, outsider.username, STRONG_PASSWORD);

    const denied = await http(app).get(`/api/v1/courses/${course.id}/enrolments`)
      .set('Authorization', `Bearer ${outsiderLogin.accessToken}`);
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('course.not_found');

    const missing = await http(app).get(`/api/v1/courses/${randomUUID()}/enrolments`)
      .set('Authorization', `Bearer ${outsiderLogin.accessToken}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('course.not_found');
  });

  it('enrolled student (active enrolment) gets 200 with the full list shape', async () => {
    const { course, instance } = await setupCourse();
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentLogin = await login(app, student.username, STRONG_PASSWORD);

    const res = await http(app).get(`/api/v1/courses/${course.id}/enrolments`)
      .set('Authorization', `Bearer ${studentLogin.accessToken}`);
    expect(res.status).toBe(200);
    const rows = res.body as { userId: string; enrolId: string; status: number; enrolMethod: string }[];
    const mine = rows.find((r) => r.userId === student.id);
    expect(mine).toBeDefined();
    expect(mine!.enrolId).toBe(instance.id);
    expect(mine!.status).toBe(0);
    expect(mine!.enrolMethod).toBe('manual');
  });

  it('teacher assigned at the course context (not enrolled) gets 200', async () => {
    const { course } = await setupCourse();
    const teacher = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    await assignRole(app, admin, teacher.id, teacherRole, await courseContextId(course.id));
    const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);

    const res = await http(app).get(`/api/v1/courses/${course.id}/enrolments`)
      .set('Authorization', `Bearer ${teacherLogin.accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('enrol manager (editingteacher assignment, enrol:manage) and site admin get 200 intact', async () => {
    const { course, instance } = await setupCourse();
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);

    const manager = await createUserViaApi(app, admin);
    const editingTeacherRole = await roleIdByShortname(app, admin, 'editingteacher');
    await assignRole(app, admin, manager.id, editingTeacherRole, await courseContextId(course.id));
    const managerLogin = await login(app, manager.username, STRONG_PASSWORD);
    const asManager = await http(app).get(`/api/v1/courses/${course.id}/enrolments`)
      .set('Authorization', `Bearer ${managerLogin.accessToken}`);
    expect(asManager.status).toBe(200);
    expect((asManager.body as { userId: string }[]).some((r) => r.userId === student.id)).toBe(true);

    const asAdmin = await http(app).get(`/api/v1/courses/${course.id}/enrolments`)
      .set('Authorization', `Bearer ${admin}`);
    expect(asAdmin.status).toBe(200);
    expect((asAdmin.body as { userId: string }[]).some((r) => r.userId === student.id)).toBe(true);
  });
});
