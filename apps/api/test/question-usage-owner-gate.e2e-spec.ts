import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuestionsService } from '../src/modules/questions/questions.service';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from './exam-pin-helpers';

/**
 * Issue #60 — cổng chủ sở hữu cho các route thao tác question usage thô:
 *  - người khác (không phải chủ usage) start/submit/finish qua route thô
 *    → 404 không-oracle, lượt của nạn nhân nguyên vẹn;
 *  - usage gắn lượt quiz đang `inprogress` bị khoá kênh thô kể cả với
 *    chính chủ (403 `question.usage_managed_by_quiz`) để đáp án đúng chỉ
 *    lộ qua luồng quiz sau khi nộp;
 *  - usage tự do của ngân hàng: chủ sở hữu vẫn làm trọn luồng như cũ.
 */
describe('Question usage owner gate (issue #60)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  interface QuizView {
    attempt: { id: string; usageId: string; state: string };
    questions: {
      slot: number; questionAttemptId: string; state: string;
      fraction: number | null; rightAnswer: string | null; response: string | null;
    }[];
  }

  interface Scenario {
    quizId: string;
    questionId: string;
    tokenA: string;
    tokenB: string;
    userIdA: string;
  }

  /** Khoá + giáo viên + hai học sinh ghi danh + quiz 1 slot truefalse (đáp án đúng: true). */
  async function setup(): Promise<Scenario> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;

    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    async function enrolledStudent(): Promise<{ token: string; userId: string }> {
      const user = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, user.id);
      return { token: (await login(app, user.username, STRONG_PASSWORD)).accessToken, userId: user.id };
    }
    const studentA = await enrolledStudent();
    const studentB = await enrolledStudent();
    const tokenA = studentA.token;
    const tokenB = studentB.token;
    const userIdA = studentA.userId;

    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Gate bank', contextId: systemCtx.id });
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({
        categoryId: bankRes.body.id, qtype: 'truefalse', name: 'Water', questionText: 'Water is wet.',
        defaultMark: 1, answer: { correct: true },
      });
    const questionId = qRes.body.question.id as string;

    // Ngữ nghĩa review của Chặng 2 (issue #30): mặc định Moodle cho
    // review_right_answer = 272 chỉ gồm cửa sổ "sau đó khi đề còn mở"
    // (0x00100) + "sau khi đóng" (0x00010), KHÔNG gồm cửa sổ "ngay sau
    // nộp" (0x01000) — nộp xong đáp án đúng chưa lộ ngay. Spec này cần
    // khẳng định đáp án lộ qua luồng quiz ngay sau khi nộp nên ghim
    // tường minh bitmask 4368 (gồm cửa sổ ngay-sau-nộp); cửa sổ "đang
    // làm" (0x10000) vẫn tắt nên đáp án vẫn ẩn trong lúc làm như cũ.
    const draft = await createExamDraft(app, teacher, 'Gate quiz', 10);
    await addExamSlot(app, teacher, draft, { questionId });
    const pin = await pinExam(app, teacher, course.id, draft, { sectionId, reviewRightAnswer: 4368 });
    const quizId = pin.id as string;
    return { quizId, questionId, tokenA, tokenB, userIdA };
  }

  /** Học sinh bắt đầu lượt quiz và trả lời 'true' qua kênh quiz; trả view hiện tại. */
  async function startAndAnswer(token: string, quizId: string): Promise<QuizView> {
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send({});
    expect(start.status).toBe(201);
    const view = start.body as QuizView;
    expect(view.attempt.state).toBe('inprogress');
    expect(view.questions[0]!.rightAnswer).toBeNull();
    const answered = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`)
      .set('Authorization', `Bearer ${token}`)
      .send({ questionAttemptId: view.questions[0]!.questionAttemptId, response: 'true' });
    expect(answered.status).toBeLessThan(300);
    return answered.body as QuizView;
  }

  it('stranger cannot submit into or finish another student\'s in-progress quiz usage; the owner finishes through the quiz flow', async () => {
    const s = await setup();
    const view = await startAndAnswer(s.tokenA, s.quizId);
    const usageId = view.attempt.usageId;
    const questionAttemptId = view.questions[0]!.questionAttemptId;

    // (a) B submit đáp án vào attempt của A qua route thô → 404 attempt_not_found.
    const bSubmit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${questionAttemptId}/submit`)
      .set('Authorization', `Bearer ${s.tokenB}`).send({ response: 'false' });
    expect(bSubmit.status).toBe(404);
    expect(bSubmit.body.code).toBe('question.attempt_not_found');
    // B start / finish attempt của A → cùng 404.
    const bStartAttempt = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${questionAttemptId}/start`)
      .set('Authorization', `Bearer ${s.tokenB}`);
    expect(bStartAttempt.status).toBe(404);
    expect(bStartAttempt.body.code).toBe('question.attempt_not_found');
    const bFinishAttempt = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${questionAttemptId}/finish`)
      .set('Authorization', `Bearer ${s.tokenB}`);
    expect(bFinishAttempt.status).toBe(404);
    // (b) B finish / start usage của A → 404 usage_not_found, giống hệt usage không tồn tại.
    const bFinish = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${s.tokenB}`);
    expect(bFinish.status).toBe(404);
    expect(bFinish.body.code).toBe('question.usage_not_found');
    const bStart = await http(app).post(`/api/v1/question-usages/${usageId}/start`).set('Authorization', `Bearer ${s.tokenB}`);
    expect(bStart.status).toBe(404);
    expect(bStart.body.code).toBe('question.usage_not_found');
    const ghost = await http(app).post(`/api/v1/question-usages/01900000-0000-7000-8000-0000000000ff/finish`)
      .set('Authorization', `Bearer ${s.tokenB}`);
    expect(ghost.status).toBe(404);
    expect(ghost.body.code).toBe(bFinish.body.code);

    // Lượt của A nguyên vẹn: vẫn inprogress, đáp án 'true' còn nguyên, đáp án đúng chưa lộ.
    const after = await http(app).get(`/api/v1/quiz-attempts/${view.attempt.id}`).set('Authorization', `Bearer ${s.tokenA}`);
    expect(after.status).toBe(200);
    const afterView = after.body as QuizView;
    expect(afterView.attempt.state).toBe('inprogress');
    expect(afterView.questions[0]!.response).toBe('true');
    expect(afterView.questions[0]!.rightAnswer).toBeNull();

    // A nộp bài qua luồng quiz bình thường: chốt điểm và đáp án mới lộ.
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`)
      .set('Authorization', `Bearer ${s.tokenA}`).send({});
    expect(submit.status).toBeLessThan(300);
    const submitted = submit.body as QuizView;
    expect(submitted.attempt.state).toBe('finished');
    expect(submitted.questions[0]!.fraction).toBe(1);
    expect(submitted.questions[0]!.rightAnswer).toBe('True');
  });

  it('owner cannot finish or submit early through the raw routes while the quiz attempt is in progress', async () => {
    const s = await setup();
    const view = await startAndAnswer(s.tokenA, s.quizId);
    const usageId = view.attempt.usageId;
    const questionAttemptId = view.questions[0]!.questionAttemptId;

    // (c) Chính A finish sớm usage của mình qua route thô → 403, không kèm đáp án.
    const aFinish = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${s.tokenA}`);
    expect(aFinish.status).toBe(403);
    expect(aFinish.body.code).toBe('question.usage_managed_by_quiz');
    expect(aFinish.body.attempts).toBeUndefined();
    expect(JSON.stringify(aFinish.body)).not.toContain('rightAnswer');
    // A submit / finish attempt / start usage qua route thô → cùng khoá 403.
    const aSubmit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${questionAttemptId}/submit`)
      .set('Authorization', `Bearer ${s.tokenA}`).send({ response: 'false' });
    expect(aSubmit.status).toBe(403);
    expect(aSubmit.body.code).toBe('question.usage_managed_by_quiz');
    const aFinishAttempt = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${questionAttemptId}/finish`)
      .set('Authorization', `Bearer ${s.tokenA}`);
    expect(aFinishAttempt.status).toBe(403);
    const aStart = await http(app).post(`/api/v1/question-usages/${usageId}/start`).set('Authorization', `Bearer ${s.tokenA}`);
    expect(aStart.status).toBe(403);

    // Lượt vẫn inprogress, đáp án của A không bị ghi đè bởi các lần gọi thô.
    const after = await http(app).get(`/api/v1/quiz-attempts/${view.attempt.id}`).set('Authorization', `Bearer ${s.tokenA}`);
    const afterView = after.body as QuizView;
    expect(afterView.attempt.state).toBe('inprogress');
    expect(afterView.questions[0]!.response).toBe('true');
    expect(afterView.questions[0]!.rightAnswer).toBeNull();

    // Nộp qua quiz thì chốt bình thường và đáp án lộ đúng chính sách.
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`)
      .set('Authorization', `Bearer ${s.tokenA}`).send({});
    const submitted = submit.body as QuizView;
    expect(submitted.attempt.state).toBe('finished');
    expect(submitted.questions[0]!.fraction).toBe(1);
    expect(submitted.questions[0]!.rightAnswer).toBe('True');
  });

  it('free bank usage: the owner runs the full raw flow; strangers get 404 and a mismatched path is not found', async () => {
    const s = await setup();
    // Mẫu dựng sau khi cổng tạo usage của #55 có mặt: tạo usage thô qua
    // HTTP đòi `question:useall` (usage thô là đường đọc đáp án) nên học
    // sinh không tự tạo qua HTTP được nữa; usage tự do của A do hoạt
    // động tạo ở tầng service với actor là chính A — đúng mô hình mà
    // assertCanCreateUsage của #55 ghi. Mọi assertion hành vi của cổng
    // chủ sở hữu bên dưới giữ nguyên.
    const created = await app.get(QuestionsService).createUsage(s.userIdA, {
      component: 'mod_quiz', slots: [{ questionId: s.questionId }],
    });
    const usageId = created.usage.id as string;
    const attemptId = created.attempts[0].id as string;

    // B thao tác usage của A → 404 ở cả hai cấp.
    const bStart = await http(app).post(`/api/v1/question-usages/${usageId}/start`).set('Authorization', `Bearer ${s.tokenB}`);
    expect(bStart.status).toBe(404);
    expect(bStart.body.code).toBe('question.usage_not_found');
    const bSubmit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${s.tokenB}`).send({ response: 'true' });
    expect(bSubmit.status).toBe(404);
    expect(bSubmit.body.code).toBe('question.attempt_not_found');
    const bFinish = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${s.tokenB}`);
    expect(bFinish.status).toBe(404);

    // Đường dẫn lệch (attempt của usage này đặt dưới usage khác của chính A) → 404 attempt_not_found.
    const other = await app.get(QuestionsService).createUsage(s.userIdA, {
      component: 'mod_quiz', slots: [{ questionId: s.questionId }],
    });
    const otherUsageId = other.usage.id as string;
    const mismatched = await http(app).post(`/api/v1/question-usages/${otherUsageId}/attempts/${attemptId}/start`)
      .set('Authorization', `Bearer ${s.tokenA}`);
    expect(mismatched.status).toBe(404);
    expect(mismatched.body.code).toBe('question.attempt_not_found');

    // Chủ sở hữu chạy trọn luồng thô như cũ: start → submit → finish → gradedright kèm đáp án.
    const started = await http(app).post(`/api/v1/question-usages/${usageId}/start`).set('Authorization', `Bearer ${s.tokenA}`);
    expect(started.status).toBeLessThan(300);
    const submitted = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${s.tokenA}`).send({ response: 'true' });
    expect(submitted.status).toBeLessThan(300);
    expect(submitted.body.state).toBe('complete');
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`).set('Authorization', `Bearer ${s.tokenA}`);
    expect(finished.status).toBeLessThan(300);
    expect(finished.body.state).toBe('finished');
    expect(finished.body.attempts[0].state).toBe('gradedright');
    expect(finished.body.attempts[0].fraction).toBe(1);
    expect(finished.body.attempts[0].rightAnswer).toBe('True');
  });
});
