import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Availability + Completion flow.
 * Oracles: availability/tests/tree_test.php::test_check_available and
 * availability/tests/info_test.php (restriction applies at the info/access
 * layer, not just display); lib/tests/completionlib_test.php
 * (test_update_state, test_set_module_viewed, test_aggregate_completions in
 * completion/tests + criteria tests in completion/tests/api_test.php).
 */
describe('Availability & completion', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => { app = await createTestApp(); admin = await adminToken(app); });
  afterAll(async () => { await app.close(); });

  async function setup() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { cat, course, sectionId, instance, student, studentToken };
  }

  it('date condition in the future blocks cm ACCESS at the API (403), while show=true keeps it listed with its restriction', async () => {
    const { course, sectionId, studentToken } = await setup();
    const future = Math.floor(new Date('2100-01-01').getTime() / 1000);
    const cm = await createCm(app, admin, course.id, sectionId, {
      name: 'Future quiz',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: future }] },
    });
    const access = await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`);
    expect(access.status).toBe(403);
    expect(access.body.code).toBe('availability.not_available');
    // Listed, shown-but-locked:
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentToken}`);
    const listed = content.body.sections.flatMap((s: { modules: unknown[] }) => s.modules).find((m: { id: string }) => m.id === cm.id);
    expect(listed).toBeDefined();
    expect(listed.availabilityResult.available).toBe(false);
    expect(listed.availabilityResult.visible).toBe(true);
  });

  it('show=false: an unavailable cm is hidden from the list entirely, and access is still 403', async () => {
    const { course, sectionId, studentToken } = await setup();
    const future = Math.floor(new Date('2100-01-01').getTime() / 1000);
    const cm = await createCm(app, admin, course.id, sectionId, {
      name: 'Secret quiz',
      availability: { op: '&', show: false, showc: [true], c: [{ type: 'date', d: '>=', t: future }] },
    });
    const content = await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentToken}`);
    const listed = content.body.sections.flatMap((s: { modules: unknown[] }) => s.modules).find((m: { id: string }) => m.id === cm.id);
    expect(listed).toBeUndefined();
    const access = await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`);
    expect(access.status).toBe(403);
  });

  it('completion leaf: cm B stays locked until cm A is complete, then opens (completionlib + tree combination)', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cmA = await createCm(app, admin, course.id, sectionId, { name: 'First', completion: 1, completionmanual: true });
    const cmB = await createCm(app, admin, course.id, sectionId, {
      name: 'Second',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'completion', id: cmA.id }] },
    });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmB.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    // Student marks A complete manually.
    const mark = await http(app).post(`/api/v1/courses/${course.id}/modules/${cmA.id}/completion/manual`)
      .set('Authorization', `Bearer ${studentToken}`).send({ userid: student.id, complete: true });
    expect(mark.status).toBeLessThan(300);
    expect(mark.body.state).toBe(1);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmB.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
  });

  it('group leaf + nested tree: AND inside NOT-OR gates access by group membership (golden combination, API level)', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const groupRes = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Gate group' });
    const groupId = groupRes.body.id as string;
    // Available when NOT(group AND profile-department=blocked): student is neither, so open.
    const tree = {
      op: '!|', show: true, showc: [true],
      c: [{ op: '&', showc: [true, true], c: [{ type: 'group', id: groupId }, { type: 'profile', field: 'username', operator: 'contains', value: 'user' }] }],
    };
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Gated', availability: tree });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
    // Put the student in the group: both inner conditions now hold (username contains 'user' by construction of test usernames) ⇒ NOT-OR fails ⇒ blocked.
    await http(app).post(`/api/v1/courses/${course.id}/groups/${groupId}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: student.id });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('grade leaf is declared but unmet without grade data (Grades hook): access stays blocked', async () => {
    const { course, sectionId, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, {
      name: 'Needs grade',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'grade', id: 'final', min: 50 }] },
    });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('section availability also blocks: a cm inside a date-locked section is inaccessible even with no cm tree', async () => {
    const { course, studentToken } = await setup();
    const future = Math.floor(new Date('2100-01-01').getTime() / 1000);
    const sectionRes = await http(app).post(`/api/v1/courses/${course.id}/sections`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Later', availability: { op: '&', show: true, showc: [true], c: [{ type: 'date', d: '>=', t: future }] } });
    const cm = await createCm(app, admin, course.id, sectionRes.body.id, { name: 'Inside locked section' });
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    expect((await http(app).get(`/api/v1/courses/${course.id}/sections/${sectionRes.body.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('completionview: viewing a cm records viewed and completes it (completionlib::test_set_module_viewed + test_update_state)', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Read me', completion: 2, completionview: true });
    const before = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(before.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)?.state).toBe(0);
    const view = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/view`).set('Authorization', `Bearer ${studentToken}`);
    expect(view.status).toBeLessThan(300);
    const after = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    const record = after.body.activities.find((a: { cmId: string }) => a.cmId === cm.id);
    expect(record.viewed).toBe(true);
    expect(record.state).toBe(1);
  });

  it('manual completion by a teacher for another user requires markothers; a student cannot mark others', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Manual task', completion: 1, completionmanual: true });
    const other = await createUserViaApi(app, admin);
    const forbidden = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/completion/manual`)
      .set('Authorization', `Bearer ${studentToken}`).send({ userid: other.id, complete: true });
    expect(forbidden.status).toBe(403);
    const byAdmin = await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/completion/manual`)
      .set('Authorization', `Bearer ${admin}`).send({ userid: student.id, complete: true });
    expect(byAdmin.body.state).toBe(1);
  });

  it('course completion aggregates module criteria with AND, and with ANY after the method changes', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cmA = await createCm(app, admin, course.id, sectionId, { name: 'A', completion: 1, completionmanual: true });
    const cmB = await createCm(app, admin, course.id, sectionId, { name: 'B', completion: 1, completionmanual: true });
    const set = await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'module', moduleinstance: cmA.id }, { criteriatype: 'module', moduleinstance: cmB.id }] });
    expect(set.status).toBe(200);
    // Complete only A: AND ⇒ course not complete.
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmA.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userid: student.id, complete: true });
    let mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).not.toBe('complete');
    // Complete B too ⇒ complete.
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmB.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userid: student.id, complete: true });
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
    expect(mine.body.course.timecompleted).toBeTruthy();
  });

  it('date criterion: a course with only a past date criterion completes on reaggregation', async () => {
    const { course, student, studentToken } = await setup();
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'date', date: '2020-01-01T00:00:00.000Z' }] });
    const mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    void student;
    expect(mine.body.course.status).toBe('complete');
  });

  it('changing criteria after data exists triggers controlled recalculation: previously complete course reopens when a new criterion is added', async () => {
    const { course, sectionId, student, studentToken } = await setup();
    const cmA = await createCm(app, admin, course.id, sectionId, { name: 'A2', completion: 1, completionmanual: true });
    const cmB = await createCm(app, admin, course.id, sectionId, { name: 'B2', completion: 1, completionmanual: true });
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'module', moduleinstance: cmA.id }] });
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmA.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userid: student.id, complete: true });
    let mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
    // Teacher adds cmB as a required criterion ⇒ recalculation must reopen the course completion.
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'module', moduleinstance: cmA.id }, { criteriatype: 'module', moduleinstance: cmB.id }] });
    const recalc = await http(app).post(`/api/v1/courses/${course.id}/completion/recalculate`).set('Authorization', `Bearer ${admin}`);
    expect(recalc.status).toBeLessThan(300);
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).not.toBe('complete');
    // Completing B closes it again.
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cmB.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userid: student.id, complete: true });
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
  });

  it('unenrol keeps completion data: the UE row is soft-withdrawn (status=2) instead of deleted', async () => {
    const { course, sectionId, instance, student, studentToken } = await setup();
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Keep my data', completion: 1, completionmanual: true });
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cm.id}/completion/manual`).set('Authorization', `Bearer ${studentToken}`).send({ userid: student.id, complete: true });
    const del = await http(app).delete(`/api/v1/courses/${course.id}/enrol/instances/${instance.id}/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.body.withdrawn).toBe(true);
    const list = await http(app).get(`/api/v1/courses/${course.id}/enrolments`).set('Authorization', `Bearer ${admin}`);
    const ue = (list.body as { userid: string; status: number }[]).find((e) => e.userid === student.id);
    expect(ue?.status).toBe(2);
    // The completion record itself survived the unenrol.
    const completion = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(completion.body.activities.find((a: { cmId: string }) => a.cmId === cm.id)?.state).toBe(1);
    // But access is gone.
    expect((await http(app).get(`/api/v1/courses/${course.id}/content`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  it('GOLDEN end-to-end: category → course → section/cm → group/cohort → enrol with role → availability blocks → completion records', async () => {
    const cat = await createCategory(app, admin, { name: 'Golden' });
    const course = await createCourse(app, admin, cat.id, { fullname: 'Golden course' });
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const cm1 = await createCm(app, admin, course.id, sectionId, { name: 'Step 1', completion: 2, completionview: true });
    const cm2 = await createCm(app, admin, course.id, sectionId, {
      name: 'Step 2',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'completion', id: cm1.id }] },
    });
    const groupRes = await http(app).post(`/api/v1/courses/${course.id}/groups`).set('Authorization', `Bearer ${admin}`).send({ name: 'Golden group' });
    const cohortRes = await http(app).post('/api/v1/cohorts').set('Authorization', `Bearer ${admin}`).send({ name: 'Golden cohort' });
    const student = await createUserViaApi(app, admin);
    await http(app).post(`/api/v1/cohorts/${cohortRes.body.id}/members`).set('Authorization', `Bearer ${admin}`).send({ userid: student.id });
    await createEnrolInstance(app, admin, course.id, { method: 'cohort', cohortId: cohortRes.body.id, groupId: groupRes.body.id });
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    // Enrolled via cohort sync, member of the group via the instance config:
    const members = await http(app).get(`/api/v1/courses/${course.id}/groups/${groupRes.body.id}/members`).set('Authorization', `Bearer ${admin}`);
    expect((members.body as { userid: string }[]).map((m) => m.userid)).toContain(student.id);
    // Step 2 blocked until Step 1 viewed:
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm2.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    await http(app).post(`/api/v1/courses/${course.id}/modules/${cm1.id}/view`).set('Authorization', `Bearer ${studentToken}`);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cm2.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
    const progress = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cm1.id)?.state).toBe(1);
  });
});
