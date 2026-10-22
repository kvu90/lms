import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { courseTotalOf, createGradeCategory, createGradeItem, getGradebook, setGrade } from './assessment-helpers';

/**
 * Assessment flows.
 * Oracles: MoodleDocs Grade aggregation (verbatim arithmetic, see the
 * GradeCalculator spec) + Moodle 5.3 PHPUnit:
 *  - grade aggregation/category behaviour (grade/tests in the 5.3 tree —
 *    the two probed paths grade/tests/grade_category_test.php and
 *    grade/tests/category_test.php return 404 in MOODLE_503_STABLE's
 *    public/ tree; the arithmetic oracle used is the MoodleDocs page the
 *    report §2.1 cites, cross-checked against grade_category semantics);
 *  - public/question/engine/tests/questionusagebyactivity_test.php
 *    (usage groups attempts, deferred feedback, steps) — VERIFIED in 5.3;
 *  - public/lib/tests/completionlib_test.php grade cases
 *    (test_internal_get_state_with_grade_criteria, test_inform_grade_changed)
 *    — VERIFIED in 5.3: completion follows the grade.
 */
describe('Grades & questions', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/lms_test' });
    await pg.connect();
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  async function setupCourse() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    return { cat, course, sectionId, instance, student, studentToken };
  }
  async function outboxTypes(payloadKey: string, payloadValue: string | number): Promise<string[]> {
    const res = await pg.query('select type from outbox_events where payload->>$1 = $2 order by id', [payloadKey, String(payloadValue)]);
    return (res.rows as { type: string }[]).map((r) => r.type);
  }

  it('GOLDEN gradebook via API: Natural aggregation (70/100 + 20/80 + 10/10) gives a course total of 100 out of 190', async () => {
    const { course, student } = await setupCourse();
    const a = await createGradeItem(app, admin, course.id, { itemname: 'A1', grademax: 100 });
    const b = await createGradeItem(app, admin, course.id, { itemname: 'A2', grademax: 80 });
    const c = await createGradeItem(app, admin, course.id, { itemname: 'A3', grademax: 10 });
    await setGrade(app, admin, a.id, student.id, 70);
    await setGrade(app, admin, b.id, student.id, 20);
    await setGrade(app, admin, c.id, student.id, 10);
    const book = await getGradebook(app, admin, course.id, student.id);
    expect(book.courseTotal?.grade?.finalgrade).toBeCloseTo(100, 6);
    expect(book.categories[0]?.total?.item.grademax).toBeCloseTo(190, 6);
  });

  it('GOLDEN extra credit via API: extra item lifts the total but its max stays out of the denominator, capped at the category max', async () => {
    const { course, student } = await setupCourse();
    const extra = await createGradeItem(app, admin, course.id, { itemname: 'Bonus', grademax: 100, extracredit: true });
    const main = await createGradeItem(app, admin, course.id, { itemname: 'Main', grademax: 75 });
    await setGrade(app, admin, extra.id, student.id, 20);
    await setGrade(app, admin, main.id, student.id, 70);
    expect(await courseTotalOf(app, admin, course.id, student.id)).toBeCloseTo(75, 6);
  });

  it('nested categories aggregate recursively into the course total', async () => {
    const { course, student } = await setupCourse();
    const sub = await createGradeCategory(app, admin, course.id, { fullname: 'Quizzes', aggregation: 'mean' });
    const q1 = await createGradeItem(app, admin, course.id, { itemname: 'Q1', categoryId: sub.id, grademax: 100 });
    const q2 = await createGradeItem(app, admin, course.id, { itemname: 'Q2', categoryId: sub.id, grademax: 100 });
    const essay = await createGradeItem(app, admin, course.id, { itemname: 'Essay', grademax: 100 });
    await setGrade(app, admin, q1.id, student.id, 80);
    await setGrade(app, admin, q2.id, student.id, 100);
    await setGrade(app, admin, essay.id, student.id, 60);
    // Subcategory (mean) = 90/100; course (natural) = (90 + 60)/(100 + 100) ⇒ 150 out of 200.
    expect(await courseTotalOf(app, admin, course.id, student.id)).toBeCloseTo(150, 6);
    const book = await getGradebook(app, admin, course.id, student.id);
    const subView = (book.categories[0]?.children as { total: { grade: { finalgrade: number | null } | null } | null }[])[0];
    expect(subView?.total?.grade?.finalgrade).toBeCloseTo(90, 6);
  });

  it('changing a category aggregation emits the bulk-regrade chain: queue event in the outbox and recalculated totals', async () => {
    const { course, student } = await setupCourse();
    const sub = await createGradeCategory(app, admin, course.id, { fullname: 'AggCat', aggregation: 'mean' });
    const i1 = await createGradeItem(app, admin, course.id, { itemname: 'I1', categoryId: sub.id, grademax: 100 });
    const i2 = await createGradeItem(app, admin, course.id, { itemname: 'I2', categoryId: sub.id, grademax: 10 });
    await setGrade(app, admin, i1.id, student.id, 100);
    await setGrade(app, admin, i2.id, student.id, 0);
    // mean ⇒ subcategory 50 → course total 50.
    expect(await courseTotalOf(app, admin, course.id, student.id)).toBeCloseTo(50, 6);
    const patch = await http(app).patch(`/api/v1/courses/grades/categories/${sub.id}`).set('Authorization', `Bearer ${admin}`).send({ aggregation: 'highest' });
    expect(patch.status).toBe(200);
    // highest ⇒ subcategory 100 → course total 100.
    expect(await courseTotalOf(app, admin, course.id, student.id)).toBeCloseTo(100, 6);
    const types = await outboxTypes('categoryId', sub.id);
    expect(types).toContain('grade_category_aggregation_changed');
    expect(types).toContain('grade_category_created');
    const gradeEvents = await pg.query("select count(*)::int as n from outbox_events where type='grade_updated' and payload->>'courseId' = $1", [String(course.id)]);
    expect((gradeEvents.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it('override survives regrade, a locked grade refuses entry, and history records the changes', async () => {
    const { course, student, instance } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Exam', grademax: 100 });
    const grade = await setGrade(app, admin, item.id, student.id, 40);
    // Teacher overrides the final grade to 88.
    const patched = await http(app).patch(`/api/v1/courses/grades/grades/${grade.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ overridden: true, finalgrade: 88 });
    expect(patched.status).toBe(200);
    expect(patched.body.finalgrade).toBe(88);
    // Entering a new raw grade is refused while overridden…
    const refused = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userid: student.id, rawgrade: 10 });
    expect(refused.status).toBe(403);
    // …and a manual regrade does not recompute it away (course total follows the override path:
    // the leaf grade itself stays 88 because regrade never rewrites overridden grades).
    await http(app).post(`/api/v1/courses/${course.id}/grades/regrade`).set('Authorization', `Bearer ${admin}`);
    const book = await getGradebook(app, admin, course.id, student.id);
    const leaf = book.categories[0]?.items.find((i) => i.item.id === item.id);
    expect(leaf?.grade?.finalgrade).toBe(88);
    // Lock it: further updates to the grade still work for staff, but grade entry stays blocked by override;
    // locking the ITEM blocks entry for everyone.
    await http(app).patch(`/api/v1/courses/grades/items/${item.id}`).set('Authorization', `Bearer ${admin}`).send({ locked: true });
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, other.id);
    const lockedAttempt = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userid: other.id, rawgrade: 5 });
    expect(lockedAttempt.status).toBe(403);
    const history = await http(app).get(`/api/v1/courses/grades/items/${item.id}/users/${student.id}/history`).set('Authorization', `Bearer ${admin}`);
    expect(history.status).toBe(200);
    expect((history.body as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('freeze: a grade produced with a multiplicator is frozen — changing the multiplicator later does not rewrite it until unfrozen', async () => {
    const { course, student } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Penalised', grademax: 100, multiplicator: 0.5 });
    const grade = await setGrade(app, admin, item.id, student.id, 80);
    expect(grade.finalgrade).toBeCloseTo(40, 6); // 80 * 0.5 penalty applied once
    expect(grade.frozen).toBe(true);
    // Teacher removes the penalty afterwards: the frozen grade must NOT change.
    await http(app).patch(`/api/v1/courses/grades/items/${item.id}`).set('Authorization', `Bearer ${admin}`).send({ multiplicator: 1 });
    let book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === item.id)?.grade?.finalgrade).toBeCloseTo(40, 6);
    // Unfreezing + re-entering applies the current formula.
    const g2 = await http(app).get(`/api/v1/courses/${course.id}/gradebook`).query({ userid: student.id }).set('Authorization', `Bearer ${admin}`);
    const gradeId = (g2.body.categories[0].items as { item: { id: string }; grade: { id: string } | null }[]).find((i) => i.item.id === item.id)?.grade?.id;
    await http(app).patch(`/api/v1/courses/grades/grades/${gradeId}`).set('Authorization', `Bearer ${admin}`).send({ frozen: false });
    // Re-entering the same raw grade now recomputes without the penalty — but the row is no longer
    // overridden/frozen; entry overwrites finalgrade through the normal path.
    const reentered = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userid: student.id, rawgrade: 80 });
    expect(reentered.status).toBeLessThan(300);
    book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === item.id)?.grade?.finalgrade).toBeCloseTo(80, 6);
  });

  it('permissions and privacy: students cannot enter grades, see only their own book, and hidden items are filtered', async () => {
    const { course, student, studentToken } = await setupCourse();
    const visible = await createGradeItem(app, admin, course.id, { itemname: 'Visible', grademax: 100 });
    const hidden = await createGradeItem(app, admin, course.id, { itemname: 'Secret', grademax: 100, hidden: true });
    await setGrade(app, admin, visible.id, student.id, 70);
    await setGrade(app, admin, hidden.id, student.id, 30);
    const entry = await http(app).post(`/api/v1/courses/grades/items/${visible.id}/grades`).set('Authorization', `Bearer ${studentToken}`)
      .send({ userid: student.id, rawgrade: 100 });
    expect(entry.status).toBe(403);
    const mine = await getGradebook(app, studentToken, course.id);
    expect(mine.userId).toBe(student.id);
    expect(mine.categories[0]?.items.map((i) => i.item.itemname)).toContain('Visible');
    expect(mine.categories[0]?.items.map((i) => i.item.itemname)).not.toContain('Secret');
    const others = await http(app).get(`/api/v1/courses/${course.id}/gradebook`).query({ userid: 999999 }).set('Authorization', `Bearer ${studentToken}`);
    expect(others.status).toBe(403);
    const teacherView = await getGradebook(app, admin, course.id, student.id);
    expect(teacherView.categories[0]?.items.map((i) => i.item.itemname)).toContain('Secret');
  });

  it('grade letters are applied at display time from the course-context boundaries', async () => {
    const { course, student } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Final', grademax: 100 });
    await setGrade(app, admin, item.id, student.id, 85);
    const put = await http(app).put(`/api/v1/courses/${course.id}/grades/letters`).set('Authorization', `Bearer ${admin}`)
      .send({ letters: [{ letter: 'A', lowerboundary: 90 }, { letter: 'B', lowerboundary: 80 }, { letter: 'F', lowerboundary: 0 }] });
    expect(put.status).toBe(200);
    const book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items[0]?.grade?.letter).toBe('B');
    expect(book.courseTotal?.grade?.letter).toBe('B'); // 85/100
    const report = await http(app).get(`/api/v1/courses/${course.id}/grades/report`).set('Authorization', `Bearer ${admin}`);
    expect(report.body.rows.find((r: { userId: string }) => r.userId === student.id)?.letter).toBe('B');
  });

  it('question bank versioning: editing a question creates a new version and bumps the entry pointer; old versions stay intact', async () => {
    const systemCtxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (systemCtxRes.body as { id: string; contextlevel: number }[]).find((c) => c.contextlevel === 10)!;
    const catRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Bank cat', contextid: systemCtx.id });
    expect(catRes.status).toBeLessThan(300);
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, qtype: 'truefalse', name: 'Sky is blue', questiontext: 'The sky is blue.', answer: { correct: true } });
    expect(qRes.status).toBeLessThan(300);
    const qid = qRes.body.question.id as string;
    expect(qRes.body.entry.latestversion).toBe(1);
    const edit = await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`)
      .send({ questiontext: 'The sky is green.', answer: { correct: false } });
    expect(edit.status).toBe(200);
    expect(edit.body.entry.latestversion).toBe(2);
    expect(edit.body.latestVersion.version).toBe(2);
    const versions = await http(app).get(`/api/v1/questions/${qid}/versions`).set('Authorization', `Bearer ${admin}`);
    expect(versions.body).toHaveLength(2);
    expect(versions.body[0].questiontext).toBe('The sky is blue.');
    expect(versions.body[0].answerdata.correct).toBe(true);
    expect(versions.body[1].answerdata.correct).toBe(false);
  });

  it('INVARIANT: an attempt started on version 1 is graded by version 1 even after the question is edited to version 2', async () => {
    const systemCtxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (systemCtxRes.body as { id: string; contextlevel: number }[]).find((c) => c.contextlevel === 10)!;
    const catRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Invariant cat', contextid: systemCtx.id });
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, qtype: 'truefalse', name: 'Water wet', questiontext: 'Water is wet.', answer: { correct: true } });
    const qid = qRes.body.question.id as string;
    const student = await createUserViaApi(app, admin);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    // Usage created and STARTED while v1 is latest ⇒ pins v1.
    const usageRes = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${admin}`)
      .send({ component: 'mod_quiz', instanceid: '01900000-0000-7000-8000-000000000042', slots: [{ questionId: qid }] });
    const usageId = usageRes.body.usage.id as string;
    const attemptId = usageRes.body.attempts[0].id as string;
    expect(usageRes.body.attempts[0].state).toBe('notstarted');
    const v1Id = qRes.body.latestVersion.id as string;
    await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`).set('Authorization', `Bearer ${studentToken}`);
    // NOW the teacher edits the question: correct answer flips in v2.
    await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`).send({ answer: { correct: false } });
    // Student answers 'true' and finishes: graded by v1 ⇒ right.
    const submit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`).set('Authorization', `Bearer ${studentToken}`).send({ response: 'true' });
    expect(submit.body.state).toBe('complete');
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished.body.state).toBe('finished');
    const attempt = finished.body.attempts[0];
    expect(attempt.questionversionid).toBe(v1Id);
    expect(attempt.state).toBe('gradedright');
    expect(attempt.fraction).toBe(1);
    // Steps record every transition: todo → complete → gradedright.
    expect(attempt.steps.map((s: { state: string }) => s.state)).toEqual(['todo', 'complete', 'gradedright']);
    expect(attempt.steps[1].data.answer).toBe('true');
    // A NEW usage pins v2: the same answer is now wrong.
    const usage2 = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${admin}`)
      .send({ component: 'mod_quiz', instanceid: '01900000-0000-7000-8000-000000000042', slots: [{ questionId: qid }] });
    const usage2Id = usage2.body.usage.id as string;
    const attempt2Id = usage2.body.attempts[0].id as string;
    await http(app).post(`/api/v1/question-usages/${usage2Id}/attempts/${attempt2Id}/start`).set('Authorization', `Bearer ${studentToken}`);
    await http(app).post(`/api/v1/question-usages/${usage2Id}/attempts/${attempt2Id}/submit`).set('Authorization', `Bearer ${studentToken}`).send({ response: 'true' });
    const finished2 = await http(app).post(`/api/v1/question-usages/${usage2Id}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished2.body.attempts[0].state).toBe('gradedwrong');
  });

  it('CHAIN: entering a grade drives completionusegrade (pass/fail) and opens a grade-gated activity', async () => {
    const { course, sectionId, student, studentToken } = await setupCourse();
    const cmQuiz = await createCm(app, admin, course.id, sectionId, {
      name: 'Graded quiz', completion: 2, completionusegrade: true,
    });
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Quiz grade', itemtype: 'mod', cmId: cmQuiz.id, grademax: 100, gradepass: 50 });
    const cmNext = await createCm(app, admin, course.id, sectionId, {
      name: 'Next lesson',
      availability: { op: '&', show: true, showc: [true], c: [{ type: 'grade', id: item.id, min: 50 }] },
    });
    // Before any grade: gated activity is 403 and completion is incomplete.
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmNext.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    let progress = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cmQuiz.id)?.state).toBe(0);
    // Failing grade (40 < pass 50): completion becomes complete-fail (3), gate stays shut (40% < 50%).
    await setGrade(app, admin, item.id, student.id, 40);
    progress = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cmQuiz.id)?.state).toBe(3);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmNext.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    // Passing grade (80): completion becomes complete-pass (2) and the gate opens.
    await setGrade(app, admin, item.id, student.id, 80);
    progress = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cmQuiz.id)?.state).toBe(2);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmNext.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
    // The durable chain exists in the outbox: grade_updated + cm_completion_changed.
    const types = await outboxTypes('courseId', course.id);
    expect(types).toContain('grade_updated');
    const cmEvents = await pg.query("select count(*)::int as n from outbox_events where type='cm_completion_changed' and payload->>'cmId' = $1", [String(cmQuiz.id)]);
    expect((cmEvents.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
  });

  it('course completion grade criterion: the course completes only when the course total reaches gradepass', async () => {
    const { course, student, studentToken } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemname: 'Only assignment', grademax: 100 });
    // Set the course total's gradepass by patching the course item.
    const items = await http(app).get(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`);
    const courseItem = (items.body as { id: string; itemtype: string }[]).find((i) => i.itemtype === 'course')!;
    await http(app).patch(`/api/v1/courses/grades/items/${courseItem.id}`).set('Authorization', `Bearer ${admin}`).send({ gradepass: 50 });
    void item;
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriatype: 'grade' }] });
    await setGrade(app, admin, item.id, student.id, 30);
    let mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).not.toBe('complete');
    await setGrade(app, admin, item.id, student.id, 90);
    // Grade changes reaggregate activity completion; course completion re-evaluates on read.
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
  });
});
