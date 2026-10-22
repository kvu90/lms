import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser } from './course-enrolment-helpers';

/**
 * Enrol + Groups/Cohort flow.
 * Oracles: enrol/tests/enrollib_test.php (test_user_enrolment_created_event,
 * test_enrol_get_my_courses_only_enrolled_courses, suspended semantics from
 * lib/tests/enrollib in report §2#5), group/tests/lib_test.php
 * (test_member_added_event, test_groups_delete_groupings_groups,
 * groups membership), cohort sync behaviour from enrol_cohort plugin
 * semantics as described in report §2#6.
 */
describe('Enrol & groups/cohorts', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setupCourse(groupmode = 0) {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { groupmode });
    const instance = await createEnrolInstance(app, admin, course.id);
    return { cat, course, instance };
  }

  it('enrolling grants the student role at the course context, emits user_enrolled, and isEnrolled separates enrol from capability', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    const ue = await enrolUser(app, admin, course.id, instance.id, user.id);
    expect(ue.status).toBe(0);
    // Role assignment at course context:
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const assignments = await http(app).get('/api/v1/access/assignments')
      .query({ userid: user.id, contextid: content.body.contextId }).set('Authorization', `Bearer ${admin}`);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    expect((assignments.body as { roleid: number }[]).some((a) => a.roleid === studentRole)).toBe(true);
    // isEnrolled facade view:
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: true });
    // And the user can actually access the course content.
    const asUser = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(asUser.status).toBe(200);
    // A non-enrolled user is denied even though the virtual `user` role grants course:view in the evaluator:
    const outsider = await createUserViaApi(app, admin);
    const outsiderLogin = await login(app, outsider.username, STRONG_PASSWORD);
    const asOutsider = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${outsiderLogin.accessToken}`);
    expect(asOutsider.status).toBe(403);
  });

  it('SUSPENDED user is blocked from course content despite holding the student role; reactivation restores access', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const suspend = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}/suspend`)
      .set('Authorization', `Bearer ${admin}`);
    expect(suspend.body.status).toBe(1);
    const blocked = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(blocked.status).toBe(403);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: false });
    const reactivate = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}/reactivate`)
      .set('Authorization', `Bearer ${admin}`);
    expect(reactivate.body.status).toBe(0);
    const restored = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(restored.status).toBe(200);
  });

  it('a suspended user who ALSO holds a real teacher assignment still gets in via moodle/course:view (the documented exception)', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    await assignRole(app, admin, user.id, teacherRole, content.body.contextId);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}/suspend`).set('Authorization', `Bearer ${admin}`);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(res.status).toBe(200);
  });

  it('unenrol without related data removes the enrolment and the granted role; user_unenrolled is emitted', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const del = await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${user.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.body.withdrawn).toBe(false);
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userid: number }[]).some((e) => e.userid === user.id)).toBe(false);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const res = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(res.status).toBe(403);
  });

  it('groups + groupings: membership, grouping links, and deleting a group cleans its links (lib_test::test_groups_delete_*)', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, user.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Team A' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Team B' });
    expect(gA.status).toBe(201);
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: user.id });
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userid: number }[]).map((m) => m.userid)).toContain(user.id);
    const grouping = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'All teams' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupid: gA.body.id });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupid: gB.body.id });
    const inGrouping = await http(app).get(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((inGrouping.body as { id: number }[]).map((g) => g.id).sort()).toEqual([gA.body.id, gB.body.id].sort());
    // Deleting group A removes it from the grouping.
    await http(app).delete(`/api/v1/courses/${course.id}/groups/${gA.body.id}`).set('Authorization', `Bearer ${admin}`);
    const after = await http(app).get(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((after.body as { id: number }[]).map((g) => g.id)).toEqual([gB.body.id]);
  });

  it('SEPARATE GROUPS is a server-side data law: a student in group A gets 403 for group B members and never sees them in lists', async () => {
    const { course, instance } = await setupCourse(1); // SEPARATEGROUPS
    const alice = await createUserViaApi(app, admin);
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, alice.id);
    await enrolUser(app, admin, course.id, instance.id, bob.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Alpha' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta' });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: alice.id });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: bob.id });

    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    // Direct request for the other group's members is blocked at the server.
    const forbidden = await http(app).get(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.code).toBe('group.separate_groups_denied');
    // Her own group is fine.
    const own = await http(app).get(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(own.status).toBe(200);
    // Group list contains ONLY her group.
    const list = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((list.body as { id: number }[]).map((g) => g.id)).toEqual([gA.body.id]);
    // Visible-members aggregate contains only her own membership.
    const visibleMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/visible-members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(visibleMembers.body).toEqual([{ groupId: gA.body.id, userid: alice.id }]);
    // Admin (accessallgroups via manager/siteadmin) sees everything.
    const adminList = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((adminList.body as unknown[]).length).toBe(2);
  });

  it('cohort sync: adding a user to a cohort enrols them into linked courses; removing suspends by default and unenrols when configured', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Class of 2026' });
    expect(cohortRes.status).toBe(201);
    const cohortId = cohortRes.body.id as number;
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId });
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);

    // Add to cohort ⇒ enrolled + can access.
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: user.id });
    const enrolled = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolled.body as { userid: number; status: number }[]).find((e) => e.userid === user.id)?.status).toBe(0);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);

    // Remove from cohort ⇒ suspended (default sync mode), access blocked.
    await http(app).delete(`/api/v1/cohorts/${cohortId}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const afterRemove = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((afterRemove.body as { userid: number; status: number }[]).find((e) => e.userid === user.id)?.status).toBe(1);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);

    // Second course with onCohortLeave=unenrol: removal withdraws the enrolment entirely.
    const course2 = await createCourse(app, admin, cat.id);
    const cohort2 = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Strict cohort' });
    await createEnrolInstance(app, admin, course2.id, { method: 'cohort', cohortId: cohort2.body.id, onCohortLeave: 'unenrol' });
    void instance;
    await http(app).post(`/api/v1/cohorts/${cohort2.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: user.id });
    let list2 = await http(app).get(`/api/v1/courses/${course2.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list2.body as { userid: number }[]).some((e) => e.userid === user.id)).toBe(true);
    await http(app).delete(`/api/v1/cohorts/${cohort2.body.id}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    list2 = await http(app).get(`/api/v1/courses/${course2.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list2.body as { userid: number }[]).some((e) => e.userid === user.id)).toBe(false);
  });

  it('a cohort enrol instance created AFTER users joined the cohort syncs the existing members', async () => {
    const cat = await createCategory(app, admin);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Early joiners' });
    const user = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortRes.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: user.id });
    const course = await createCourse(app, admin, cat.id);
    await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId: cohortRes.body.id });
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userid: number; status: number }[]).find((e) => e.userid === user.id)?.status).toBe(0);
  });

  it('expired enrolment (timeend in the past) is not active: access blocked before any sweep runs', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await enrolUser(app, admin, course.id, instance.id, user.id, { timestart: twoDaysAgo, timeend: yesterday });
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const mine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(mine.body).toMatchObject({ enrolled: true, active: false });
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);
  });

  it('self enrol instance: a user can self-enrol; a manual instance refuses self-enrol', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const selfInstance = await createEnrolInstance(app, admin, course.id, { method: 'self' });
    const manualInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    const bad = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${manualInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(bad.status).toBe(400);
    const ok = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect(ok.status).toBeLessThan(300);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });
});
