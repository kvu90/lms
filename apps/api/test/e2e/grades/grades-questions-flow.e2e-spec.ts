import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuestionsService } from '../../../src/modules/questions/questions.service';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../../support/identity-access-helpers';
import { createCategory, createCm, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from '../../support/course-enrolment-helpers';
import { createGradeItem, getGradebook, setGrade } from '../../support/assessment-helpers';

/**
 * Assessment flows — điểm theo TỪNG BÀI (issue #224: không còn tổng hợp
 * theo khoá/category, không còn letters/scales/outcomes/calculated).
 * Oracle: Moodle 5.3 PHPUnit:
 *  - public/question/engine/tests/questionusagebyactivity_test.php
 *    (usage nhóm các lần thử, phản hồi trì hoãn, các bước) — ĐÃ KIỂM CHỨNG ở bản 5.3;
 *  - các trường hợp điểm của public/lib/tests/completionlib_test.php
 *    (test_internal_get_state_with_grade_criteria, test_inform_grade_changed)
 *    — ĐÃ KIỂM CHỨNG ở bản 5.3: hoàn thành đi theo điểm.
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

  it('override: điểm đã ghi đè không nhận điểm gốc mới (403), khoá mục chặn nhập cho mọi người, history ghi đủ vết', async () => {
    const { course, student, instance } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Exam', gradeMax: 100 });
    const grade = await setGrade(app, admin, item.id, student.id, 40);
    // Giáo viên ghi đè điểm cuối cùng thành 88.
    const patched = await http(app).patch(`/api/v1/grades/${grade.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ overridden: true, finalGrade: 88 });
    expect(patched.status).toBe(200);
    expect(patched.body.finalGrade).toBe(88);
    // Nhập điểm gốc mới bị từ chối trong khi đang ghi đè…
    const refused = await http(app).post(`/api/v1/grade-items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 10 });
    expect(refused.status).toBe(403);
    // …và góc nhìn theo từng hoạt động vẫn hiển thị 88 đã ghi đè.
    const book = await getGradebook(app, admin, course.id, student.id);
    const leaf = book.activities.find((i) => i.item.id === item.id);
    expect(leaf?.grade?.finalGrade).toBe(88);
    // Khoá ITEM chặn nhập đối với mọi người.
    await http(app).patch(`/api/v1/grade-items/${item.id}`).set('Authorization', `Bearer ${admin}`).send({ locked: true });
    const other = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, other.id);
    const lockedAttempt = await http(app).post(`/api/v1/grade-items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: other.id, rawGrade: 5 });
    expect(lockedAttempt.status).toBe(403);
    const history = await http(app).get(`/api/v1/grade-items/${item.id}/users/${student.id}/history`).set('Authorization', `Bearer ${admin}`);
    expect(history.status).toBe(200);
    expect((history.body as unknown[]).length).toBeGreaterThanOrEqual(2);
  });

  it('freeze: a grade produced with a multiplicator is frozen — changing the multiplicator later does not rewrite it until unfrozen', async () => {
    const { course, student } = await setupCourse();
    const item = await createGradeItem(app, admin, course.id, { itemName: 'Penalised', gradeMax: 100, multiplicator: 0.5 });
    const grade = await setGrade(app, admin, item.id, student.id, 80);
    expect(grade.finalGrade).toBeCloseTo(40, 6); // 80 * 0.5 hình phạt áp dụng một lần
    expect(grade.frozen).toBe(true);
    // Giáo viên gỡ hình phạt sau đó: điểm đã đông cứng KHÔNG được thay đổi.
    await http(app).patch(`/api/v1/grade-items/${item.id}`).set('Authorization', `Bearer ${admin}`).send({ multiplicator: 1 });
    let book = await getGradebook(app, admin, course.id, student.id);
    expect(book.activities.find((i) => i.item.id === item.id)?.grade?.finalGrade).toBeCloseTo(40, 6);
    // Rã đông + nhập lại áp dụng công thức hiện tại.
    const gradeId = book.activities.find((i) => i.item.id === item.id)?.grade?.id;
    await http(app).patch(`/api/v1/grades/${gradeId}`).set('Authorization', `Bearer ${admin}`).send({ frozen: false });
    // Nhập lại cùng điểm gốc nay tính lại mà không có hình phạt.
    const reentered = await http(app).post(`/api/v1/grade-items/${item.id}/grades`).set('Authorization', `Bearer ${admin}`)
      .send({ userId: student.id, rawGrade: 80 });
    expect(reentered.status).toBeLessThan(300);
    book = await getGradebook(app, admin, course.id, student.id);
    expect(book.activities.find((i) => i.item.id === item.id)?.grade?.finalGrade).toBeCloseTo(80, 6);
  });

  it('permissions and privacy: students cannot enter grades, see only their own grades, and hidden items are filtered', async () => {
    const { course, student, studentToken } = await setupCourse();
    const visible = await createGradeItem(app, admin, course.id, { itemName: 'Visible', gradeMax: 100 });
    const hidden = await createGradeItem(app, admin, course.id, { itemName: 'Secret', gradeMax: 100, hidden: true });
    await setGrade(app, admin, visible.id, student.id, 70);
    await setGrade(app, admin, hidden.id, student.id, 30);
    const entry = await http(app).post(`/api/v1/grade-items/${visible.id}/grades`).set('Authorization', `Bearer ${studentToken}`)
      .send({ userId: student.id, rawGrade: 100 });
    expect(entry.status).toBe(403);
    const mine = await getGradebook(app, studentToken, course.id);
    expect(mine.userId).toBe(student.id);
    expect(mine.activities.map((i) => i.item.itemName)).toContain('Visible');
    expect(mine.activities.map((i) => i.item.itemName)).not.toContain('Secret');
    const others = await http(app).get(`/api/v1/courses/${course.id}/gradebook`).query({ userId: 999999 }).set('Authorization', `Bearer ${studentToken}`);
    expect(others.status).toBe(403);
    const teacherView = await getGradebook(app, admin, course.id, student.id);
    expect(teacherView.activities.map((i) => i.item.itemName)).toContain('Secret');
  });


  // Payload TF-A của spec: thân + 4 mệnh đề với đáp án cho trước.
  const tfBody = (stem: string, values: boolean[]) => ({
    qtype: 'truefalse',
    questionText: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: stem }] },
        {
          type: 'statementList',
          content: values.map((v, i) => ({
            type: 'statement',
            attrs: { id: `s${i + 1}` },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: `${stem} — ý ${i + 1}` }] }],
          })),
        },
      ],
    },
    solution: { answers: values.map((v, i) => ({ statementId: `s${i + 1}`, value: v })) },
  });
  const TF_ALL_TRUE = JSON.stringify({ s1: true, s2: true, s3: true, s4: true });

  it('question bank versioning: editing a question creates a new version and bumps the entry pointer; old versions stay intact', async () => {
    const systemCtxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (systemCtxRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const catRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Bank cat', contextId: systemCtx.id });
    expect(catRes.status).toBeLessThan(300);
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, ...tfBody('The sky is blue.', [true, false, true, false]) });
    expect(qRes.status).toBeLessThan(300);
    const qid = qRes.body.question.id as string;
    expect(qRes.body.entry.latestVersion).toBe(1);
    const edit = await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`)
      .send({ questionText: tfBody('The sky is green.', [false, true, false, true]).questionText, solution: tfBody('The sky is green.', [false, true, false, true]).solution });
    expect(edit.status).toBe(200);
    expect(edit.body.entry.latestVersion).toBe(2);
    expect(edit.body.latestVersion.version).toBe(2);
    const versions = await http(app).get(`/api/v1/questions/${qid}/versions`).set('Authorization', `Bearer ${admin}`);
    expect(versions.body).toHaveLength(2);
    // questionText nay là tài liệu Tiptap (jsonb): text thuần nằm ở node text đầu tiên.
    const docText = (doc: { content: { content?: { text?: string }[] }[] }) => doc.content[0]?.content?.[0]?.text;
    expect(docText(versions.body[0].questionText)).toBe('The sky is blue.');
    expect(docText(versions.body[1].questionText)).toBe('The sky is green.');
    // Đáp án TF-A nằm ở phía đáp án (question_answer_keys.solution)
    // theo TỪNG VERSION: v1 giữ nguyên đáp án gốc, v2 mang đáp án đã
    // lật — kiểm chứng thẳng ở DB và qua view.
    const keyOf = async (versionId: string) => {
      const rows = await pg.query(
        'select solution from question_answer_keys where question_version_id = $1', [versionId]);
      return (rows.rows[0] as { solution: { answers: { statementId: string; value: boolean }[] } }).solution;
    };
    expect((await keyOf(versions.body[0].id)).answers[0]).toEqual({ statementId: 's1', value: true });
    expect((await keyOf(versions.body[1].id)).answers[0]).toEqual({ statementId: 's1', value: false });
    const view = await http(app).get(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`);
    expect(view.body.answers).toHaveLength(0);
    expect(view.body.answerKey.solution.answers).toEqual([
      { statementId: 's1', value: false },
      { statementId: 's2', value: true },
      { statementId: 's3', value: false },
      { statementId: 's4', value: true },
    ]);
  });

  it('INVARIANT: an attempt started on version 1 is graded by version 1 even after the question is edited to version 2', async () => {
    const systemCtxRes = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (systemCtxRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const catRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Invariant cat', contextId: systemCtx.id });
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: catRes.body.id, ...tfBody('Water is wet.', [true, true, true, true]) });
    const qid = qRes.body.question.id as string;
    const student = await createUserViaApi(app, admin);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    // Usage được tạo và BẮT ĐẦU khi v1 là mới nhất ⇒ ghim v1.
    // Mẫu dựng sau khi #60 (chủ sở hữu) + #55 (cổng tạo usage qua HTTP
    // đòi question:useall) cùng có mặt: usage do hoạt động tạo ở tầng
    // service với actor là chính học sinh (trước đây học sinh tự tạo
    // qua HTTP — cổng #55 chặn 404 vì usage thô qua HTTP là đường đọc
    // đáp án). Mọi assertion bất biến version bên dưới giữ nguyên.
    const created = await app.get(QuestionsService).createUsage(student.id, {
      component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-000000000042', slots: [{ questionId: qid }],
    });
    const usageId = created.usage.id as string;
    const attemptId = created.attempts[0].id as string;
    expect(created.attempts[0].state).toBe('notstarted');
    const v1Id = qRes.body.latestVersion.id as string;
    await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`).set('Authorization', `Bearer ${studentToken}`);
    // NAY giáo viên sửa câu hỏi: đáp án đúng lật ở v2.
    await http(app).patch(`/api/v1/questions/${qid}`).set('Authorization', `Bearer ${admin}`).send({ solution: tfBody('Water is wet.', [false, false, false, false]).solution });
    // Học viên trả lời 'true' và hoàn tất: chấm theo v1 ⇒ đúng.
    const submit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`).set('Authorization', `Bearer ${studentToken}`).send({ response: TF_ALL_TRUE });
    expect(submit.body.state).toBe('complete');
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${studentToken}`);
    expect(finished.body.state).toBe('finished');
    const attempt = finished.body.attempts[0];
    expect(attempt.questionVersionId).toBe(v1Id);
    expect(attempt.state).toBe('gradedright');
    expect(attempt.fraction).toBe(1);
    // Các bước ghi lại mọi chuyển đổi: todo → complete → gradedright.
    expect(attempt.steps.map((s: { state: string }) => s.state)).toEqual(['todo', 'complete', 'gradedright']);
    expect(attempt.steps[1].data.answer).toBe(TF_ALL_TRUE);
    // Một usage MỚI ghim v2: cùng đáp án nay thành sai.
    const created2 = await app.get(QuestionsService).createUsage(student.id, {
      component: 'mod_quiz', instanceId: '01900000-0000-7000-8000-000000000042', slots: [{ questionId: qid }],
    });
    const usage2Id = created2.usage.id as string;
    const attempt2Id = created2.attempts[0].id as string;
    await http(app).post(`/api/v1/question-usages/${usage2Id}/attempts/${attempt2Id}/start`).set('Authorization', `Bearer ${studentToken}`);
    await http(app).post(`/api/v1/question-usages/${usage2Id}/attempts/${attempt2Id}/submit`).set('Authorization', `Bearer ${studentToken}`).send({ response: TF_ALL_TRUE });
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
    // Trước khi có điểm: hoạt động bị gác cổng trả 403 và hoàn thành ở trạng thái chưa hoàn thành.
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmNext.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    let progress = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cmQuiz.id)?.state).toBe(0);
    // Điểm trượt (40 < ngưỡng đạt 50): hoàn thành trở thành complete-fail (3), cổng vẫn đóng (40% < 50%).
    await setGrade(app, admin, item.id, student.id, 40);
    progress = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cmQuiz.id)?.state).toBe(3);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmNext.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
    // Điểm đạt (80): hoàn thành trở thành complete-pass (2) và cổng mở.
    await setGrade(app, admin, item.id, student.id, 80);
    progress = await http(app).get(`/api/v1/courses/${course.id}/completion/users/${student.id}`).set('Authorization', `Bearer ${admin}`);
    expect(progress.body.activities.find((a: { cmId: string }) => a.cmId === cmQuiz.id)?.state).toBe(2);
    expect((await http(app).get(`/api/v1/courses/${course.id}/modules/${cmNext.id}/access`).set('Authorization', `Bearer ${studentToken}`)).status).toBe(200);
    // Chuỗi bền vững tồn tại trong outbox: grade_updated + cm_completion_changed.
    const types = await outboxTypes('courseId', course.id);
    expect(types).toContain('grade_updated');
    const cmEvents = await pg.query("select count(*)::int as n from outbox_events where type='cm_completion_changed' and payload->>'cmId' = $1", [String(cmQuiz.id)]);
    expect((cmEvents.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(2);
  });
});
