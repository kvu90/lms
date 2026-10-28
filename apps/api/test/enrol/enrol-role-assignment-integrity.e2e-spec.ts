import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createRoleViaApi, createTestApp, createUserViaApi, hasCapability, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from '../support/course-enrolment-helpers';

/**
 * Toàn vẹn gán vai theo ghi danh (issue #157, phát sinh từ phán quyết
 * CHƯA ĐẠT của PR #152).
 *
 * Trạng thái cấm: một ghi danh còn hiệu lực mà không còn gán vai tại
 * context khoá (định nghĩa "thuộc khoá" của #33 = ghi danh ∪ gán vai).
 * Trước fix, trạng thái này chạm tới được qua API hai đường:
 *  1. ghi danh qua 2 instance cùng vai chỉ có MỘT dòng gán vai dùng
 *     chung (assignRole/insertAssignment không set component/itemId),
 *     mà unenrolInternal xoá mọi dòng khớp roleId của instance bị rút —
 *     rút 1 instance là mất vai dù ghi danh instance kia vẫn ACTIVE;
 *  2. DELETE /access/assignments/:id xoá cả dòng do enrol cấp.
 *
 * Sau fix: dòng gán của enrol mang component='enrol' + itemId=instance;
 * unenrol/đổi vai chỉ gỡ dòng của chính instance; unassignRole qua API
 * quản trị chặn xoá dòng nguồn enrol (`access.assignment_enrol_managed`);
 * dòng cũ không component/itemId được coi là gán tay.
 */
