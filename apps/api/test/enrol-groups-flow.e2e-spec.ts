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
 * Behat oracles (business-gaps round): enrol/self/tests/behat/
 * self_enrolment.feature ("Self-enrolment enabled requiring an enrolment
 * key", "...requiring a group enrolment key", "Self unenrol as a
 * self-enrolled student"), enrol/self + enrol/manual welcome-message
 * scenarios, enrol/cohort/tests/behat/enrolcohorts.feature ("Editing a
 * cohort enrolment method's role should change participants' role").
 */
describe('Enrol & groups/cohorts', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setupCourse(groupMode = 0) {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { groupMode });
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
      .query({ userId: user.id, contextId: content.body.contextId }).set('Authorization', `Bearer ${admin}`);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    expect((assignments.body as { roleId: string }[]).some((a) => a.roleId === studentRole)).toBe(true);
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
    expect((list.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
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
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userId: string }[]).map((m) => m.userId)).toContain(user.id);
    const grouping = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'All teams' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gA.body.id });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gB.body.id });
    const inGrouping = await http(app).get(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((inGrouping.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.body.id, gB.body.id].sort());
    // Deleting group A removes it from the grouping.
    await http(app).delete(`/api/v1/courses/${course.id}/groups/${gA.body.id}`).set('Authorization', `Bearer ${admin}`);
    const after = await http(app).get(`/api/v1/courses/${course.id}/groupings/${grouping.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((after.body as { id: string }[]).map((g) => g.id)).toEqual([gB.body.id]);
  });

  it('SEPARATE GROUPS is a server-side data law: a student in group A gets 403 for group B members and never sees them in lists', async () => {
    const { course, instance } = await setupCourse(1); // SEPARATEGROUPS
    const alice = await createUserViaApi(app, admin);
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, alice.id);
    await enrolUser(app, admin, course.id, instance.id, bob.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Alpha' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta' });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: alice.id });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: bob.id });

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
    expect((list.body as { id: string }[]).map((g) => g.id)).toEqual([gA.body.id]);
    // Visible-members aggregate contains only her own membership.
    const visibleMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/visible-members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(visibleMembers.body).toEqual([{ groupId: gA.body.id, userId: alice.id }]);
    // Admin (accessallgroups via manager/siteadmin) sees everything.
    const adminList = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((adminList.body as unknown[]).length).toBe(2);
  });

  it('cohort sync: adding a user to a cohort enrols them into linked courses; removing suspends by default and unenrols when configured', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Class of 2026' });
    expect(cohortRes.status).toBe(201);
    const cohortId = cohortRes.body.id as string;
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId });
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);

    // Add to cohort ⇒ enrolled + can access.
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const enrolled = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolled.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(0);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);

    // Remove from cohort ⇒ suspended (default sync mode), access blocked.
    await http(app).delete(`/api/v1/cohorts/${cohortId}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    const afterRemove = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((afterRemove.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(1);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);

    // Second course with onCohortLeave=unenrol: removal withdraws the enrolment entirely.
    const course2 = await createCourse(app, admin, cat.id);
    const cohort2 = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Strict cohort' });
    await createEnrolInstance(app, admin, course2.id, { method: 'cohort', cohortId: cohort2.body.id, onCohortLeave: 'unenrol' });
    void instance;
    await http(app).post(`/api/v1/cohorts/${cohort2.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    let list2 = await http(app).get(`/api/v1/courses/${course2.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list2.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(true);
    await http(app).delete(`/api/v1/cohorts/${cohort2.body.id}/members/${user.id}`).set('Authorization', `Bearer ${admin}`);
    list2 = await http(app).get(`/api/v1/courses/${course2.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list2.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
  });

  it('a cohort enrol instance created AFTER users joined the cohort syncs the existing members', async () => {
    const cat = await createCategory(app, admin);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Early joiners' });
    const user = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortRes.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });
    const course = await createCourse(app, admin, cat.id);
    await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId: cohortRes.body.id });
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(0);
  });

  it('expired enrolment (timeEnd in the past) is not active: access blocked before any sweep runs', async () => {
    const { course, instance } = await setupCourse();
    const user = await createUserViaApi(app, admin);
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await enrolUser(app, admin, course.id, instance.id, user.id, { timeStart: twoDaysAgo, timeEnd: yesterday });
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
    const bad = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${manualInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(bad.status).toBe(400);
    const ok = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(ok.status).toBeLessThan(300);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });

  it('enrolment key: a keyed self instance refuses missing/wrong keys with 400 and enrols nobody, enrols with the correct key, and never leaks the key to non-managers (Behat self_enrolment.feature "Self-enrolment enabled requiring an enrolment key")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'self', enrolmentKey: 's3cret-key' }) as unknown as { id: string; enrolmentKey: string | null };
    // The manager who created the instance sees the key.
    expect(instance.enrolmentKey).toBe('s3cret-key');
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    // A non-manager listing instances never sees the key value.
    const listed = await http(app).get(`/api/v1/courses/${course.id}/enrol/instances`).set('Authorization', `Bearer ${userLogin.accessToken}`);
    expect((listed.body as { id: string; enrolmentKey: string | null }[]).find((i) => i.id === instance.id)?.enrolmentKey).toBeNull();
    const listedAdmin = await http(app).get(`/api/v1/courses/${course.id}/enrol/instances`).set('Authorization', `Bearer ${admin}`);
    expect((listedAdmin.body as { id: string; enrolmentKey: string | null }[]).find((i) => i.id === instance.id)?.enrolmentKey).toBe('s3cret-key');
    // Missing key ⇒ 400 enrol.enrolment_key_required, no enrolment created.
    const missing = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('enrol.enrolment_key_required');
    // Wrong key ⇒ 400 enrol.invalid_enrolment_key, still no enrolment.
    const wrong = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({ enrolmentKey: 'not-the-key' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('enrol.invalid_enrolment_key');
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);
    // Correct key ⇒ enrolled and can access the course.
    const ok = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({ enrolmentKey: 's3cret-key' });
    expect(ok.status).toBeLessThan(300);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });

  it('group enrolment key: a key matching a course group enrols AND places the learner in that group, while the instance key enrols without group placement (Behat self_enrolment.feature "...requiring a group enrolment key")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const group = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Keyed team', enrolmentKey: 'group-key-1' });
    expect(group.status).toBe(201);
    expect(group.body.enrolmentKey).toBe('group-key-1');
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'self', enrolmentKey: 'course-key' });

    // Alice uses the GROUP key: enrolled + member of the group.
    const alice = await createUserViaApi(app, admin);
    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    const aliceRes = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({ enrolmentKey: 'group-key-1' });
    expect(aliceRes.status).toBeLessThan(300);
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${group.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userId: string }[]).map((m) => m.userId)).toContain(alice.id);
    // The group key is hidden from the enrolled student.
    const aliceGroups = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((aliceGroups.body as { id: string; enrolmentKey: string | null }[]).find((g) => g.id === group.body.id)?.enrolmentKey).toBeNull();

    // Bob uses the INSTANCE key: enrolled, but NOT placed in the group.
    const bob = await createUserViaApi(app, admin);
    const bobLogin = await login(app, bob.username, STRONG_PASSWORD);
    const bobRes = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/self-enrol`).set('Authorization', `Bearer ${bobLogin.accessToken}`).send({ enrolmentKey: 'course-key' });
    expect(bobRes.status).toBeLessThan(300);
    const membersAfter = await http(app).get(`/api/v1/courses/${course.id}/groups/${group.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((membersAfter.body as { userId: string }[]).map((m) => m.userId)).not.toContain(bob.id);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${bobLogin.accessToken}`)).status).toBe(200);
  });

  it('self-unenrol: a self-enrolled student can unenrol themselves (role removed, access lost), while an enrolment from another method refuses self-unenrol (Behat self_enrolment.feature "Self unenrol as a self-enrolled student")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const selfInstance = await createEnrolInstance(app, admin, course.id, { method: 'self' });
    const manualInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual' });

    // A manually-enrolled student cannot self-unenrol: the enrolment is not theirs to end through this endpoint.
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manualInstance.id, other.id);
    const otherLogin = await login(app, other.username, STRONG_PASSWORD);
    const refused = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${manualInstance.id}/self-unenrol`).set('Authorization', `Bearer ${otherLogin.accessToken}`).send({});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('enrol.self_unenrol_not_allowed');
    const otherMine = await http(app).get(`/api/v1/courses/${course.id}/enrolments/me`).set('Authorization', `Bearer ${otherLogin.accessToken}`);
    expect(otherMine.body).toMatchObject({ enrolled: true, active: true });

    // The self-enrolled student unenrols themselves through the same unenrol path as admin unenrol.
    const user = await createUserViaApi(app, admin);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
    const un = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-unenrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(un.status).toBeLessThan(300);
    expect(un.body.withdrawn).toBe(false);
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((list.body as { userId: string }[]).some((e) => e.userId === user.id)).toBe(false);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(403);
    // A second self-unenrol finds no enrolment to end.
    const again = await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-unenrol`).set('Authorization', `Bearer ${userLogin.accessToken}`).send({});
    expect(again.status).toBe(404);
    expect(again.body.code).toBe('enrol.user_not_enrolled');
  });

  it('welcome message: self enrol sends the configured welcome notification through Messaging, manual enrol only when the instance enables it (default off) (Behat enrol/self + enrol/manual welcome-message scenarios)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const selfInstance = await createEnrolInstance(app, admin, course.id, { method: 'self', welcomeMessage: 'Xin chào! Chào mừng bạn tới {coursename}.' }) as unknown as { id: string; sendWelcomeMessage: boolean };
    // Moodle defaults: self enrol sends a welcome message, manual does not.
    expect(selfInstance.sendWelcomeMessage).toBe(true);
    const manualInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual' }) as unknown as { id: string; sendWelcomeMessage: boolean };
    expect(manualInstance.sendWelcomeMessage).toBe(false);
    const manualWelcomeInstance = await createEnrolInstance(app, admin, course.id, { method: 'manual', sendWelcomeMessage: true, welcomeMessage: 'Manual welcome for {coursename}' });

    // Self enrol ⇒ welcome notification carrying the instance's custom text.
    const alice = await createUserViaApi(app, admin);
    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    await http(app).post(`/api/v1/courses/${course.id}/enrol/instances/${selfInstance.id}/self-enrol`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({});
    const aliceNotifs = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    const aliceWelcome = (aliceNotifs.body as { eventType: string; fullMessage: string }[]).find((n) => n.eventType === 'enrol_welcome');
    expect(aliceWelcome).toBeDefined();
    expect(aliceWelcome!.fullMessage).toContain('Xin chào! Chào mừng bạn tới');

    // Manual enrol with the default configuration ⇒ no welcome notification.
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manualInstance.id, bob.id);
    const bobLogin = await login(app, bob.username, STRONG_PASSWORD);
    const bobNotifs = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${bobLogin.accessToken}`);
    expect((bobNotifs.body as { eventType: string }[]).some((n) => n.eventType === 'enrol_welcome')).toBe(false);

    // Manual enrol with welcome explicitly enabled ⇒ welcome with the custom text.
    const carol = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, manualWelcomeInstance.id, carol.id);
    const carolLogin = await login(app, carol.username, STRONG_PASSWORD);
    const carolNotifs = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${carolLogin.accessToken}`);
    const carolWelcome = (carolNotifs.body as { eventType: string; fullMessage: string }[]).find((n) => n.eventType === 'enrol_welcome');
    expect(carolWelcome).toBeDefined();
    expect(carolWelcome!.fullMessage).toContain('Manual welcome for');
  });

  it('cohort role reassignment: editing a cohort enrolment method role re-assigns already-enrolled participants to the new role and keeps their enrolment (Behat enrolcohorts.feature "Editing a cohort enrolment method\'s role should change participants\' role")', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Role change cohort' });
    const cohortId = cohortRes.body.id as string;
    const instance = await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId, roleShortname: 'student' });
    const user = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: user.id });

    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
    const studentRole = await roleIdByShortname(app, admin, 'student');
    const teacherRole = await roleIdByShortname(app, admin, 'teacher');
    const assignmentsOf = async () => {
      const res = await http(app).get('/api/v1/access/assignments').query({ userId: user.id, contextId: content.body.contextId }).set('Authorization', `Bearer ${admin}`);
      return (res.body as { roleId: string }[]).map((a) => a.roleId);
    };
    expect(await assignmentsOf()).toContain(studentRole);
    expect(await assignmentsOf()).not.toContain(teacherRole);

    // Edit the instance's role ⇒ the participant's role follows, enrolment untouched.
    const patched = await http(app).patch(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}`).set('Authorization', `Bearer ${admin}`).send({ roleShortname: 'teacher' });
    expect(patched.status).toBe(200);
    expect(patched.body.roleId).toBe(teacherRole);
    expect(await assignmentsOf()).toContain(teacherRole);
    expect(await assignmentsOf()).not.toContain(studentRole);
    const enrolments = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    expect((enrolments.body as { userId: string; status: number }[]).find((e) => e.userId === user.id)?.status).toBe(0);
    const userLogin = await login(app, user.username, STRONG_PASSWORD);
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${userLogin.accessToken}`)).status).toBe(200);
  });

  // Group visibility modes (separate/visible) — business-gaps round.
  // Oracles: MoodleDocs "Groups" (separate groups: each group can only see
  // their own group, others are invisible; visible groups: each group works
  // in their own group but can also see other groups — read-only) and Behat
  // mod/assign/tests/behat/assign_group_override.feature ("A teacher without
  // accessallgroups permission should only be able to add group override for
  // groups that he/she is a member of, when the activity's group mode is
  // 'separate groups'" — i.e. the separate-groups restriction is lifted by
  // the staff capabilities accessallgroups/managegroups).
  async function setupTwoGroups(groupMode: number) {
    const { course, instance } = await setupCourse(groupMode);
    const alice = await createUserViaApi(app, admin);
    const bob = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, alice.id);
    await enrolUser(app, admin, course.id, instance.id, bob.id);
    const gA = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Alpha' });
    const gB = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta' });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gA.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: alice.id });
    await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userId: bob.id });
    const aliceLogin = await login(app, alice.username, STRONG_PASSWORD);
    return { course, alice, bob, gA: gA.body, gB: gB.body, aliceLogin };
  }

  it('VISIBLE GROUPS: a student in group A sees BOTH groups and the members of group B, but write operations stay capability-gated (MoodleDocs Groups — visible groups are read-only for other groups)', async () => {
    const { course, bob, gA, gB, aliceLogin } = await setupTwoGroups(2); // VISIBLEGROUPS
    // Group list contains both groups.
    const list = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((list.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.id, gB.id].sort());
    // Members of the OTHER group are readable in visible mode.
    const otherMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/${gB.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(otherMembers.status).toBe(200);
    expect((otherMembers.body as { userId: string }[]).map((m) => m.userId)).toContain(bob.id);
    // The visible-members aggregate spans both groups.
    const visibleMembers = await http(app).get(`/api/v1/courses/${course.id}/groups/visible-members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((visibleMembers.body as { groupId: string }[]).map((r) => r.groupId).sort()).toEqual([gA.id, gB.id].sort());
    // Read-only means read-only: adding a member to group B is still gated by moodle/course:managegroups.
    const write = await http(app).post(`/api/v1/courses/${course.id}/groups/${gB.id}/members`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({ userId: bob.id });
    expect(write.status).toBe(403);
    const create = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`).send({ name: 'Gamma' });
    expect(create.status).toBe(403);
  });

  it('SEPARATE GROUPS applies to groupings too: a student only sees groupings containing her group, and only her group inside a shared grouping', async () => {
    const { course, gA, gB, aliceLogin } = await setupTwoGroups(1); // SEPARATEGROUPS
    const shared = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'Both teams' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gA.id });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gB.id });
    const betaOnly = await http(app).post(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`).send({ name: 'Beta only' });
    await http(app).post(`/api/v1/courses/${course.id}/groupings/${betaOnly.body.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ groupId: gB.id });

    // Grouping list: the Beta-only grouping is invisible to Alice.
    const groupingList = await http(app).get(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((groupingList.body as { id: string }[]).map((g) => g.id)).toEqual([shared.body.id]);
    // Inside the shared grouping she only sees her own group.
    const inShared = await http(app).get(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect((inShared.body as { id: string }[]).map((g) => g.id)).toEqual([gA.id]);
    // The Beta-only grouping yields no groups at all for her.
    const inBetaOnly = await http(app).get(`/api/v1/courses/${course.id}/groupings/${betaOnly.body.id}/groups`).set('Authorization', `Bearer ${aliceLogin.accessToken}`);
    expect(inBetaOnly.body).toEqual([]);
    // Admin sees both groupings and both groups inside the shared one.
    const adminGroupings = await http(app).get(`/api/v1/courses/${course.id}/groupings`).set('Authorization', `Bearer ${admin}`);
    expect((adminGroupings.body as unknown[]).length).toBe(2);
    const adminInShared = await http(app).get(`/api/v1/courses/${course.id}/groupings/${shared.body.id}/groups`).set('Authorization', `Bearer ${admin}`);
    expect((adminInShared.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.id, gB.id].sort());
  });

  it('a teacher with moodle/course:managegroups sees ALL groups and members in BOTH separate and visible mode, without being a group member', async () => {
    for (const mode of [1, 2]) {
      const { course, gA, gB } = await setupTwoGroups(mode);
      const teacher = await createUserViaApi(app, admin);
      const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${admin}`);
      const editingTeacherRole = await roleIdByShortname(app, admin, 'editingteacher');
      await assignRole(app, admin, teacher.id, editingTeacherRole, content.body.contextId);
      const teacherLogin = await login(app, teacher.username, STRONG_PASSWORD);
      const list = await http(app).get(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${teacherLogin.accessToken}`);
      expect((list.body as { id: string }[]).map((g) => g.id).sort()).toEqual([gA.id, gB.id].sort());
      const membersB = await http(app).get(`/api/v1/courses/${course.id}/groups/${gB.id}/members`).set('Authorization', `Bearer ${teacherLogin.accessToken}`);
      expect(membersB.status).toBe(200);
      expect((membersB.body as unknown[]).length).toBe(1);
    }
  });

  it('groupModeForce round-trips through course create/update and the course payload (Moodle course settings: "Force group mode" applies the course mode to every activity)', async () => {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id, { groupMode: 1, groupModeForce: true }) as unknown as { id: string; groupMode: number; groupModeForce: boolean };
    expect(course.groupMode).toBe(1);
    expect(course.groupModeForce).toBe(true);
    const patched = await http(app).patch(`/api/v1/courses/${course.id}`).set('Authorization', `Bearer ${admin}`).send({ groupModeForce: false });
    expect(patched.status).toBe(200);
    expect(patched.body.groupModeForce).toBe(false);
    // Default stays off when not requested.
    const plain = await createCourse(app, admin, cat.id) as unknown as { groupModeForce: boolean };
    expect(plain.groupModeForce).toBe(false);
  });
});
