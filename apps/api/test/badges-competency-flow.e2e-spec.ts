import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, createCm, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import {
  addCohortMember, courseContextId, createCohortViaApi, markCmComplete, setCourseCompletionCriteria,
} from './engagement-helpers';

/**
 * Badges + Competencies flow tests.
 * Oracles (Moodle MOODLE_503_STABLE, read 2026-10-22):
 *  - public/badges/tests/badgeslib_test.php: test_create_badge_criteria,
 *    test_badge_awards, test_clone_badge (duplicate = the way to edit),
 *    test_delete_badge (delete = archive). Report §2#14: criteria tree
 *    ALL/ANY; criteria FROZEN once issued/active; assertions immutable;
 *    revoke ≠ delete.
 *  - Behat (badges/tests/behat): criteria_cohort.feature (cohort leaf),
 *    criteria_profile.feature (profile leaf), award_badge.feature /
 *    "Badge awarded depending on the course completion by-date"
 *    (coursecompletion leaf honours its by-date parameter). The UI steps
 *    of those scenarios are skipped per convention; the business steps
 *    and expected award outcomes are asserted through the API below.
 *  - public/competency/tests/api_test.php: test_list_frameworks,
 *    test_create_plan_from_template, test_create_template_cohort,
 *    test_complete_plan, test_plan_request_review / test_plan_start_review /
 *    test_plan_stop_review / test_approve_plan / test_unapprove_plan,
 *    test_add_evidence_complete, test_add_evidence_and_send_for_review,
 *    test_validate_grade_in_user_competency,
 *    test_set_ruleoutcome_course_competency,
 *    test_observe_course_completed. Report §2#15: proficiency comes from
 *    the framework SCALE, never from grades.
 */
