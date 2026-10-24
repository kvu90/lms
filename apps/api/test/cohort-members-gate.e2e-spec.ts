import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory } from './course-enrolment-helpers';

/**
 * Issue #44 (việc nối tiếp) — cổng xem thành viên cohort
 * (GET /cohorts/:id/members).
 *
 * Trước đợt này handler không nhận actor: bất kỳ tài khoản đăng nhập nào
 * cũng lấy được `userId` của mọi thành viên của mọi cohort. Nay người xem
 * phải có capability `cohort:view` hoặc `cohort:manage` tại chính context
 * của cohort — cùng chuẩn capability/context với các thao tác cohort còn
 * lại; người ngoài nhận 404 `cohort.not_found`, giống hệt cohort không
 * tồn tại, để không lộ sự tồn tại của cohort. Các đường nội bộ
 * (đồng bộ ghi danh theo cohort của Enrol, sinh learning plan của
 * Competencies) gọi service không kèm actor nên giữ nguyên hành vi.
 */
describe('Cohort members gate (issue #44 follow-up)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function createCohort(categoryId?: string): Promise<{ id: string; contextId: string }> {
    const res = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`)
      .send(categoryId ? { name: 'Gate cohort', categoryId } : { name: 'Gate cohort' });
    expect(res.status).toBe(201);
    return { id: res.body.id as string, contextId: res.body.contextId as string };
  }

  async function addMember(cohortId: string, userId: string): Promise<void> {
    const res = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId });
    expect(res.status).toBe(201);
  }

  it('outsider and plain cohort member get 404 indistinguishable from a nonexistent cohort', async () => {
    const cohort = await createCohort();
    const member = await createUserViaApi(app, admin);
    await addMember(cohort.id, member.id);
    const outsider = await createUserViaApi(app, admin);

    for (const user of [outsider, member]) {
      const loginRes = await login(app, user.username, STRONG_PASSWORD);
      const denied = await http(app).get(`/api/v1/cohorts/${cohort.id}/members`)
        .set('Authorization', `Bearer ${loginRes.accessToken}`);
      expect(denied.status).toBe(404);
      expect(denied.body.code).toBe('cohort.not_found');

      const missing = await http(app).get(`/api/v1/cohorts/${randomUUID()}/members`)
        .set('Authorization', `Bearer ${loginRes.accessToken}`);
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('cohort.not_found');
    }
  });

  it('site admin gets 200 with the intact member list shape', async () => {
    const cohort = await createCohort();
    const member = await createUserViaApi(app, admin);
    await addMember(cohort.id, member.id);

    const res = await http(app).get(`/api/v1/cohorts/${cohort.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    const rows = res.body as { userId: string; timeAdded: string }[];
    const mine = rows.find((r) => r.userId === member.id);
    expect(mine).toBeDefined();
    expect(typeof mine!.timeAdded).toBe('string');
  });

  it('manager assigned at the cohort context (cohort:manage) gets 200', async () => {
    const cohort = await createCohort();
    const member = await createUserViaApi(app, admin);
    await addMember(cohort.id, member.id);

    const manager = await createUserViaApi(app, admin);
    const managerRole = await roleIdByShortname(app, admin, 'manager');
    await assignRole(app, admin, manager.id, managerRole, cohort.contextId);
    const managerLogin = await login(app, manager.username, STRONG_PASSWORD);

    const res = await http(app).get(`/api/v1/cohorts/${cohort.id}/members`)
      .set('Authorization', `Bearer ${managerLogin.accessToken}`);
    expect(res.status).toBe(200);
    expect((res.body as { userId: string }[]).some((r) => r.userId === member.id)).toBe(true);
  });

  it('teacher assigned at the cohort context gets 200 via cohort:view but still cannot add members', async () => {
    const cohort = await createCohort();
    const viewer = await createUserViaApi(app, admin);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    await assignRole(app, admin, viewer.id, teacherRole, cohort.contextId);
    const viewerLogin = await login(app, viewer.username, STRONG_PASSWORD);

    const res = await http(app).get(`/api/v1/cohorts/${cohort.id}/members`)
      .set('Authorization', `Bearer ${viewerLogin.accessToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    // cohort:view không kéo theo cohort:manage: ghi vẫn bị chặn như trước.
    const other = await createUserViaApi(app, admin);
    const write = await http(app).post(`/api/v1/cohorts/${cohort.id}/members`)
      .set('Authorization', `Bearer ${viewerLogin.accessToken}`).send({ userId: other.id });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('access.capability_denied');
  });

  it('category cohort: the gate is evaluated at the cohort own context', async () => {
    const catA = await createCategory(app, admin);
    const catB = await createCategory(app, admin);
    const cohortA = await createCohort(catA.id);
    const cohortB = await createCohort(catB.id);
    expect(cohortA.contextId).not.toBe(cohortB.contextId);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');

    // Gán vai teacher tại đúng context của cohort A → xem được A.
    const inContext = await createUserViaApi(app, admin);
    await assignRole(app, admin, inContext.id, teacherRole, cohortA.contextId);
    const inContextLogin = await login(app, inContext.username, STRONG_PASSWORD);
    const ok = await http(app).get(`/api/v1/cohorts/${cohortA.id}/members`)
      .set('Authorization', `Bearer ${inContextLogin.accessToken}`);
    expect(ok.status).toBe(200);

    // Gán vai teacher tại context của cohort B (nhánh khác) → không xem được A.
    const wrongContext = await createUserViaApi(app, admin);
    await assignRole(app, admin, wrongContext.id, teacherRole, cohortB.contextId);
    const wrongContextLogin = await login(app, wrongContext.username, STRONG_PASSWORD);
    const denied = await http(app).get(`/api/v1/cohorts/${cohortA.id}/members`)
      .set('Authorization', `Bearer ${wrongContextLogin.accessToken}`);
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('cohort.not_found');
  });
});
