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
    pg = new Client({ connectionString: process.env.DATABASE_URL });
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
    const a = await createGradeItem(app, admin, course.id, { itemName: 'A1', gradeMax: 100 });
    const b = await createGradeItem(app, admin, course.id, { itemName: 'A2', gradeMax: 80 });
    const c = await createGradeItem(app, admin, course.id, { itemName: 'A3', gradeMax: 10 });
    await setGrade(app, admin, a.id, student.id, 70);
    await setGrade(app, admin, b.id, student.id, 20);
    await setGrade(app, admin, c.id, student.id, 10);
    const book = await getGradebook(app, admin, course.id, student.id);
    expect(book.courseTotal?.grade?.finalGrade).toBeCloseTo(100, 6);
    expect(book.categories[0]?.total?.item.gradeMax).toBeCloseTo(190, 6);
  });

  it('GOLDEN extra credit via API: extra item lifts the total but its max stays out of the denominator, capped at the category max', async () => {
    const { course, student } = await setupCourse();
    const extra = await createGradeItem(app, admin, course.id, { itemName: 'Bonus', gradeMax: 100, extraCredit: true });
    const main = await createGradeItem(app, admin, course.id, { itemName: 'Main', gradeMax: 75 });
    await setGrade(app, admin, extra.id, student.id, 20);
    await setGrade(app, admin, main.id, student.id, 70);
    expect(await courseTotalOf(app, admin, course.id, student.id)).toBeCloseTo(75, 6);
  });

  it('nested categories aggregate recursively into the course total', async () => {
    const { course, student } = await setupCourse();
    const sub = await createGradeCategory(app, admin, course.id, { fullName: 'Quizzes', aggregation: 'mean' });
    const q1 = await createGradeItem(app, admin, course.id, { itemName: 'Q1', categoryId: sub.id, gradeMax: 100 });
    const q2 = await createGradeItem(app, admin, course.id, { itemName: 'Q2', categoryId: sub.id, gradeMax: 100 });
    const essay = await createGradeItem(app, admin, course.id, { itemName: 'Essay', gradeMax: 100 });
    await setGrade(app, admin, q1.id, student.id, 80);
    await setGrade(app, admin, q2.id, student.id, 100);
    await setGrade(app, admin, essay.id, student.id, 60);
    // Subcategory (mean) = 90/100; course (natural) = (90 + 60)/(100 + 100) ⇒ 150 out of 200.
    expect(await courseTotalOf(app, admin, course.id, student.id)).toBeCloseTo(150, 6);
    const book = await getGradebook(app, admin, course.id, student.id);
    const subView = (book.categories[0]?.children as { total: { grade: { finalGrade: number | null } | null } | null }[])[0];
    expect(subView?.total?.grade?.finalGrade).toBeCloseTo(90, 6);
  });

  it('changing a category aggregation emits the bulk-regrade chain: queue event in the outbox and recalculated totals', async () => {
    const { course, student } = await setupCourse();
    const sub = await createGradeCategory(app, admin, course.id, { fullName: 'AggCat', aggregation: 'mean' });
    const i1 = await createGradeItem(app, admin, course.id, { itemName: 'I1', categoryId: sub.id, gradeMax: 100 });
    const i2 = await createGradeItem(app, admin, course.id, { itemName: 'I2', categoryId: sub.id, gradeMax: 10 });
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
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Exam', gradeMax: 100 });
    const grade = await setGrade(app, admin, item.id, student.id, 40);
    // Teacher overrides the final grade to 88.
    const patched = await http(app).patch(`/api/v1/courses/grades/grades/${grade.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ overridden: true, finalGrade: 88 });
    expect(patched.status).toBe(200);
    expect(patched.body.finalGrade).toBe(88);
    // Entering a new raw grade is refused while overridden…
    const refused = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 10 });
    expect(refused.status).toBe(403);
    // …and a manual regrade does not recompute it away (course total follows the override path:
    // the leaf grade itself stays 88 because regrade never rewrites overridden grades).
    await http(app).post(`/api/v1/courses/${course.id}/grades/regrade`).set('Authorization', `Bearer ${admin}`);
    const book = await getGradebook(app, admin, course.id, student.id);
    const leaf = book.categories[0]?.items.find((i) => i.item.id === item.id);
    expect(leaf?.grade?.finalGrade).toBe(88);
    // Lock it: further updates to the grade still work for staff, but grade entry stays blocked by override;
    // locking the ITEM blocks entry for everyone.
    await http(app).patch(`/api/v1/courses/grades/items/${item.id}`).set('Authorization', `Bearer ${admin}`).send({ locked: true });
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, other.id);
    const lockedAttempt = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: other.id, rawGrade: 5 });
    expect(lockedAttempt.status).toBe(403);
    const history = await http(app).get(`/api/v1/courses/grades/items/${item.id}/users/${student.id}/history`).set('Authorization', `Bearer ${admin}`);
    expect(history.status).toBe(200);
    expect((history.body as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('freeze: a grade produced with a multiplicator is frozen — changing the multiplicator later does not rewrite it until unfrozen', async () => {
    const { course, student } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Penalised', gradeMax: 100, multiplicator: 0.5 });
    const grade = await setGrade(app, admin, item.id, student.id, 80);
    expect(grade.finalGrade).toBeCloseTo(40, 6); // 80 * 0.5 penalty applied once
    expect(grade.frozen).toBe(true);
    // Teacher removes the penalty afterwards: the frozen grade must NOT change.
    await http(app).patch(`/api/v1/courses/grades/items/${item.id}`).set('Authorization', `Bearer ${admin}`).send({ multiplicator: 1 });
    let book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === item.id)?.grade?.finalGrade).toBeCloseTo(40, 6);
    // Unfreezing + re-entering applies the current formula.
    const g2 = await http(app).get(`/api/v1/courses/${course.id}/gradebook`).query({ userId: student.id }).set('Authorization', `Bearer ${admin}`);
    const gradeId = (g2.body.categories[0].items as { item: { id: string }; grade: { id: string } | null }[]).find((i) => i.item.id === item.id)?.grade?.id;
    await http(app).patch(`/api/v1/courses/grades/grades/${gradeId}`).set('Authorization', `Bearer ${admin}`).send({ frozen: false });
    // Re-entering the same raw grade now recomputes without the penalty — but the row is no longer
    // overridden/frozen; entry overwrites finalGrade through the normal path.
    const reentered = await http(app).post(`/api/v1/courses/grades/items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 80 });
    expect(reentered.status).toBeLessThan(300);
    book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === item.id)?.grade?.finalGrade).toBeCloseTo(80, 6);
  });

  it('permissions and privacy: students cannot enter grades, see only their own book, and hidden items are filtered', async () => {
    const { course, student, studentToken } = await setupCourse();
    const visible = await createGradeItem(app, admin, course.id, { itemName: 'Visible', gradeMax: 100 });
    const hidden = await createGradeItem(app, admin, course.id, { itemName: 'Secret', gradeMax: 100, hidden: true });
    await setGrade(app, admin, visible.id, student.id, 70);
    await setGrade(app, admin, hidden.id, student.id, 30);
    const entry = await http(app).post(`/api/v1/courses/grades/items/${visible.id}/grades`).set('Authorization', `Bearer ${studentToken}`)
      .send({ userId: student.id, rawGrade: 100 });
    expect(entry.status).toBe(403);
    const mine = await getGradebook(app, studentToken, course.id);
    expect(mine.userId).toBe(student.id);
    expect(mine.categories[0]?.items.map((i) => i.item.itemName)).toContain('Visible');
    expect(mine.categories[0]?.items.map((i) => i.item.itemName)).not.toContain('Secret');
    const others = await http(app).get(`/api/v1/courses/${course.id}/gradebook`).query({ userId: 999999 }).set('Authorization', `Bearer ${studentToken}`);
    expect(others.status).toBe(403);
    const teacherView = await getGradebook(app, admin, course.id, student.id);
    expect(teacherView.categories[0]?.items.map((i) => i.item.itemName)).toContain('Secret');
  });

  it('grade letters are applied at display time from the course-context boundaries', async () => {
    const { course, student } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Final', gradeMax: 100 });
    await setGrade(app, admin, item.id, student.id, 85);
    const put = await http(app).put(`/api/v1/courses/${course.id}/grades/letters`).set('Authorization', `Bearer ${admin}`)
      .send({ letters: [{ letter: 'A', lowerBoundary: 90 }, { letter: 'B', lowerBoundary: 80 }, { letter: 'F', lowerBoundary: 0 }] });
    expect(put.status).toBe(200);
    const book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items[0]?.grade?.letter).toBe('B');
    expect(book.courseTotal?.grade?.letter).toBe('B'); // 85/100
    const report = await http(app).get(`/api/v1/courses/${course.id}/grades/report`).set('Authorization', `Bearer ${admin}`);
    expect(report.body.rows.find((r: { userId: string }) => r.userId === student.id)?.letter).toBe('B');
  });

  it('question bank versioning: editing a question creates a new version and bumps the entry pointer; old versions stay intact', async () => {
    const systemCtxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (systemCtxRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const catRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Bank cat', contextId: systemCtx.id });
    expect(catRes.status).toBeLessThan(300);
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, qtype: 'truefalse', name: 'Sky is blue', questionText: 'The sky is blue.', answer: { correct: true } });
    expect(qRes.status).toBeLessThan(300);
    const qid = qRes.body.question.id as string;
    expect(qRes.body.entry.latestVersion).toBe(1);
    const edit = await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`)
      .send({ questionText: 'The sky is green.', answer: { correct: false } });
    expect(edit.status).toBe(200);
    expect(edit.body.entry.latestVersion).toBe(2);
    expect(edit.body.latestVersion.version).toBe(2);
    const versions = await http(app).get(`/api/v1/questions/${qid}/versions`).set('Authorization', `Bearer ${admin}`);
    expect(versions.body).toHaveLength(2);
    // questionText nay là tài liệu Tiptap (jsonb): text thuần nằm ở node text đầu tiên.
    const docText = (doc: { content: { content?: { text?: string }[] }[] }) => doc.content[0]?.content?.[0]?.text;
    expect(docText(versions.body[0].questionText)).toBe('The sky is blue.');
    expect(docText(versions.body[1].questionText)).toBe('The sky is green.');
    // Đáp án đã tách sang question_answers: v1 giữ nguyên (True fraction 1),
    // v2 mang đáp án đã sửa (False fraction 1) — kiểm chứng thẳng ở DB.
    const v1Answers = await pg.query(
      `select a.fraction from question_answers a join question_versions v on v.id = a.question_version_id
        where v.id = $1 and a.answer->'content'->0->'content'->0->>'text' = 'True'`,
      [versions.body[0].id]);
    expect((v1Answers.rows[0] as { fraction: number }).fraction).toBe(1);
    const view = await http(app).get(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`);
    const trueRowV2 = (view.body.answers as { id: string; answer: unknown; fraction: number }[])
      .find((a) => docText(a.answer as never) === 'True');
    const falseRowV2 = (view.body.answers as { id: string; answer: unknown; fraction: number }[])
      .find((a) => docText(a.answer as never) === 'False');
    expect(trueRowV2?.fraction).toBe(0);
    expect(falseRowV2?.fraction).toBe(1);
    expect(view.body.options.trueAnswer).toBe(trueRowV2?.id);
  });

  it('INVARIANT: an attempt started on version 1 is graded by version 1 even after the question is edited to version 2', async () => {
    const systemCtxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (systemCtxRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const catRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Invariant cat', contextId: systemCtx.id });
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, qtype: 'truefalse', name: 'Water wet', questionText: 'Water is wet.', answer: { correct: true } });
    const qid = qRes.body.question.id as string;
    const student = await createUserViaApi(app, admin);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    // Usage created and STARTED while v1 is latest ⇒ pins v1.
    // Issue #60: chỉ chủ sở hữu mới thao tác usage qua route thô — học
    // sinh tự tạo usage của mình (trước đây admin tạo rồi học sinh làm:
    // mẫu đó là tiện ích test, không phải luồng sản phẩm).
    const usageRes = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-000000000042', slots: [{ questionId: qid }] });
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
    expect(attempt.questionVersionId).toBe(v1Id);
    expect(attempt.state).toBe('gradedright');
    expect(attempt.fraction).toBe(1);
    // Steps record every transition: todo → complete → gradedright.
    expect(attempt.steps.map((s: { state: string }) => s.state)).toEqual(['todo', 'complete', 'gradedright']);
    expect(attempt.steps[1].data.answer).toBe('true');
    // A NEW usage pins v2: the same answer is now wrong.
    const usage2 = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${studentToken}`)
      .send({ component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-000000000042', slots: [{ questionId: qid }] });
    const usage2Id = usage2.body.usage.id as string;
    const attempt2Id = usage2.body.attempts[0].id as string;
    await http(app).post(`/api/v1/question-usages/${usage2Id}/attempts/${attempt2Id}/start`).set('Authorization', `Bearer ${studentToken}`);
    await http(app).post(`/api/v1/question-usages/${usage2Id}/attempts/${attempt2Id}/submit`).set('Authorization', `Bearer ${studentToken}`).send({ response: 'true' });
    const finished2 = await http(app).post(`/api/v1/question-usages/${usage2Id}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished2.body.attempts[0].state).toBe('gradedwrong');
  });

  it('CHAIN: entering a grade drives completionUseGrade (pass/fail) and opens a grade-gated activity', async () => {
    const { course, sectionId, student, studentToken } = await setupCourse();
    const cmQuiz = await createCm(app, admin, course.id, sectionId, {
      name: 'Graded quiz', completion: 2, completionUseGrade: true,
    });
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Quiz grade', itemType: 'mod', cmId: cmQuiz.id, gradeMax: 100, gradePass: 50 });
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

  it('course completion grade criterion: the course completes only when the course total reaches gradePass', async () => {
    const { course, student, studentToken } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Only assignment', gradeMax: 100 });
    // Set the course total's gradePass by patching the course item.
    const items = await http(app).get(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`);
    const courseItem = (items.body as { id: string; itemType: string }[]).find((i) => i.itemType === 'course')!;
    await http(app).patch(`/api/v1/courses/grades/items/${courseItem.id}`).set('Authorization', `Bearer ${admin}`).send({ gradePass: 50 });
    void item;
    await http(app).put(`/api/v1/courses/${course.id}/completion/criteria`).set('Authorization', `Bearer ${admin}`)
      .send({ method: 1, criteria: [{ criteriaType: 'grade' }] });
    await setGrade(app, admin, item.id, student.id, 30);
    let mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).not.toBe('complete');
    await setGrade(app, admin, item.id, student.id, 90);
    // Grade changes reAggregate activity completion; course completion re-evaluates on read.
    mine = await http(app).get(`/api/v1/courses/${course.id}/completion/me`).set('Authorization', `Bearer ${studentToken}`);
    expect(mine.body.course.status).toBe('complete');
  });

  it('grade outcomes: tạo outcome (course + site), gắn item, cho điểm theo scale và outcome không tham gia tổng hợp số', async () => {
    const { course, student, studentToken } = await setupCourse();
    const scaleRes = await http(app).post(`/api/v1/courses/${course.id}/grades/scales`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Outcome scale', scale: 'Not yet,Partially,Fully' });
    expect(scaleRes.status).toBe(201);
    const scaleId = scaleRes.body.id as string;
    // Học viên không có grade:manage ⇒ không tạo được outcome.
    const denied = await http(app).post(`/api/v1/courses/${course.id}/grades/outcomes`).set('Authorization', `Bearer ${studentToken}`)
      .send({ name: 'Nope', scaleId });
    expect(denied.status).toBe(403);
    const outcomeRes = await http(app).post(`/api/v1/courses/${course.id}/grades/outcomes`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Teamwork', scaleId, description: 'Works in a team' });
    expect(outcomeRes.status).toBe(201);
    expect(outcomeRes.body.courseId).toBe(course.id);
    expect(outcomeRes.body.scaleId).toBe(scaleId);
    const outcomeId = outcomeRes.body.id as string;
    const listed = await http(app).get(`/api/v1/courses/${course.id}/grades/outcomes`).set('Authorization', `Bearer ${admin}`);
    expect((listed.body as { id: string }[]).some((o) => o.id === outcomeId)).toBe(true);
    // Outcome mức site: scale site + outcome site, và outcome site cũng liệt kê được trong khoá học.
    const siteScaleRes = await http(app).post('/api/v1/grades/scales').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Site outcome scale', scale: 'No,Yes' });
    expect(siteScaleRes.status).toBe(201);
    const siteOutcomeRes = await http(app).post('/api/v1/grades/outcomes').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Site citizenship', scaleId: siteScaleRes.body.id });
    expect(siteOutcomeRes.status).toBe(201);
    expect(siteOutcomeRes.body.courseId).toBeNull();
    const listed2 = await http(app).get(`/api/v1/courses/${course.id}/grades/outcomes`).set('Authorization', `Bearer ${admin}`);
    expect((listed2.body as { id: string }[]).some((o) => o.id === siteOutcomeRes.body.id)).toBe(true);
    // Item gắn outcome: gradeType scale, khoảng điểm là chỉ số scale 1..3.
    const itemRes = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Teamwork outcome', outcomeId });
    expect(itemRes.status).toBe(201);
    expect(itemRes.body.gradeType).toBe('scale');
    expect(itemRes.body.scaleId).toBe(scaleId);
    expect(itemRes.body.outcomeId).toBe(outcomeId);
    expect(itemRes.body.gradeMin).toBe(1);
    expect(itemRes.body.gradeMax).toBe(3);
    const outcomeItemId = itemRes.body.id as string;
    const normal = await createGradeItem(app, admin, course.id, { itemName: 'Exam', gradeMax: 100 });
    await setGrade(app, admin, normal.id, student.id, 80);
    // Điểm outcome ngoài thang (4 > 3 mức) hoặc không nguyên bị từ chối 400.
    const outOfScale = await http(app).post(`/api/v1/courses/grades/items/${outcomeItemId}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 4 });
    expect(outOfScale.status).toBe(400);
    expect(outOfScale.body.code).toBe('grades.outcome_grade_out_of_scale');
    const grade = await setGrade(app, admin, outcomeItemId, student.id, 2);
    expect(grade.finalGrade).toBe(2);
    // Gradebook: outcome item hiển thị nhãn scale tương ứng; tổng khoá học chỉ gồm item số (80/100).
    const book = await getGradebook(app, admin, course.id, student.id);
    const row = book.categories[0]?.items.find((i) => i.item.id === outcomeItemId) as unknown as { grade: { scaleValue: string | null; outcomeName: string | null } | null };
    expect(row?.grade?.scaleValue).toBe('Partially');
    expect(row?.grade?.outcomeName).toBe('Teamwork');
    expect(book.courseTotal?.grade?.finalGrade).toBeCloseTo(80, 6);
    expect(book.categories[0]?.total?.item.gradeMax).toBeCloseTo(100, 6);
    // Report: outcome xuất hiện kèm nhãn scale cho từng user.
    const report = await http(app).get(`/api/v1/courses/${course.id}/grades/report`).set('Authorization', `Bearer ${admin}`);
    const reportRow = (report.body.rows as { userId: string; outcomes: { outcomeId: string; scaleValue: string | null }[] }[])
      .find((r) => r.userId === student.id);
    expect(reportRow?.outcomes.find((o) => o.outcomeId === outcomeId)?.scaleValue).toBe('Partially');
  });

  it('calculated grade items: công thức average từ 2 item thường khớp tính tay ở course total; validate idNumber lạ/vòng/hàm lạ lúc lưu', async () => {
    const { course, student } = await setupCourse();
    const a = await createGradeItem(app, admin, course.id, { itemName: 'Quiz 1', idNumber: 'quiz1', gradeMax: 100 });
    const b = await createGradeItem(app, admin, course.id, { itemName: 'Quiz 2', idNumber: 'quiz2', gradeMax: 100 });
    // idNumber không tồn tại ⇒ 400 ngay lúc tạo.
    const unknown = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Bad ref', itemType: 'calculated', calculation: '=sum([[nope]])' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('grades.calculation_unknown_idnumber');
    // Cú pháp sai ⇒ 400; hàm không thuộc tập hỗ trợ ⇒ 400 với mã riêng.
    // (power/round/mod/pi/if đã được hỗ trợ từ issue #24 — xem grades-export-import-flow.)
    const syntax = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Bad syntax', itemType: 'calculated', calculation: '=sum([[quiz1]],)' });
    expect(syntax.status).toBe(400);
    expect(syntax.body.code).toBe('grades.calculation_invalid');
    const fn = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Bad fn', itemType: 'calculated', calculation: '=foo([[quiz1]],2)' });
    expect(fn.status).toBe(400);
    expect(fn.body.code).toBe('grades.calculation_unknown_function');
    // Tự tham chiếu ⇒ vòng ⇒ 400.
    const selfCycle = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Self cycle', itemType: 'calculated', idNumber: 'selfx', calculation: '=sum([[selfx]])' });
    expect(selfCycle.status).toBe(400);
    expect(selfCycle.body.code).toBe('grades.calculation_cycle');
    // Calculated hợp lệ: average(quiz1, quiz2).
    const calcRes = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Quiz average', itemType: 'calculated', idNumber: 'avg', calculation: '=average([[quiz1]],[[quiz2]])', gradeMax: 100 });
    expect(calcRes.status).toBe(201);
    const calcId = calcRes.body.id as string;
    // Vòng gián tiếp qua calculated khác bị chặn lúc CẬP NHẬT: c1 → avg, rồi sửa avg → c1.
    const c1Res = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'Chain', itemType: 'calculated', idNumber: 'chain', calculation: '=sum([[avg]])' });
    expect(c1Res.status).toBe(201);
    const indirect = await http(app).patch(`/api/v1/courses/grades/items/${calcId}`).set('Authorization', `Bearer ${admin}`)
      .send({ calculation: '=sum([[chain]])' });
    expect(indirect.status).toBe(400);
    expect(indirect.body.code).toBe('grades.calculation_cycle');
    await http(app).delete(`/api/v1/courses/grades/items/${c1Res.body.id}`).set('Authorization', `Bearer ${admin}`);
    // Không nhập điểm trực tiếp vào calculated item.
    const entered = await http(app).post(`/api/v1/courses/grades/items/${calcId}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 10 });
    expect(entered.status).toBe(400);
    expect(entered.body.code).toBe('grades.calculated_item');
    await setGrade(app, admin, a.id, student.id, 80);
    await setGrade(app, admin, b.id, student.id, 60);
    // average = 70; course total natural = (80 + 60 + 70) trên thang cấu trúc 300 ⇒ 210.
    let book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === calcId)?.grade?.finalGrade).toBeCloseTo(70, 6);
    expect(book.courseTotal?.grade?.finalGrade).toBeCloseTo(210, 6);
    expect(book.categories[0]?.total?.item.gradeMax).toBeCloseTo(300, 6);
    // Đổi điểm nguồn ⇒ calculated và tổng được tính lại: average(100, 60) = 80; tổng = 100 + 60 + 80 = 240.
    await setGrade(app, admin, a.id, student.id, 100);
    book = await getGradebook(app, admin, course.id, student.id);
    expect(book.categories[0]?.items.find((i) => i.item.id === calcId)?.grade?.finalGrade).toBeCloseTo(80, 6);
    expect(book.courseTotal?.grade?.finalGrade).toBeCloseTo(240, 6);
  });

  it('calculated item trong category con: category total khớp tính tay (sum của 2 item + chính calculated item)', async () => {
    const { course, student } = await setupCourse();
    const sub = await createGradeCategory(app, admin, course.id, { fullName: 'CalcCat', aggregation: 'natural' });
    const x = await createGradeItem(app, admin, course.id, { itemName: 'X', categoryId: sub.id, idNumber: 'cx', gradeMax: 100 });
    const y = await createGradeItem(app, admin, course.id, { itemName: 'Y', categoryId: sub.id, idNumber: 'cy', gradeMax: 100 });
    const calcRes = await http(app).post(`/api/v1/courses/${course.id}/grades/items`).set('Authorization', `Bearer ${admin}`)
      .send({ itemName: 'X+Y', itemType: 'calculated', categoryId: sub.id, calculation: '=sum([[cx]],[[cy]])', gradeMax: 200 });
    expect(calcRes.status).toBe(201);
    await setGrade(app, admin, x.id, student.id, 80);
    await setGrade(app, admin, y.id, student.id, 60);
    // calculated = 140/200; category natural: (80 + 60 + 140) trên thang 100+100+200=400 ⇒ 280; course total = 280/400.
    const book = await getGradebook(app, admin, course.id, student.id);
    const subView = (book.categories[0]?.children as unknown as { total: { grade: { finalGrade: number | null } | null; item: { gradeMax: number } } | null }[])[0];
    expect(subView?.total?.grade?.finalGrade).toBeCloseTo(280, 6);
    expect(subView?.total?.item.gradeMax).toBeCloseTo(400, 6);
    expect(book.courseTotal?.grade?.finalGrade).toBeCloseTo(280, 6);
  });

});