describe('Enrol role-assignment integrity (#157)', () => {
  let app: INestApplication;
  let admin: string;
  let studentRole: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    studentRole = await roleIdByShortname(app, admin, 'student');
  });
  afterAll(async () => { await app.close(); });

  interface AssignmentRow { id: string; roleId: string; component: string; itemId: string | null }

  async function courseContextId(courseId: string): Promise<string> {
    const content = await http(app).get(`/api/v1/courses/${courseId}/content`).set('Authorization', `Bearer ${admin}`);
    return content.body.contextId as string;
  }

  async function assignmentsOf(userId: string, contextId: string): Promise<AssignmentRow[]> {
    const res = await http(app).get('/api/v1/access/assignments')
      .query({ userId, contextId }).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body as AssignmentRow[];
  }

  async function setupCourse(): Promise<{ course: { id: string }; ctxId: string }> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    return { course, ctxId: await courseContextId(course.id) };
  }

  it('two instances with the same role: unenrolling from one keeps the role, the enrolment view and course capability', async () => {
    const { course, ctxId } = await setupCourse();
    const instanceA = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const instanceB = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instanceA.id, user.id);
    await enrolUser(app, admin, course.id, instanceB.id, user.id);

    // Mỗi instance một dòng gán riêng, mang truy vết của chính nó.
    const before = (await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole);
    expect(before).toHaveLength(2);
    expect(before.map((a) => a.itemId).sort()).toEqual([instanceA.id, instanceB.id].sort());
    for (const a of before) expect(a.component).toBe('enrol');

    // Rút khỏi A: chỉ dòng của A mất; vai, ghi danh ở B và capability còn nguyên.
    const del = await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instanceA.id}/users/${user.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(del.body.withdrawn).toBe(false);
    const after = (await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole);
    expect(after).toHaveLength(1);
    expect(after[0]!.itemId).toBe(instanceB.id);

    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
    expect(await hasCapability(app, admin, user.id, 'course:view', ctxId)).toBe(true);
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(content.status).toBe(200);

    // Rút luôn khỏi B: vai mới hết hẳn (hồi quy hành vi đơn instance).
    await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instanceB.id}/users/${user.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect((await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole)).toHaveLength(0);
    const mineAfter = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mineAfter.body).toMatchObject({ enrolled: false, active: false });
    const blocked = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(blocked.status).toBe(403);
  });

  it('leaving a cohort with onCohortLeave=unenrol removes only the cohort instance row; the manual enrolment keeps the role', async () => {
    const { course, ctxId } = await setupCourse();
    const manual = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Integrity cohort' });
    expect(cohortRes.status).toBe(201);
    const cohortId = cohortRes.body.id as string;
    const cohortInstance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId, onCohortLeave: 'unenrol' });

    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manual.id, user.id);
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });

    const before = (await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole);
    expect(before.map((a) => a.itemId).sort()).toEqual([manual.id, cohortInstance.id].sort());

    // Rời cohort ⇒ unenrol khỏi instance cohort: chỉ dòng cohort mất.
    await http(app).delete(`/api/v1/cohorts/${cohortId}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const after = (await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole);
    expect(after).toHaveLength(1);
    expect(after[0]!.itemId).toBe(manual.id);

    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
    expect(await hasCapability(app, admin, user.id, 'course:view', ctxId)).toBe(true);
  });

  it('the admin assignments API cannot delete an enrol-managed assignment, but manual assignments delete normally', async () => {
    const { course, ctxId } = await setupCourse();
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);

    const rows = await assignmentsOf(user.id, ctxId);
    const enrolRow = rows.find((a) => a.roleId === studentRole)!;
    expect(enrolRow.component).toBe('enrol');
    expect(enrolRow.itemId).toBe(instance.id);

    const blocked = await http(app).delete(`/api/v1/access/assignments/${enrolRow.id}`).set('Authorization', `Bearer ${admin}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('access.assignment_enrol_managed');
    // Dòng còn nguyên sau lần xoá bị chặn.
    expect((await assignmentsOf(user.id, ctxId)).some((a) => a.id === enrolRow.id)).toBe(true);

    // Gán tay (không nguồn enrol) vẫn xoá được như cũ. Vai dùng cho
    // dòng gán tay là một vai tự tạo KHÔNG thuộc archetype giảng dạy:
    // từ issue #425, gán vai giảng dạy tại context khoá cho học viên
    // đang học đang hoạt động trong chính khoá đó bị chốt tách vai
    // chặn (lẫn vai cùng khoá), còn ngữ nghĩa xoá dòng gán tay được
    // kiểm ở đây không phụ thuộc archetype của vai.
    const manualRole = await createRoleViaApi(app, admin);
    await assignRole(app, admin, user.id, manualRole, ctxId);
    const manualRow = (await assignmentsOf(user.id, ctxId)).find((a) => a.roleId === manualRole)!;
    expect(manualRow.component).toBe('');
    expect(manualRow.itemId).toBeNull();
    const ok = await http(app).delete(`/api/v1/access/assignments/${manualRow.id}`).set('Authorization', `Bearer ${admin}`);
    expect(ok.status).toBe(200);
    expect((await assignmentsOf(user.id, ctxId)).some((a) => a.id === manualRow.id)).toBe(false);
  });

  it('a manual assignment of the same role survives unenrol: unenrol removes only its own instance row', async () => {
    const { course, ctxId } = await setupCourse();
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    // Gán tay cùng role student tại cùng context (dòng cũ không
    // component/itemId cũng được coi là gán tay theo cùng quy tắc này).
    await assignRole(app, admin, user.id, studentRole, ctxId);

    const before = (await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole);
    expect(before).toHaveLength(2);
    expect(before.filter((a) => a.component === 'enrol')).toHaveLength(1);
    expect(before.filter((a) => a.component === '')).toHaveLength(1);

    await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}`)
      .set('Authorization', `Bearer ${admin}`);
    const after = (await assignmentsOf(user.id, ctxId)).filter((a) => a.roleId === studentRole);
    expect(after).toHaveLength(1);
    expect(after[0]!.component).toBe('');
    expect(after[0]!.itemId).toBeNull();
    // Ghi danh đã hết nhưng vai gán tay vẫn hiệu lực ở tầng capability.
    expect(await hasCapability(app, admin, user.id, 'course:view', ctxId)).toBe(true);
  });
});
