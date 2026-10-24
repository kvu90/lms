import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { getGradebook } from './assessment-helpers';

/**
 * Hoạt động Quiz (issue #30, chặng 1) — oracle là ngữ nghĩa mod_quiz của
 * Moodle:
 *  - câu hỏi độc lập trong ngân hàng (default_mark là gợi ý); điểm thật
 *    nằm ở slot của đề (quiz_slots.max_mark) và được truyền xuống
 *    question_attempts.max_mark khi lượt làm bắt đầu;
 *  - điểm câu = fraction × maxMark; điểm lượt = tổng các câu đã chấm;
 *    điểm bài = điểm lượt quy về thang grade của quiz, chọn theo
 *    grade_method khi có nhiều lượt, ghi vào grade item 'mod' của cm;
 *  - essay không tự chấm: lượt ở trạng thái chờ chấm tay cho tới khi
 *    giáo viên cho điểm qua bước chấm của engine.
 */
describe('Quiz activity (mod_quiz)', () => {
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

  interface Ctx {
    course: { id: string };
    sectionId: string;
    teacher: string;
    teacherId: string;
    student: { id: string; username: string };
    studentToken: string;
    bankCatId: string;
    randomCatId: string;
    qMc: string;
    qTf: string;
    qSa: string;
    qEssay: string;
  }

  async function setup(): Promise<Ctx> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    // Giáo viên: role editingteacher tại context của khoá học.
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Quiz bank', contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const randomRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Quiz random pool', contextId: systemCtx.id });
    const randomCatId = randomRes.body.id as string;

    async function makeQuestion(categoryId: string, body: Record<string, unknown>): Promise<string> {
      const res = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({ categoryId, ...body });
      if (res.status !== 201 && res.status !== 200) throw new Error(`create question failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body.question.id as string;
    }
    const qMc = await makeQuestion(bankCatId, {
      qtype: 'multichoice', name: 'Capital', questionText: 'Capital of France?', defaultMark: 2,
      answers: [{ text: 'Paris', fraction: 1 }, { text: 'London', fraction: 0 }],
      options: { single: true },
    });
    const qTf = await makeQuestion(bankCatId, {
      qtype: 'truefalse', name: 'Water', questionText: 'Water is wet.', defaultMark: 1, answer: { correct: true },
    });
    const qSa = await makeQuestion(bankCatId, {
      qtype: 'shortanswer', name: 'Capital VN', questionText: 'Capital of Vietnam?', defaultMark: 1,
      answers: [{ text: 'Hanoi', fraction: 1 }],
    });
    const qEssay = await makeQuestion(bankCatId, {
      qtype: 'essay', name: 'Essay', questionText: 'Describe your town.', defaultMark: 3,
    });
    for (const name of ['R1', 'R2']) {
      await makeQuestion(randomCatId, {
        qtype: 'truefalse', name, questionText: `${name}: the sun rises in the east.`, defaultMark: 1, answer: { correct: true },
      });
    }
    return { course, sectionId, teacher, teacherId: teacherUser.id, student, studentToken, bankCatId, randomCatId, qMc, qTf, qSa, qEssay };
  }

  async function createQuiz(token: string, courseId: string, body: Record<string, unknown>) {
    const res = await http(app).post(`/api/v1/courses/${courseId}/quizzes`).set('Authorization', `Bearer ${token}`).send(body);
    return res;
  }
  async function addSlot(token: string, quizId: string, body: Record<string, unknown>) {
    const res = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set('Authorization', `Bearer ${token}`).send(body);
    if (res.status !== 201 && res.status !== 200) throw new Error(`add slot failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
  /** Trả lời một câu theo slot: tìm question attempt của slot đó trong view hiện tại. */
  async function answerSlot(token: string, attemptId: string, view: AttemptViewBody, slot: number, response: string) {
    const q = view.questions.find((x) => x.slot === slot)!;
    const res = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/responses`).set('Authorization', `Bearer ${token}`)
      .send({ questionAttemptId: q.questionAttemptId, response });
    if (res.status !== 200 && res.status !== 201) throw new Error(`answer failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as AttemptViewBody;
  }
  interface AttemptViewBody {
    attempt: { id: string; state: string; sumGrades: number | null; grade: number | null; preview: boolean; attemptNumber: number };
    questions: {
      slot: number; page: number; questionAttemptId: string; questionId: string; qtype: string;
      maxMark: number; state: string; fraction: number | null; mark: number | null; response: string | null;
      answers: { id: string; text: unknown }[];
    }[];
    pendingManualCount: number;
    closedDueToTimeLimit: boolean;
  }
  async function gradeOfQuizItem(courseId: string, cmId: string, userId: string): Promise<number | null> {
    const book = await getGradebook(app, admin, courseId, userId);
    for (const category of book.categories as unknown as { items: { item: { itemInstance: string | null }; grade: { finalGrade: number | null } | null }[] }[]) {
      const found = category.items.find((i) => i.item.itemInstance === cmId);
      if (found) return found.grade?.finalGrade ?? null;
    }
    return null;
  }

  it('full round: slot marks rule, random slot, essay manual grading changes the recorded grade', async () => {
    const ctx = await setup();
    // Học sinh không tạo được quiz.
    const denied = await createQuiz(ctx.studentToken, ctx.course.id, { sectionId: ctx.sectionId, name: 'Nope' });
    expect(denied.status).toBe(403);

    const quizRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Quiz 1', grade: 10, gradeMethod: 'highest',
    });
    expect(quizRes.status).toBe(201);
    const quiz = quizRes.body;
    expect(quiz.cmId).toBeTruthy();
    const quizId = quiz.id as string;

    // Slots: mc sửa điểm 5 (default là 2 — điểm slot phải thắng), tf giữ
    // default 1, slot ngẫu nhiên 2 điểm, essay giữ default 3. Tổng 11.
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qMc, maxMark: 5 });
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qTf });
    await addSlot(ctx.teacher, quizId, { categoryId: ctx.randomCatId, maxMark: 2 });
    const withSlots = await addSlot(ctx.teacher, quizId, { questionId: ctx.qEssay });
    expect(withSlots.sumGrades).toBe(11);
    expect(withSlots.slots.map((s: { maxMark: number }) => s.maxMark)).toEqual([5, 1, 2, 3]);

    const info = await http(app).get(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(info.status).toBe(200);
    expect(info.body.canAttempt).toBe(true);

    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(start.status).toBe(201);
    let view = start.body as AttemptViewBody;
    const attemptId = view.attempt.id;
    expect(view.questions.map((q) => q.slot)).toEqual([1, 2, 3, 4]);
    // maxMark của từng question attempt trong engine = maxMark của slot.
    expect(view.questions.map((q) => q.maxMark)).toEqual([5, 1, 2, 3]);
    // Slot 3 là câu ngẫu nhiên từ category (một trong hai câu của pool).
    expect(view.questions[2]!.qtype).toBe('truefalse');
    // Đang làm bài: không lộ fraction của đáp án.
    for (const q of view.questions) {
      for (const a of q.answers) expect(a).not.toHaveProperty('fraction');
    }

    // Trả lời: mc chọn "Paris" (đúng), tf true (đúng), random true (cả
    // pool đều correct=true nên luôn đúng), essay viết bài.
    const mcQ = view.questions[0]!;
    const paris = mcQ.answers.find((a) => JSON.stringify(a.text).includes('Paris'))!;
    view = await answerSlot(ctx.studentToken, attemptId, view, 1, paris.id);
    view = await answerSlot(ctx.studentToken, attemptId, view, 2, 'true');
    view = await answerSlot(ctx.studentToken, attemptId, view, 3, 'true');
    view = await answerSlot(ctx.studentToken, attemptId, view, 4, 'My town is small and quiet.');

    const submit = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/submit`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(submit.status).toBe(201);
    const submitted = submit.body as AttemptViewBody;
    // Essay chưa chấm ⇒ lượt chờ chấm tay; điểm đã chốt một phần: 5+1+2.
    expect(submitted.attempt.state).toBe('needsgrading');
    expect(submitted.pendingManualCount).toBe(1);
    expect(submitted.attempt.sumGrades).toBe(8);
    // Điểm bài chưa ghi vào sổ khi còn chờ chấm tay.
    expect(await gradeOfQuizItem(ctx.course.id, quiz.cmId, ctx.student.id)).toBeNull();

    // Học sinh không xem được báo cáo lớp.
    const reportsDenied = await http(app).get(`/api/v1/quizzes/${quizId}/results`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(reportsDenied.status).toBe(403);
    const results = await http(app).get(`/api/v1/quizzes/${quizId}/results`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(results.status).toBe(200);
    expect(results.body.needsGrading).toHaveLength(1);
    expect(results.body.needsGrading[0].slot).toBe(4);
    expect(results.body.needsGrading[0].response).toBe('My town is small and quiet.');

    // Chấm essay 3/3 ⇒ lượt finished, tổng 11/11 ⇒ điểm bài 10/10.
    const essayQa = results.body.needsGrading[0].questionAttemptId as string;
    const graded = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/questions/${essayQa}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ mark: 3, comment: 'Good' });
    expect(graded.status).toBe(201);
    expect(graded.body.attempt.state).toBe('finished');
    expect(graded.body.attempt.sumGrades).toBe(11);
    expect(graded.body.attempt.grade).toBe(10);
    expect(await gradeOfQuizItem(ctx.course.id, quiz.cmId, ctx.student.id)).toBe(10);

    // Completion của cm theo điểm: đã hoàn thành.
    const progress = await http(app).get(`/api/v1/courses/${ctx.course.id}/completion/users/${ctx.student.id}`).set('Authorization', `Bearer ${admin}`);
    const cmState = (progress.body.activities as { cmId: string; state: number }[]).find((a) => a.cmId === quiz.cmId)?.state;
    expect(cmState).toBeGreaterThanOrEqual(1);

    // Outbox mang sự kiện của quiz.
    const events = await pg.query("select type from outbox_events where payload->>'quizId' = $1", [quizId]);
    const types = (events.rows as { type: string }[]).map((r) => r.type);
    expect(types).toContain('quiz_attempt_started');
    expect(types).toContain('quiz_attempt_finished');
    expect(types).toContain('quiz_attempt_regraded');
  });

  it('grade method highest across attempts, attempts limit enforced, attempts of others are private', async () => {
    const ctx = await setup();
    const quizRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Quiz 2', grade: 10, gradeMethod: 'highest', attemptsAllowed: 2,
    });
    const quiz = quizRes.body;
    const quizId = quiz.id as string;
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qTf, maxMark: 1 });
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qSa, maxMark: 1 });

    async function playAll(correctTf: boolean, correctSa: boolean): Promise<AttemptViewBody> {
      const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
      expect(start.status).toBe(201);
      let view = start.body as AttemptViewBody;
      const attemptId = view.attempt.id;
      view = await answerSlot(ctx.studentToken, attemptId, view, 1, correctTf ? 'true' : 'false');
      view = await answerSlot(ctx.studentToken, attemptId, view, 2, correctSa ? 'Hanoi' : 'Hue');
      const submit = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/submit`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
      expect(submit.status).toBe(201);
      return submit.body as AttemptViewBody;
    }

    const first = await playAll(false, false);
    expect(first.attempt.state).toBe('finished');
    expect(first.attempt.grade).toBe(0);
    const second = await playAll(true, true);
    expect(second.attempt.grade).toBe(10);
    // Highest: điểm bài là 10 dù lượt đầu 0.
    expect(await gradeOfQuizItem(ctx.course.id, quiz.cmId, ctx.student.id)).toBe(10);

    // Lượt 3 vượt giới hạn 2.
    const third = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(third.status).toBe(403);
    expect(third.body.code).toBe('quiz.no_more_attempts');

    // Học sinh khác không đọc được lượt làm của học sinh này.
    const other = await createUserViaApi(app, admin);
    const instance = await createEnrolInstance(app, admin, ctx.course.id);
    await enrolUser(app, admin, ctx.course.id, instance.id, other.id);
    const otherToken = (await login(app, other.username, STRONG_PASSWORD)).accessToken;
    const peek = await http(app).get(`/api/v1/quiz-attempts/${first.attempt.id}`).set('Authorization', `Bearer ${otherToken}`);
    expect(peek.status).toBe(403);
  });

  it('time window blocks attempts outside open/close; time limit closes the attempt server-side on interaction', async () => {
    const ctx = await setup();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const past = new Date(Date.now() - 3600_000).toISOString();

    const notOpenRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Future quiz', timeOpen: future,
    });
    const notOpenId = notOpenRes.body.id as string;
    await addSlot(ctx.teacher, notOpenId, { questionId: ctx.qTf });
    const early = await http(app).post(`/api/v1/quizzes/${notOpenId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(early.status).toBe(403);
    expect(early.body.code).toBe('quiz.not_yet_open');

    const closedRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Closed quiz', timeClose: past,
    });
    const closedId = closedRes.body.id as string;
    await addSlot(ctx.teacher, closedId, { questionId: ctx.qTf });
    const late = await http(app).post(`/api/v1/quizzes/${closedId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(late.status).toBe(403);
    expect(late.body.code).toBe('quiz.closed');

    // Giới hạn thời gian: bắt đầu lượt, lùi time_start về quá khứ trong
    // DB, tương tác tiếp theo phải chốt lượt phía server.
    const timedRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Timed quiz', timeLimitSeconds: 600, grade: 10,
    });
    const timed = timedRes.body;
    await addSlot(ctx.teacher, timed.id, { questionId: ctx.qTf, maxMark: 1 });
    const start = await http(app).post(`/api/v1/quizzes/${timed.id}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(start.status).toBe(201);
    const attemptId = (start.body as AttemptViewBody).attempt.id;
    await pg.query("update quiz_attempts set time_start = now() - interval '1 hour' where id = $1", [attemptId]);
    const view = start.body as AttemptViewBody;
    const after = await answerSlot(ctx.studentToken, attemptId, view, 1, 'true');
    expect(after.closedDueToTimeLimit).toBe(true);
    expect(after.attempt.state).toBe('finished');
  });

  it('teacher preview does not consume attempts nor write grades; students cannot preview', async () => {
    const ctx = await setup();
    const quizRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Preview quiz', grade: 10, attemptsAllowed: 1,
    });
    const quiz = quizRes.body;
    const quizId = quiz.id as string;
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qTf, maxMark: 1 });

    const denied = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({ preview: true });
    expect(denied.status).toBe(403);

    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.teacher}`).send({ preview: true });
    expect(start.status).toBe(201);
    let view = start.body as AttemptViewBody;
    expect(view.attempt.preview).toBe(true);
    const attemptId = view.attempt.id;
    view = await answerSlot(ctx.teacher, attemptId, view, 1, 'true');
    const submit = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/submit`).set('Authorization', `Bearer ${ctx.teacher}`).send({});
    expect(submit.status).toBe(201);
    expect((submit.body as AttemptViewBody).attempt.state).toBe('finished');
    // Preview không ghi điểm cho giáo viên và không tính vào lượt của ai.
    expect(await gradeOfQuizItem(ctx.course.id, quiz.cmId, ctx.teacherId)).toBeNull();
    const infoStudent = await http(app).get(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(infoStudent.body.myAttempts).toHaveLength(0);
    expect(infoStudent.body.canAttempt).toBe(true);
  });

  it('slot management: edit mark, swap order, remove renumbers and totals follow', async () => {
    const ctx = await setup();
    const quizRes = await createQuiz(ctx.teacher, ctx.course.id, { sectionId: ctx.sectionId, name: 'Slots quiz' });
    const quizId = quizRes.body.id as string;
    let view = await addSlot(ctx.teacher, quizId, { questionId: ctx.qTf, maxMark: 1 });
    view = await addSlot(ctx.teacher, quizId, { questionId: ctx.qSa, maxMark: 2 });
    expect(view.sumGrades).toBe(3);
    const [s1, s2] = view.slots as { id: string; slot: number }[];

    const edited = await http(app).patch(`/api/v1/quizzes/${quizId}/slots/${s1!.id}`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ maxMark: 4 });
    expect(edited.status).toBe(200);
    expect(edited.body.sumGrades).toBe(6);

    const swapped = await http(app).patch(`/api/v1/quizzes/${quizId}/slots/${s2!.id}`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ slot: 1 });
    expect(swapped.status).toBe(200);
    expect((swapped.body.slots as { questionId: string }[]).map((s) => s.questionId)).toEqual([ctx.qSa, ctx.qTf]);

    const removed = await http(app).delete(`/api/v1/quizzes/${quizId}/slots/${s2!.id}`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(removed.status).toBe(200);
    expect(removed.body.slots).toHaveLength(1);
    expect(removed.body.slots[0].slot).toBe(1);
    expect(removed.body.sumGrades).toBe(4);

    // Học sinh không sửa được slot.
    const denied = await http(app).patch(`/api/v1/quizzes/${quizId}/slots/${s1!.id}`).set('Authorization', `Bearer ${ctx.studentToken}`)
      .send({ maxMark: 9 });
    expect(denied.status).toBe(403);
  });

  it('regression F1: preview and real attempts share ONE numbering sequence — no collision, no orphan usage', async () => {
    const ctx = await setup();
    // Một người có cả hai quyền: giáo viên đã có editingteacher (preview);
    // gán thêm role student tại context khoá để có quiz:attempt.
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === ctx.course.id)!;
    await assignRole(app, admin, ctx.teacherId, await roleIdByShortname(app, admin, 'student'), courseCtx.id);

    async function play(token: string, quizId: string, preview: boolean): Promise<AttemptViewBody> {
      const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${token}`)
        .send(preview ? { preview: true } : {});
      expect(start.status).toBe(201);
      let view = start.body as AttemptViewBody;
      view = await answerSlot(token, view.attempt.id, view, 1, 'true');
      const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${token}`).send({});
      expect(submit.status).toBe(201);
      return submit.body as AttemptViewBody;
    }
    async function expectNoOrphanUsage(quizId: string) {
      const usages = await pg.query("select count(*)::int as n from question_usages where instance_id::text = $1", [quizId]);
      const attempts = await pg.query('select count(*)::int as n from quiz_attempts where quiz_id = $1', [quizId]);
      expect((usages.rows[0] as { n: number }).n).toBe((attempts.rows[0] as { n: number }).n);
    }

    // Chiều 1: preview trước (số 1) rồi làm thật — bản cũ đánh số lượt
    // thật là 1 theo dãy riêng của cờ preview=false ⇒ va chạm ràng buộc
    // duy nhất ⇒ 500 và để lại usage mồ côi.
    const quizARes = await createQuiz(ctx.teacher, ctx.course.id, { sectionId: ctx.sectionId, name: 'F1 quiz A', grade: 10 });
    const quizA = quizARes.body.id as string;
    await addSlot(ctx.teacher, quizA, { questionId: ctx.qTf, maxMark: 1 });
    const previewFirst = await play(ctx.teacher, quizA, true);
    expect(previewFirst.attempt.preview).toBe(true);
    expect(previewFirst.attempt.attemptNumber).toBe(1);
    const realAfter = await play(ctx.teacher, quizA, false);
    expect(realAfter.attempt.preview).toBe(false);
    expect(realAfter.attempt.attemptNumber).toBe(2);
    await expectNoOrphanUsage(quizA);

    // Chiều 2: làm thật trước (số 1) rồi preview — cũng phải bắt đầu
    // được và mang số tiếp theo trong cùng dãy.
    const quizBRes = await createQuiz(ctx.teacher, ctx.course.id, { sectionId: ctx.sectionId, name: 'F1 quiz B', grade: 10 });
    const quizB = quizBRes.body.id as string;
    await addSlot(ctx.teacher, quizB, { questionId: ctx.qTf, maxMark: 1 });
    const realFirst = await play(ctx.teacher, quizB, false);
    expect(realFirst.attempt.attemptNumber).toBe(1);
    const previewAfter = await play(ctx.teacher, quizB, true);
    expect(previewAfter.attempt.preview).toBe(true);
    expect(previewAfter.attempt.attemptNumber).toBe(2);
    await expectNoOrphanUsage(quizB);
  });

  it('regression F2: an answer submitted after timeClose is not saved — the attempt is closed server-side', async () => {
    const ctx = await setup();
    const quizRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Closing quiz', grade: 10,
    });
    const quiz = quizRes.body;
    const quizId = quiz.id as string;
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qTf, maxMark: 1 });
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qSa, maxMark: 1 });

    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(start.status).toBe(201);
    let view = start.body as AttemptViewBody;
    const attemptId = view.attempt.id;
    // Trả lời đúng slot 1 TRƯỚC giờ đóng — phần này được giữ và tính.
    view = await answerSlot(ctx.studentToken, attemptId, view, 1, 'true');

    // Giáo viên dời giờ đóng về quá khứ trong lúc học sinh đang làm.
    const past = new Date(Date.now() - 60_000).toISOString();
    const patch = await http(app).patch(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.teacher}`).send({ timeClose: past });
    expect(patch.status).toBe(200);

    // Học sinh nộp thêm đáp án slot 2 (đáp án ĐÚNG) sau giờ đóng: bản cũ
    // lưu và tính điểm (isOverdue chỉ xét timeLimit); bản sửa phải chốt
    // lượt phía server, đáp án muộn không được lưu.
    const slot2 = view.questions.find((q) => q.slot === 2)!;
    const late = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/responses`).set('Authorization', `Bearer ${ctx.studentToken}`)
      .send({ questionAttemptId: slot2.questionAttemptId, response: 'Hanoi' });
    expect([200, 201]).toContain(late.status);
    const closed = late.body as AttemptViewBody;
    expect(closed.attempt.state).toBe('finished');
    expect(closed.closedDueToTimeLimit).toBe(true);
    const q2 = closed.questions.find((q) => q.slot === 2)!;
    expect(q2.response).toBeNull();
    expect(q2.mark ?? 0).toBe(0);
    // Chỉ phần đã lưu trước giờ đóng được tính: 1/2 câu ⇒ điểm bài 5/10.
    expect(closed.attempt.sumGrades).toBe(1);
    expect(closed.attempt.grade).toBe(5);
    expect(await gradeOfQuizItem(ctx.course.id, quiz.cmId, ctx.student.id)).toBe(5);
  });

  it('regression F3: a locked grade item must not fail the student submission', async () => {
    const ctx = await setup();
    const quizRes = await createQuiz(ctx.teacher, ctx.course.id, {
      sectionId: ctx.sectionId, name: 'Locked item quiz', grade: 10,
    });
    const quiz = quizRes.body;
    const quizId = quiz.id as string;
    await addSlot(ctx.teacher, quizId, { questionId: ctx.qTf, maxMark: 1 });

    // Khoá grade item của hoạt động qua API sổ điểm.
    const items = await http(app).get(`/api/v1/courses/${ctx.course.id}/grades/items`).set('Authorization', `Bearer ${admin}`);
    const item = (items.body as { id: string; itemType: string; itemInstance: string | null }[])
      .find((i) => i.itemType === 'mod' && i.itemInstance === quiz.cmId)!;
    expect(item).toBeTruthy();
    const lock = await http(app).patch(`/api/v1/courses/grades/items/${item.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ locked: true });
    expect(lock.status).toBe(200);

    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(start.status).toBe(201);
    let view = start.body as AttemptViewBody;
    const attemptId = view.attempt.id;
    view = await answerSlot(ctx.studentToken, attemptId, view, 1, 'true');
    // Bản cũ: lỗi grades.item_locked từ pushGrade truyền thẳng ra ⇒
    // học sinh nhận 403 dù lượt đã chốt. Bản sửa: nộp vẫn 201, lượt
    // finished, chỉ điểm là không ghi được vào item đang khoá.
    const submit = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/submit`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(submit.status).toBe(201);
    const submitted = submit.body as AttemptViewBody;
    expect(submitted.attempt.state).toBe('finished');
    expect(submitted.attempt.grade).toBe(10);
    expect(await gradeOfQuizItem(ctx.course.id, quiz.cmId, ctx.student.id)).toBeNull();
  });
});