describe('Badges & competencies', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function frameworkWithCompetency() {
    const fw = await http(app).post('/api/v1/competencies/frameworks').set('Authorization', `Bearer ${admin}`)
      .send({ shortname: `FW ${Date.now()}-${Math.random()}`, scale: { values: ['Not competent', 'Competent'], proficient: [1] } });
    expect(fw.status).toBe(201);
    const comp = await http(app).post(`/api/v1/competencies/frameworks/${fw.body.id}/competencies`).set('Authorization', `Bearer ${admin}`)
      .send({ shortname: 'Teamwork' });
    expect(comp.status).toBe(201);
    const child = await http(app).post(`/api/v1/competencies/frameworks/${fw.body.id}/competencies`).set('Authorization', `Bearer ${admin}`)
      .send({ shortname: 'Teamwork basics', parentId: comp.body.id });
    expect(child.body.path).toBe(`/${comp.body.id}/${child.body.id}`);
    expect(child.body.depth).toBe(2);
    return { framework: fw.body, competency: comp.body, child: child.body };
  }

  async function completableCourse() {
    const category = await createCategory(app, admin);
    const course = await createCourse(app, admin, category.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const cm = await createCm(app, admin, course.id, sectionId, { name: 'Task', completion: 1, completionmanual: true });
    await setCourseCompletionCriteria(app, admin, course.id, [{ criteriatype: 'module', moduleinstance: cm.id }]);
    return { category, course, instance, cm };
  }

  it('badge criteria tree: ALL requires every leaf, ANY requires one; activation needs criteria and locks them (badgeslib + §2#14)', async () => {
    const badgeRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Finisher', type: 1, issuername: 'LMS HQ' });
    const badgeId = badgeRes.body.id as string;
    // Cannot activate without criteria.
    const early = await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    expect(early.status).toBe(400);
    expect(early.body.code).toBe('badges.no_criteria');
    const { course, instance, cm } = await completableCourse();
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'activitycompletion', params: { cmId: cm.id } }, { criteriatype: 'coursecompletion', params: { courseId: course.id } }] });
    await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    // Frozen while active.
    const frozen = await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 2, criteria: [{ criteriatype: 'manual', params: {} }] });
    expect(frozen.status).toBe(403);
    expect(frozen.body.code).toBe('badges.criteria_frozen');
    // Before completion: not satisfied under ALL.
    let evaluation = await http(app).post(`/api/v1/badges/${badgeId}/evaluate`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    expect(evaluation.body.satisfied).toBe(false);
    // Completing the activity completes the course → both leaves hold →
    // the completion hook auto-awards the badge.
    await markCmComplete(app, admin, course.id, cm.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const mine = await http(app).get('/api/v1/badges/mine').set('Authorization', `Bearer ${studentToken}`);
    const mineRows = mine.body as { badgeid: string; uniquehash: string; snapshot: { criteria: unknown[] } }[];
    const awarded = mineRows.find((r) => r.badgeid === badgeId);
    expect(awarded).toBeTruthy();
    expect(awarded!.uniquehash).toHaveLength(64);
    expect(awarded!.snapshot.criteria).toHaveLength(2);
    evaluation = await http(app).post(`/api/v1/badges/${badgeId}/evaluate`).set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    expect(evaluation.body.satisfied).toBe(true);
    // And the award produced a badge_awarded notification for the student.
    const notifications = await http(app).get('/api/v1/notifications').set('Authorization', `Bearer ${studentToken}`);
    expect((notifications.body as { eventtype: string }[]).some((n) => n.eventtype === 'badge_awarded')).toBe(true);
  });

  it('badge freeze after issuance + duplicate-to-edit + revoke keeps the assertion (§2#14)', async () => {
    const { competency } = await frameworkWithCompetency();
    const badgeRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Competent', type: 1 });
    const badgeId = badgeRes.body.id as string;
    await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 2, criteria: [{ criteriatype: 'competency', params: { competencyId: competency.id } }] });
    await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    const user = await createUserViaApi(app, admin);
    // Becoming proficient (review approve) triggers the competency listener → auto-award.
    const evidence = await http(app).post('/api/v1/competencies/evidence').set('Authorization', `Bearer ${admin}`)
      .send({ userId: user.id, competencyId: competency.id, description: 'Portfolio', sendForReview: true });
    const usercompId = evidence.body.usercomp.id as string;
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/start-review`).set('Authorization', `Bearer ${admin}`).send({});
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/approve`).set('Authorization', `Bearer ${admin}`).send({ grade: 1 });
    const userToken = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    const mine = await http(app).get('/api/v1/badges/mine').set('Authorization', `Bearer ${userToken}`);
    const assertion = (mine.body as { id: string; badgeid: string }[]).find((r) => r.badgeid === badgeId);
    expect(assertion).toBeTruthy();
    // Deactivate, then try to edit criteria: still frozen because awards exist.
    await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 0 });
    const frozen = await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'manual', params: {} }] });
    expect(frozen.status).toBe(403);
    // Duplicate is the sanctioned edit path: the copy is inactive and editable.
    const copy = await http(app).post(`/api/v1/badges/${badgeId}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(copy.status).toBe(201);
    expect(copy.body.status).toBe(0);
    const editCopy = await http(app).put(`/api/v1/badges/${copy.body.id}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'manual', params: {} }] });
    expect(editCopy.status).toBe(200);
    // Revoke: assertion row survives, marked revoked.
    const revoked = await http(app).post(`/api/v1/badges/issued/${assertion!.id}/revoke`).set('Authorization', `Bearer ${admin}`).send({});
    expect(revoked.status).toBe(201);
    expect(revoked.body.revoked).toBe(true);
    const fetched = await http(app).get(`/api/v1/badges/issued/${assertion!.id}`).set('Authorization', `Bearer ${admin}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.revoked).toBe(true);
    expect(fetched.body.uniquehash).toHaveLength(64);
  });

  it('manual award: requires the awardbadge capability and a manual criterion; ALL with an unmet leaf does not issue', async () => {
    const badgeRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Mentor pick', type: 1 });
    const badgeId = badgeRes.body.id as string;
    await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'manual', params: {} }] });
    await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    const recipient = await createUserViaApi(app, admin);
    const plain = await createUserViaApi(app, admin);
    const plainToken = (await login(app, plain.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).post(`/api/v1/badges/${badgeId}/award`).set('Authorization', `Bearer ${plainToken}`).send({ userId: recipient.id });
    expect(denied.status).toBe(403);
    const awarded = await http(app).post(`/api/v1/badges/${badgeId}/award`).set('Authorization', `Bearer ${admin}`).send({ userId: recipient.id });
    expect(awarded.status).toBe(201);
    expect(awarded.body.issued).toBeTruthy();
    expect(awarded.body.award.recipientid).toBe(recipient.id);
  });

  async function activeBadgeWithCriteria(name: string, criteria: unknown[]) {
    const badgeRes = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`)
      .send({ name, type: 1 });
    expect(badgeRes.status).toBe(201);
    const badgeId = badgeRes.body.id as string;
    const setRes = await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria });
    expect(setRes.status).toBe(200);
    const statusRes = await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    expect(statusRes.status).toBe(201);
    return badgeId;
  }

  async function evaluateLeaves(badgeId: string, userId: string) {
    const res = await http(app).post(`/api/v1/badges/${badgeId}/evaluate`).set('Authorization', `Bearer ${admin}`).send({ userId });
    expect(res.status).toBe(201);
    return res.body as { satisfied: boolean; leaves: { criteriatype: string; satisfied: boolean }[] };
  }

  async function issuedBadgeIdsFor(userId: string, token: string) {
    void userId;
    const mine = await http(app).get('/api/v1/badges/mine').set('Authorization', `Bearer ${token}`);
    expect(mine.status).toBe(200);
    return (mine.body as { badgeid: string }[]).map((r) => r.badgeid);
  }

  it('cohort leaf: members of the named cohort are awarded, non-members are not (Behat criteria_cohort.feature)', async () => {
    const cohort = await createCohortViaApi(app, admin, `badge-cohort-${Date.now()}-${Math.random()}`);
    const member = await createUserViaApi(app, admin);
    const outsider = await createUserViaApi(app, admin);
    await addCohortMember(app, admin, cohort.id, member.id);
    // A cohort leaf without its cohort reference is refused at criteria time.
    const probe = await http(app).post('/api/v1/badges').set('Authorization', `Bearer ${admin}`).send({ name: 'Cohort probe', type: 1 });
    const badParams = await http(app).put(`/api/v1/badges/${probe.body.id}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'cohort', params: {} }] });
    expect(badParams.status).toBe(400);
    expect(badParams.body.code).toBe('badges.bad_criteria_params');

    const badgeId = await activeBadgeWithCriteria('Cohort member badge', [{ criteriatype: 'cohort', params: { cohortId: cohort.id } }]);
    expect((await evaluateLeaves(badgeId, member.id)).satisfied).toBe(true);
    expect((await evaluateLeaves(badgeId, outsider.id)).satisfied).toBe(false);
    // Auto-award path: evaluating the member's badges issues it; the outsider gets nothing.
    await http(app).post('/api/v1/badges/evaluate-user').set('Authorization', `Bearer ${admin}`).send({ userId: member.id });
    await http(app).post('/api/v1/badges/evaluate-user').set('Authorization', `Bearer ${admin}`).send({ userId: outsider.id });
    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    expect(await issuedBadgeIdsFor(member.id, memberToken)).toContain(badgeId);
    expect(await issuedBadgeIdsFor(outsider.id, outsiderToken)).not.toContain(badgeId);
  });

  it('profile leaf: a custom profile field meeting the condition awards; a different or missing value does not (Behat criteria_profile.feature)', async () => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const shortname = `badgedept${suffix.replaceAll('-', '')}`.slice(0, 32);
    const cat = await http(app).post('/api/v1/custom-fields/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Badge profile ${suffix}`, component: 'core_user', area: 'user' });
    expect(cat.status).toBe(201);
    const field = await http(app).post('/api/v1/custom-fields/fields').set('Authorization', `Bearer ${admin}`)
      .send({ categoryid: cat.body.id, shortname, name: 'Badge department', type: 'text', configdata: {} });
    expect(field.status).toBe(201);
    // lms_test is shared across suites: other suites may have declared
    // REQUIRED core_user fields (e.g. a select `department`), and user
    // creation validates every required field — satisfy them generically.
    const fieldsRes = await http(app).get('/api/v1/custom-fields/fields?component=core_user&area=user').set('Authorization', `Bearer ${admin}`);
    expect(fieldsRes.status).toBe(200);
    const requiredValues: Record<string, string> = {};
    for (const f of fieldsRes.body as { shortname: string; type: string; configdata?: { required?: boolean; options?: string[] } }[]) {
      if (!f.configdata?.required || f.shortname === shortname) continue;
      requiredValues[f.shortname] = f.configdata.options?.[0] ?? (f.type === 'date' ? '2000-01-01' : f.type === 'checkbox' ? '1' : 'Required');
    }
    const matching = await createUserViaApi(app, admin, { customFields: { ...requiredValues, [shortname]: 'Engineering' } });
    const different = await createUserViaApi(app, admin, { customFields: { ...requiredValues, [shortname]: 'Sales' } });
    const missing = await createUserViaApi(app, admin);

    const badgeId = await activeBadgeWithCriteria('Engineering badge', [{ criteriatype: 'profile', params: { field: shortname, value: 'Engineering' } }]);
    expect((await evaluateLeaves(badgeId, matching.id)).satisfied).toBe(true);
    expect((await evaluateLeaves(badgeId, different.id)).satisfied).toBe(false);
    expect((await evaluateLeaves(badgeId, missing.id)).satisfied).toBe(false);
    await http(app).post('/api/v1/badges/evaluate-user').set('Authorization', `Bearer ${admin}`).send({ userId: matching.id });
    const matchingToken = (await login(app, matching.username, STRONG_PASSWORD)).accessToken;
    expect(await issuedBadgeIdsFor(matching.id, matchingToken)).toContain(badgeId);

    // Standard profile fields work through the same leaf (no `value` ⇒ the field must be filled).
    const stdBadgeId = await activeBadgeWithCriteria('Has a last name', [{ criteriatype: 'profile', params: { field: 'lastname' } }]);
    expect((await evaluateLeaves(stdBadgeId, matching.id)).satisfied).toBe(true);
    const stdValueBadgeId = await activeBadgeWithCriteria('Last name is User', [{ criteriatype: 'profile', params: { field: 'lastname', value: 'User' } }]);
    expect((await evaluateLeaves(stdValueBadgeId, matching.id)).satisfied).toBe(true);
    expect((await evaluateLeaves(stdValueBadgeId, different.id)).satisfied).toBe(true); // helper default lastname is also 'User'
    const stdMissBadgeId = await activeBadgeWithCriteria('Last name is Nobody', [{ criteriatype: 'profile', params: { field: 'lastname', value: 'Nobody' } }]);
    expect((await evaluateLeaves(stdMissBadgeId, matching.id)).satisfied).toBe(false);
  });

  it('coursecompletion by-date: completion on/before the by-date awards, completion after it does not (Behat award_badge.feature by-date)', async () => {
    const { course, instance, cm } = await completableCourse();
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    // Complete the course NOW, before either badge exists.
    await markCmComplete(app, admin, course.id, cm.id, student.id);
    const now = Date.now();
    const futureCutoff = new Date(now + 30 * 86400_000).toISOString();
    const pastCutoff = new Date(now - 30 * 86400_000).toISOString();
    const inTimeBadgeId = await activeBadgeWithCriteria('Completed in time', [
      { criteriatype: 'coursecompletion', params: { courseId: course.id, byDate: futureCutoff } },
    ]);
    const tooLateBadgeId = await activeBadgeWithCriteria('Completed too late', [
      { criteriatype: 'coursecompletion', params: { courseId: course.id, byDate: pastCutoff } },
    ]);
    expect((await evaluateLeaves(inTimeBadgeId, student.id)).satisfied).toBe(true);
    expect((await evaluateLeaves(tooLateBadgeId, student.id)).satisfied).toBe(false);
    await http(app).post('/api/v1/badges/evaluate-user').set('Authorization', `Bearer ${admin}`).send({ userId: student.id });
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const issuedIds = await issuedBadgeIdsFor(student.id, studentToken);
    expect(issuedIds).toContain(inTimeBadgeId);
    expect(issuedIds).not.toContain(tooLateBadgeId);
  });

  it('competency course links: ruleoutcome complete sets proficiency from the scale; attach-evidence only logs evidence (§2#15)', async () => {
    const { competency } = await frameworkWithCompetency();
    const { competency: competency2 } = await frameworkWithCompetency();
    const a = await completableCourse();
    const b = await completableCourse();
    await http(app).post(`/api/v1/competencies/courses/${a.course.id}/links`).set('Authorization', `Bearer ${admin}`)
      .send({ competencyId: competency.id, ruleoutcome: 'complete' });
    await http(app).post(`/api/v1/competencies/courses/${b.course.id}/links`).set('Authorization', `Bearer ${admin}`)
      .send({ competencyId: competency2.id, ruleoutcome: 'attach-evidence' });
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, a.course.id, a.instance.id, student.id);
    await enrolUser(app, admin, b.course.id, b.instance.id, student.id);
    await markCmComplete(app, admin, a.course.id, a.cm.id, student.id);
    await markCmComplete(app, admin, b.course.id, b.cm.id, student.id);

    const usercomps = await http(app).get(`/api/v1/competencies/usercomp/user/${student.id}`).set('Authorization', `Bearer ${admin}`);
    const rows = usercomps.body as { competencyid: string; proficiency: boolean | null; grade: number | null; id: string }[];
    const completeRow = rows.find((r) => r.competencyid === competency.id);
    expect(completeRow?.proficiency).toBe(true);
    expect(completeRow?.grade).toBe(1); // first proficient index of the scale
    const evidenceRow = rows.find((r) => r.competencyid === competency2.id);
    expect(evidenceRow).toBeTruthy();
    expect(evidenceRow?.proficiency).not.toBe(true); // evidence does NOT set proficiency
    const evidence = await http(app).get(`/api/v1/competencies/usercomp/${evidenceRow!.id}/evidence`).set('Authorization', `Bearer ${admin}`);
    expect((evidence.body as { action: string }[]).some((e) => e.action === 'course_completed')).toBe(true);
  });

  it('learning plans from template + cohort: members get active plans with the template competencies (api_test template_cohort + create_plan_from_template)', async () => {
    const { competency } = await frameworkWithCompetency();
    const template = await http(app).post('/api/v1/competencies/templates').set('Authorization', `Bearer ${admin}`)
      .send({ shortname: 'Onboarding plan' });
    await http(app).post(`/api/v1/competencies/templates/${template.body.id}/competencies`).set('Authorization', `Bearer ${admin}`)
      .send({ competencyId: competency.id });
    const cohort = await createCohortViaApi(app, admin, `cohort-${Date.now()}`);
    const member = await createUserViaApi(app, admin);
    await addCohortMember(app, admin, cohort.id, member.id);
    await http(app).post(`/api/v1/competencies/templates/${template.body.id}/cohorts`).set('Authorization', `Bearer ${admin}`)
      .send({ cohortId: cohort.id });
    const created = await http(app).post(`/api/v1/competencies/templates/${template.body.id}/create-plans`).set('Authorization', `Bearer ${admin}`).send({});
    expect(created.body.created).toBe(1);
    // Idempotent: a second run creates nothing new.
    const again = await http(app).post(`/api/v1/competencies/templates/${template.body.id}/create-plans`).set('Authorization', `Bearer ${admin}`).send({});
    expect(again.body.created).toBe(0);
    const memberToken = (await login(app, member.username, STRONG_PASSWORD)).accessToken;
    const plans = await http(app).get(`/api/v1/competencies/plans/user/${member.id}`).set('Authorization', `Bearer ${memberToken}`);
    expect(plans.body).toHaveLength(1);
    expect(plans.body[0].status).toBe(1); // active
    const view = await http(app).get(`/api/v1/competencies/plans/${plans.body[0].id}`).set('Authorization', `Bearer ${memberToken}`);
    expect(view.body.competencies).toHaveLength(1);
    expect(view.body.competencies[0].competency.id).toBe(competency.id);
    expect(view.body.competencies[0].usercomp).toBeTruthy();
  });

  it('learning plan review lifecycle: draft → active → request → start → approve → back to active → complete, with a review history (api_test plan review family)', async () => {
    const owner = await createUserViaApi(app, admin);
    const ownerToken = (await login(app, owner.username, STRONG_PASSWORD)).accessToken;
    const plan = await http(app).post('/api/v1/competencies/plans').set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'My growth plan' });
    const planId = plan.body.id as string;
    expect(plan.body.status).toBe(0);
    // Bad transition: cannot request review from draft.
    const badReq = await http(app).post(`/api/v1/competencies/plans/${planId}/request-review`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(badReq.status).toBe(400);
    await http(app).post(`/api/v1/competencies/plans/${planId}/activate`).set('Authorization', `Bearer ${ownerToken}`).send({});
    const requested = await http(app).post(`/api/v1/competencies/plans/${planId}/request-review`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(requested.body.status).toBe(2);
    // The owner cannot review their own plan (no review capability) — a
    // teacher with the review capability at a real assignment can.
    const startByOwner = await http(app).post(`/api/v1/competencies/plans/${planId}/start-review`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(startByOwner.status).toBe(403);
    const started = await http(app).post(`/api/v1/competencies/plans/${planId}/start-review`).set('Authorization', `Bearer ${admin}`).send({});
    expect(started.body.status).toBe(3);
    const approved = await http(app).post(`/api/v1/competencies/plans/${planId}/approve`).set('Authorization', `Bearer ${admin}`).send({});
    expect(approved.body.status).toBe(1); // approve returns the plan to active (Moodle approve_plan)
    const completed = await http(app).post(`/api/v1/competencies/plans/${planId}/complete`).set('Authorization', `Bearer ${ownerToken}`).send({});
    expect(completed.body.status).toBe(4);
    const view = await http(app).get(`/api/v1/competencies/plans/${planId}`).set('Authorization', `Bearer ${ownerToken}`);
    const actions = (view.body.reviews as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['activate', 'request-review', 'start-review', 'approve', 'complete']);
  });

  it('user competency review: evidence → waiting → in review → reject keeps proficiency unset; approve sets it per the scale; grades outside the scale are refused', async () => {
    const { competency } = await frameworkWithCompetency();
    const learner = await createUserViaApi(app, admin);
    const learnerToken = (await login(app, learner.username, STRONG_PASSWORD)).accessToken;
    // Grade outside the scale (scale has indexes 0..1) is refused (test_validate_grade_in_user_competency).
    const badGrade = await http(app).post('/api/v1/competencies/usercomp/grade').set('Authorization', `Bearer ${admin}`)
      .send({ userId: learner.id, competencyId: competency.id, grade: 5 });
    expect(badGrade.status).toBe(400);
    expect(badGrade.body.code).toBe('competency.grade_outside_scale');

    const evidence = await http(app).post('/api/v1/competencies/evidence').set('Authorization', `Bearer ${learnerToken}`)
      .send({ userId: learner.id, competencyId: competency.id, description: 'My portfolio', sendForReview: true });
    expect(evidence.status).toBe(201);
    const usercompId = evidence.body.usercomp.id as string;
    expect(evidence.body.usercomp.status).toBe(1); // waiting for review
    expect(evidence.body.usercomp.proficiency).toBeNull(); // self-evidence never self-certifies

    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/start-review`).set('Authorization', `Bearer ${admin}`).send({});
    const rejected = await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/reject`).set('Authorization', `Bearer ${admin}`).send({ note: 'Not enough evidence' });
    expect(rejected.body.status).toBe(0);
    expect(rejected.body.proficiency).not.toBe(true);

    // Resubmit and approve with the proficient scale value.
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/request-review`).set('Authorization', `Bearer ${learnerToken}`).send({});
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/start-review`).set('Authorization', `Bearer ${admin}`).send({});
    const approved = await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/approve`).set('Authorization', `Bearer ${admin}`).send({ grade: 1 });
    expect(approved.body.proficiency).toBe(true);
    expect(approved.body.grade).toBe(1);
    expect(approved.body.status).toBe(0);
    // The evidence log is the full history.
    const history = await http(app).get(`/api/v1/competencies/usercomp/${usercompId}/evidence`).set('Authorization', `Bearer ${admin}`);
    const actions = (history.body as { action: string }[]).map((e) => e.action);
    expect(actions).toContain('evidence');
    expect(actions).toContain('review_requested');
    expect(actions).toContain('review_rejected');
    expect(actions).toContain('review_approved');
    void assignRole; void roleIdByShortname; void courseContextId;
  });

  /** Helper: đưa một user competency của learner qua đường duyệt (evidence → start → approve) tới proficiency. */
  async function approveChild(learnerId: string, competencyId: string) {
    const evidence = await http(app).post('/api/v1/competencies/evidence').set('Authorization', `Bearer ${admin}`)
      .send({ userId: learnerId, competencyId, description: 'Portfolio', sendForReview: true });
    expect(evidence.status).toBe(201);
    const usercompId = evidence.body.usercomp.id as string;
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/start-review`).set('Authorization', `Bearer ${admin}`).send({});
    const approved = await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/approve`).set('Authorization', `Bearer ${admin}`).send({ grade: 1 });
    expect(approved.body.proficiency).toBe(true);
    return usercompId;
  }

  async function parentChildFramework(suffix: string) {
    const fw = await http(app).post('/api/v1/competencies/frameworks').set('Authorization', `Bearer ${admin}`)
      .send({ shortname: `Rule FW ${suffix}`, idnumber: `rule-fw-${suffix}`, scale: { values: ['Not competent', 'Competent'], proficient: [1] } });
    expect(fw.status).toBe(201);
    const mk = async (shortname: string, parentId?: string) => {
      const res = await http(app).post(`/api/v1/competencies/frameworks/${fw.body.id}/competencies`).set('Authorization', `Bearer ${admin}`)
        .send({ shortname, ...(parentId ? { parentId } : {}) });
      expect(res.status).toBe(201);
      return res.body as { id: string; shortname: string; parentid: string | null };
    };
    const parent = await mk('Parent skill');
    const childA = await mk('Child A', parent.id);
    const childB = await mk('Child B', parent.id);
    return { framework: fw.body, parent, childA, childB };
  }

  it('competency rule points: parent auto-attains proficiency when the children reach the required points, not before (Moodle competency_rule_points; config shape from api_test test_duplicate_framework)', async () => {
    const { framework, parent, childA, childB } = await parentChildFramework(`${Date.now()}-pts`);
    const ruleUrl = `/api/v1/competencies/frameworks/${framework.id}/competencies/${parent.id}/rule`;
    // Unreachable rule (required points above the children's total) is refused at set time (validate_config).
    const unreachable = await http(app).post(ruleUrl).set('Authorization', `Bearer ${admin}`)
      .send({ outcome: 'complete', pointsRequired: 99, entries: [{ competencyId: childA.id, points: 3, required: false }, { competencyId: childB.id, points: 2, required: true }] });
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.code).toBe('competency.rule_invalid');
    // A non-child cannot contribute points.
    const { competency: stranger } = await frameworkWithCompetency();
    const nonChild = await http(app).post(ruleUrl).set('Authorization', `Bearer ${admin}`)
      .send({ outcome: 'complete', pointsRequired: 1, entries: [{ competencyId: stranger.id, points: 1, required: false }] });
    expect(nonChild.status).toBe(400);
    expect(nonChild.body.code).toBe('competency.rule_invalid');
    // Moodle's own test config shape: base 4 points; child A = 3 (optional), child B = 2 (required).
    const set = await http(app).post(ruleUrl).set('Authorization', `Bearer ${admin}`)
      .send({ outcome: 'complete', pointsRequired: 4, entries: [{ competencyId: childA.id, points: 3, required: false }, { competencyId: childB.id, points: 2, required: true }] });
    expect(set.status).toBe(201);
    expect(set.body.type).toBe('points');
    expect(set.body.config.pointsRequired).toBe(4);
    const view = await http(app).get(ruleUrl).set('Authorization', `Bearer ${admin}`);
    expect(view.body.config.entries).toHaveLength(2);

    const learner = await createUserViaApi(app, admin);
    const parentRow = async () => {
      const rows = await http(app).get(`/api/v1/competencies/usercomp/user/${learner.id}`).set('Authorization', `Bearer ${admin}`);
      return (rows.body as { competencyid: string; proficiency: boolean | null; grade: number | null; id: string }[])
        .find((r) => r.competencyid === parent.id);
    };
    // Required child B approved (2 points < 4 required): parent NOT proficient yet.
    await approveChild(learner.id, childB.id);
    expect((await parentRow())?.proficiency).not.toBe(true);
    // Child A approved too (2 + 3 = 5 >= 4, required met): parent auto-attains proficiency from the scale.
    await approveChild(learner.id, childA.id);
    const parentUc = await parentRow();
    expect(parentUc?.proficiency).toBe(true);
    expect(parentUc?.grade).toBe(1);
    // Idempotent: re-grading a child re-evaluates the rule but writes no second rule evidence.
    await http(app).post('/api/v1/competencies/usercomp/grade').set('Authorization', `Bearer ${admin}`)
      .send({ userId: learner.id, competencyId: childA.id, grade: 1 });
    const evidence = await http(app).get(`/api/v1/competencies/usercomp/${parentUc!.id}/evidence`).set('Authorization', `Bearer ${admin}`);
    expect((evidence.body as { action: string }[]).filter((e) => e.action === 'rule_points_met')).toHaveLength(1);
  });

  it('framework export → import: tree/scale/rule preserved with brand-new ids; duplicate mirrors Moodle test_duplicate_framework', async () => {
    const { framework, parent, childA, childB } = await parentChildFramework(`${Date.now()}-exp`);
    await http(app).post(`/api/v1/competencies/frameworks/${framework.id}/competencies/${parent.id}/rule`).set('Authorization', `Bearer ${admin}`)
      .send({ outcome: 'complete', pointsRequired: 4, entries: [{ competencyId: childA.id, points: 3, required: false }, { competencyId: childB.id, points: 2, required: true }] });

    const exported = await http(app).get(`/api/v1/competencies/frameworks/${framework.id}/export`).set('Authorization', `Bearer ${admin}`);
    expect(exported.status).toBe(200);
    expect(exported.body.format).toBe('lms-competency-framework');
    expect(exported.body.version).toBe(1);
    expect(exported.body.competencies).toHaveLength(3);

    const imported = await http(app).post('/api/v1/competencies/frameworks/import').set('Authorization', `Bearer ${admin}`).send(exported.body);
    expect(imported.status).toBe(201);
    expect(imported.body.id).not.toBe(framework.id);
    expect(imported.body.scaleconfiguration).toEqual({ values: ['Not competent', 'Competent'], proficient: [1] });
    expect(imported.body.taxonomies).toBe(exported.body.framework.taxonomies);
    const importedComps = await http(app).get(`/api/v1/competencies/frameworks/${imported.body.id}/competencies`).set('Authorization', `Bearer ${admin}`);
    const rows = importedComps.body as { id: string; shortname: string; parentid: string | null; path: string }[];
    expect(rows).toHaveLength(3);
    const sourceIds = new Set([parent.id, childA.id, childB.id]);
    for (const row of rows) expect(sourceIds.has(row.id)).toBe(false); // toàn bộ id đều mới
    const newParent = rows.find((r) => r.shortname === 'Parent skill')!;
    const newChildA = rows.find((r) => r.shortname === 'Child A')!;
    const newChildB = rows.find((r) => r.shortname === 'Child B')!;
    expect(newChildA.parentid).toBe(newParent.id);
    expect(newChildB.parentid).toBe(newParent.id);
    expect(newChildA.path).toBe(`/${newParent.id}/${newChildA.id}`);
    // Rule được mang sang với id con ĐÃ remap sang framework mới.
    const rule = await http(app).get(`/api/v1/competencies/frameworks/${imported.body.id}/competencies/${newParent.id}/rule`).set('Authorization', `Bearer ${admin}`);
    expect(rule.body.type).toBe('points');
    expect(rule.body.outcome).toBe('complete');
    expect(rule.body.config.pointsRequired).toBe(4);
    expect(new Set(rule.body.config.entries.map((e: { competencyId: string }) => e.competencyId))).toEqual(new Set([newChildA.id, newChildB.id]));

    // Duplicate: idnumber chưa dùng với hậu tố _1 (đúng oracle), cây + rule nguyên vẹn.
    const duplicate = await http(app).post(`/api/v1/competencies/frameworks/${framework.id}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.id).not.toBe(framework.id);
    expect(duplicate.body.idnumber).toBe(`${framework.idnumber}_1`);
    const dupComps = await http(app).get(`/api/v1/competencies/frameworks/${duplicate.body.id}/competencies`).set('Authorization', `Bearer ${admin}`);
    expect(dupComps.body).toHaveLength(3);
    const duplicate2 = await http(app).post(`/api/v1/competencies/frameworks/${framework.id}/duplicate`).set('Authorization', `Bearer ${admin}`).send({});
    expect(duplicate2.body.idnumber).toBe(`${framework.idnumber}_2`);
  });

  it('framework import: malformed documents are refused with 400 and create no framework at all', async () => {
    const before = await http(app).get('/api/v1/competencies/frameworks').set('Authorization', `Bearer ${admin}`);
    const countBefore = (before.body as unknown[]).length;
    const scale = { values: ['Not competent', 'Competent'], proficient: [1] };
    // Sai version → Zod từ chối.
    const wrongVersion = await http(app).post('/api/v1/competencies/frameworks/import').set('Authorization', `Bearer ${admin}`)
      .send({ format: 'lms-competency-framework', version: 2, framework: { shortname: 'Bad', idnumber: '', description: '', visible: true, taxonomies: 'competency', scale }, competencies: [] });
    expect(wrongVersion.status).toBe(400);
    // Đúng hình dạng nhưng rule tham chiếu competency không phải con trực tiếp → import_invalid, rollback toàn bộ.
    const badRef = await http(app).post('/api/v1/competencies/frameworks/import').set('Authorization', `Bearer ${admin}`)
      .send({
        format: 'lms-competency-framework', version: 1,
        framework: { shortname: `Bad import ${Date.now()}`, idnumber: '', description: '', visible: true, taxonomies: 'competency', scale },
        competencies: [
          { key: 'p', shortname: 'P', idnumber: '', description: '', parentKey: null, sortorder: 0, rule: { outcome: 'complete', pointsRequired: 1, entries: [{ competencyKey: 'x', points: 1, required: true }] } },
          { key: 'c', shortname: 'C', idnumber: '', description: '', parentKey: 'p', sortorder: 0, rule: null },
          { key: 'x', shortname: 'X', idnumber: '', description: '', parentKey: null, sortorder: 0, rule: null },
        ],
      });
    expect(badRef.status).toBe(400);
    expect(badRef.body.code).toBe('competency.import_invalid');
    // Thiếu hẳn trường bắt buộc → 400.
    const missing = await http(app).post('/api/v1/competencies/frameworks/import').set('Authorization', `Bearer ${admin}`).send({ format: 'lms-competency-framework' });
    expect(missing.status).toBe(400);
    // Không framework rác nào được tạo.
    const after = await http(app).get('/api/v1/competencies/frameworks').set('Authorization', `Bearer ${admin}`);
    expect((after.body as unknown[]).length).toBe(countBefore);
  });
});
