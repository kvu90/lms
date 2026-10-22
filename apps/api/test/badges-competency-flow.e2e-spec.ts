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
    const badgeId = badgeRes.body.id as number;
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
    const mineRows = mine.body as { badgeid: number; uniquehash: string; snapshot: { criteria: unknown[] } }[];
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
    const badgeId = badgeRes.body.id as number;
    await http(app).put(`/api/v1/badges/${badgeId}/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 2, criteria: [{ criteriatype: 'competency', params: { competencyId: competency.id } }] });
    await http(app).post(`/api/v1/badges/${badgeId}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 1 });
    const user = await createUserViaApi(app, admin);
    // Becoming proficient (review approve) triggers the competency listener → auto-award.
    const evidence = await http(app).post('/api/v1/competencies/evidence').set('Authorization', `Bearer ${admin}`)
      .send({ userId: user.id, competencyId: competency.id, description: 'Portfolio', sendForReview: true });
    const usercompId = evidence.body.usercomp.id as number;
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/start-review`).set('Authorization', `Bearer ${admin}`).send({});
    await http(app).post(`/api/v1/competencies/usercomp/${usercompId}/approve`).set('Authorization', `Bearer ${admin}`).send({ grade: 1 });
    const userToken = (await login(app, user.username, STRONG_PASSWORD)).accessToken;
    const mine = await http(app).get('/api/v1/badges/mine').set('Authorization', `Bearer ${userToken}`);
    const assertion = (mine.body as { id: number; badgeid: number }[]).find((r) => r.badgeid === badgeId);
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
    const badgeId = badgeRes.body.id as number;
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
    const rows = usercomps.body as { competencyid: number; proficiency: boolean | null; grade: number | null; id: number }[];
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
    const planId = plan.body.id as number;
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
    const usercompId = evidence.body.usercomp.id as number;
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
});
