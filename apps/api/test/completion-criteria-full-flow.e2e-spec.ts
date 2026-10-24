import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD, systemContextId } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';
import { contextIdByLevelInstance, courseContextId, setCourseCompletionCriteria } from './engagement-helpers';

/**
 * Course completion criteria — the full set of 8 Moodle types (issue #23).
 * Oracles: MOODLE_503_STABLE completion/criteria/* (completion_criteria_self,
 * completion_criteria_course, completion_criteria_duration,
 * completion_criteria_role, completion_criteria_unenrol) and the course
 * completion settings form (course/completion_form.php): self = learner
 * marks themselves; role = holders of the named role mark learners
 * ("manual completion by others"); course = prerequisite course complete;
 * duration = N days after enrolment; unenrol = complete once unenrolled.
 */
describe('Completion criteria — full 8 Moodle types', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setupCourse() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    return { cat, course, instance };
  }

  async function setupStudent(courseId: string, instanceId: string, enrolOverrides: Record<string, unknown> = {}) {
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, courseId, instanceId, student.id, enrolOverrides);
    const token = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { student, token };
  }

  async function myStatus(token: string, courseId: string): Promise<string> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/completion/me`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.course.status as string;
  }

  async function userStatus(courseId: string, userId: string): Promise<string> {
    const res = await http(app).get(`/api/v1/courses/${courseId}/completion/users/${userId}`).set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
    return res.body.course.status as string;
  }

  it('validation: each new type requires its parameter, references must exist, unknown types still rejected', async () => {
    const { course } = await setupCourse();
    const put = (criteria: unknown[]) => http(app).put(`/api/v1/courses/${course.id}/completion/criteria`)
      .set('Authorization', `Bearer ${admin}`).send({ method: 1, criteria });

    let res = await put([{ criteriaType: 'course' }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.criteria_course_required');
    res = await put([{ criteriaType: 'course', courseInstance: course.id }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.criteria_course_self_reference');
    res = await put([{ criteriaType: 'course', courseInstance: randomUUID() }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.criteria_course_not_found');
    res = await put([{ criteriaType: 'duration' }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.criteria_duration_required');
    res = await put([{ criteriaType: 'role' }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.criteria_role_required');
    res = await put([{ criteriaType: 'role', roleId: randomUUID() }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.criteria_role_not_found');
    res = await put([{ criteriaType: 'nonsense' }]);
    expect(res.status).toBe(400); expect(res.body.code).toBe('completion.bad_criteria_type');

    // All 8 types at once, fully parameterised: accepted and persisted.
    const other = await createCourse(app, admin, (await createCategory(app, admin)).id);
    const teacherRoleId = await roleIdByShortname(app, admin, 'teacher');
    res = await put([
      { criteriaType: 'date', date: '2030-01-01T00:00:00.000Z' },
      { criteriaType: 'grade' },
      { criteriaType: 'self' },
      { criteriaType: 'course', courseInstance: other.id },
      { criteriaType: 'duration', enrolPeriodDays: 5 },
      { criteriaType: 'role', roleId: teacherRoleId },
      { criteriaType: 'unenrol' },
    ]);
    expect(res.status).toBeLessThan(300);
    const got = await http(app).get(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`);
    const byType = new Map((got.body.criteria as { criteriaType: string; courseInstance?: string; enrolPeriodDays?: number; roleId?: string }[])
      .map((c) => [c.criteriaType, c]));
    expect(byType.get('course')?.courseInstance).toBe(other.id);
    expect(byType.get('duration')?.enrolPeriodDays).toBe(5);
    expect(byType.get('role')?.roleId).toBe(teacherRoleId);
    expect(byType.has('self')).toBe(true);
    expect(byType.has('unenrol')).toBe(true);
  });

  it('self: learner marks themselves complete (and can unmark); a course without a self criterion rejects the call', async () => {
    const { course, instance } = await setupCourse();
    const { student, token } = await setupStudent(course.id, instance.id);
    await setCourseCompletionCriteria(app, admin, course.id, [{ criteriaType: 'self' }]);

    expect(await myStatus(token, course.id)).not.toBe('complete');
    const mark = await http(app).post(`/api/v1/courses/${course.id}/completion/self`)
      .set('Authorization', `Bearer ${token}`).send({ complete: true });
    expect(mark.status).toBeLessThan(300);
    expect(mark.body.userId).toBe(student.id);
    expect(mark.body.status).toBe('complete');
    const mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${token}`);
    expect(mine.body.course.status).toBe('complete');
    expect(mine.body.course.timeCompleted).toBeTruthy();

    const unmark = await http(app).post(`/api/v1/courses/${course.id}/completion/self`)
      .set('Authorization', `Bearer ${token}`).send({ complete: false });
    expect(unmark.status).toBeLessThan(300);
    expect(await myStatus(token, course.id)).not.toBe('complete');

    const { course: plain, instance: plainInstance } = await setupCourse();
    const other = await setupStudent(plain.id, plainInstance.id);
    const rejected = await http(app).post(`/api/v1/courses/${plain.id}/completion/self`)
      .set('Authorization', `Bearer ${other.token}`).send({ complete: true });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('completion.no_self_criterion');
  });

  it('course: two-course prerequisite chain — B completes only after A completes, propagated automatically', async () => {
    const cat = await createCategory(app, admin);
    const courseA = await createCourse(app, admin, cat.id);
    const courseB = await createCourse(app, admin, cat.id);
    const instA = await createEnrolInstance(app, admin, courseA.id);
    const instB = await createEnrolInstance(app, admin, courseB.id);
    // A completes by a past date; B requires A.
    await setCourseCompletionCriteria(app, admin, courseA.id, [{ criteriaType: 'date', date: '2020-01-01T00:00:00.000Z' }]);
    await setCourseCompletionCriteria(app, admin, courseB.id, [{ criteriaType: 'course', courseInstance: courseA.id }]);

    const { student, token } = await setupStudent(courseB.id, instB.id);
    await enrolUser(app, admin, courseA.id, instA.id, student.id);
    // A not yet evaluated for this user ⇒ B must not be complete.
    expect(await userStatus(courseB.id, student.id)).not.toBe('complete');
    // Completing A (lazy reaggregation on read) propagates into B.
    expect(await myStatus(token, courseA.id)).toBe('complete');
    expect(await myStatus(token, courseB.id)).toBe('complete');

    // A second learner enrolled in B only never completes B.
    const only = await setupStudent(courseB.id, instB.id);
    expect(await myStatus(only.token, courseB.id)).not.toBe('complete');
  });

  it('duration: completes once the enrolment is old enough, not before', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const { course: week, instance: weekInst } = await setupCourse();
    await setCourseCompletionCriteria(app, admin, week.id, [{ criteriaType: 'duration', enrolPeriodDays: 7 }]);
    const done = await setupStudent(week.id, weekInst.id, { timeStart: tenDaysAgo });
    expect(await myStatus(done.token, week.id)).toBe('complete');

    const { course: month, instance: monthInst } = await setupCourse();
    await setCourseCompletionCriteria(app, admin, month.id, [{ criteriaType: 'duration', enrolPeriodDays: 30 }]);
    const waiting = await setupStudent(month.id, monthInst.id, { timeStart: tenDaysAgo });
    expect(await myStatus(waiting.token, month.id)).not.toBe('complete');
  });

  it('role: only a holder of the named role at the course context may mark learners complete', async () => {
    const { course, instance } = await setupCourse();
    const teacherRoleId = await roleIdByShortname(app, admin, 'teacher');
    await setCourseCompletionCriteria(app, admin, course.id, [{ criteriaType: 'role', roleId: teacherRoleId }]);
    const criteriaRes = await http(app).get(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`);
    const criteriaId = (criteriaRes.body.criteria as { id: string }[])[0]!.id;

    const { student, token } = await setupStudent(course.id, instance.id);
    expect(await myStatus(token, course.id)).not.toBe('complete');

    // The learner does not hold the teacher role: marking is forbidden.
    const selfMark = await http(app).post(`/api/v1/courses/${course.id}/completion/criteria/${criteriaId}/mark`)
      .set('Authorization', `Bearer ${token}`).send({ userId: student.id, complete: true });
    expect(selfMark.status).toBe(403);
    expect(selfMark.body.code).toBe('completion.role_marker_forbidden');

    // An approver holding the teacher role at the course context can mark.
    const approver = await createUserViaApi(app, admin);
    await assignRole(app, admin, approver.id, teacherRoleId, await courseContextId(app, admin, course.id));
    const approverToken = (await login(app, approver.username, STRONG_PASSWORD)).accessToken;
    const marked = await http(app).post(`/api/v1/courses/${course.id}/completion/criteria/${criteriaId}/mark`)
      .set('Authorization', `Bearer ${approverToken}`).send({ userId: student.id, complete: true });
    expect(marked.status).toBeLessThan(300);
    expect(marked.body.status).toBe('complete');
    expect(await myStatus(token, course.id)).toBe('complete');

    // Unmarking reopens the course.
    const unmarked = await http(app).post(`/api/v1/courses/${course.id}/completion/criteria/${criteriaId}/mark`)
      .set('Authorization', `Bearer ${approverToken}`).send({ userId: student.id, complete: false });
    expect(unmarked.status).toBeLessThan(300);
    expect(await myStatus(token, course.id)).not.toBe('complete');
  });

  it('role: assignments at ancestor contexts (system, category) also authorise marking; unrelated branches do not (issue #23 F1)', async () => {
    const { cat, course, instance } = await setupCourse();
    const teacherRoleId = await roleIdByShortname(app, admin, 'teacher');
    await setCourseCompletionCriteria(app, admin, course.id, [{ criteriaType: 'role', roleId: teacherRoleId }]);
    const criteriaRes = await http(app).get(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`);
    const criteriaId = (criteriaRes.body.criteria as { id: string }[])[0]!.id;
    const { student, token } = await setupStudent(course.id, instance.id);
    const mark = (bearer: string, complete: boolean) => http(app)
      .post(`/api/v1/courses/${course.id}/completion/criteria/${criteriaId}/mark`)
      .set('Authorization', `Bearer ${bearer}`).send({ userId: student.id, complete });

    // A marker holding the teacher role at the SYSTEM context (root of the
    // course context's ancestor path) may mark — Moodle role_assign inherits
    // down the tree, exactly like PermissionEvaluator resolves capabilities.
    const sysMarker = await createUserViaApi(app, admin);
    await assignRole(app, admin, sysMarker.id, teacherRoleId, await systemContextId(app, admin));
    const sysToken = (await login(app, sysMarker.username, STRONG_PASSWORD)).accessToken;
    const bySystem = await mark(sysToken, true);
    expect(bySystem.status).toBeLessThan(300);
    expect(bySystem.body.status).toBe('complete');
    expect(await myStatus(token, course.id)).toBe('complete');
    const unBySystem = await mark(sysToken, false);
    expect(unBySystem.status).toBeLessThan(300);
    expect(await myStatus(token, course.id)).not.toBe('complete');

    // Same for an assignment at the course's CATEGORY context (the middle
    // of the path): it covers every course in the category.
    const catMarker = await createUserViaApi(app, admin);
    await assignRole(app, admin, catMarker.id, teacherRoleId, await contextIdByLevelInstance(app, admin, 40, cat.id));
    const catToken = (await login(app, catMarker.username, STRONG_PASSWORD)).accessToken;
    const byCategory = await mark(catToken, true);
    expect(byCategory.status).toBeLessThan(300);
    expect(byCategory.body.status).toBe('complete');
    expect(await myStatus(token, course.id)).toBe('complete');

    // But an assignment in an UNRELATED branch (a different category) is
    // not on this course's path: still forbidden.
    const otherCat = await createCategory(app, admin);
    const strayMarker = await createUserViaApi(app, admin);
    await assignRole(app, admin, strayMarker.id, teacherRoleId, await contextIdByLevelInstance(app, admin, 40, otherCat.id));
    const strayToken = (await login(app, strayMarker.username, STRONG_PASSWORD)).accessToken;
    const byStray = await mark(strayToken, false);
    expect(byStray.status).toBe(403);
    expect(byStray.body.code).toBe('completion.role_marker_forbidden');
    expect(await myStatus(token, course.id)).toBe('complete');
  });

  it('unenrol: enrolled learners are not complete; leaving the course completes it', async () => {
    const { course, instance } = await setupCourse();
    const { student } = await setupStudent(course.id, instance.id);
    await setCourseCompletionCriteria(app, admin, course.id, [{ criteriaType: 'unenrol' }]);
    expect(await userStatus(course.id, student.id)).not.toBe('complete');

    const del = await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${student.id}`)
      .set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBeLessThan(300);
    // The unenrol hook re-evaluated the user synchronously.
    expect(await userStatus(course.id, student.id)).toBe('complete');
  });

  it('aggregation still governs the new types: ALL needs every criterion, ANY needs one', async () => {
    const { course, instance } = await setupCourse();
    // duration 0 days is satisfied immediately after enrolment; self is not.
    await setCourseCompletionCriteria(app, admin, course.id, [
      { criteriaType: 'duration', enrolPeriodDays: 0 },
      { criteriaType: 'self' },
    ], 1);
    const { token } = await setupStudent(course.id, instance.id);
    expect(await myStatus(token, course.id)).not.toBe('complete');
    await http(app).post(`/api/v1/courses/${course.id}/completion/self`).set('Authorization', `Bearer ${token}`).send({ complete: true });
    expect(await myStatus(token, course.id)).toBe('complete');

    const { course: anyCourse, instance: anyInst } = await setupCourse();
    await setCourseCompletionCriteria(app, admin, anyCourse.id, [
      { criteriaType: 'self' },
      { criteriaType: 'date', date: '2100-01-01T00:00:00.000Z' },
    ], 2);
    const anyStudent = await setupStudent(anyCourse.id, anyInst.id);
    await http(app).post(`/api/v1/courses/${anyCourse.id}/completion/self`).set('Authorization', `Bearer ${anyStudent.token}`).send({ complete: true });
    expect(await myStatus(anyStudent.token, anyCourse.id)).toBe('complete');
  });
});
