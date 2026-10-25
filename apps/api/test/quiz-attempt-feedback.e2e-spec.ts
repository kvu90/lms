import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * ĐX-3 (issue #181): phản hồi quiz phải TỚI được học sinh ở trang xem lại.
 * API attempt view đã mang feedback theo đáp án + generalFeedback +
 * overallFeedback theo cổng review; lát này bổ sung manualComment (nhận
 * xét chấm tay) vào cùng view theo cổng review_specific_feedback.
 * Spec khoá hai phía của cổng:
 *  - cổng mở (mặc định): HS thấy đủ 4 tầng — feedback của ĐÁP ÁN ĐÃ CHỌN,
 *    lời giải chung, nhận xét chấm tay sau khi GV chấm, nhận xét tổng quát.
 *  - cổng đóng (masks = 0): cả 4 tầng đều null ở phía HS (không lộ qua
 *    API), trong khi GV (privileged) vẫn thấy — dữ liệu có thật, chính
 *    cổng review là thứ che phía học sinh.
 */
describe('Quiz attempt feedback tới học sinh (ĐX-3, #181)', () => {
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

  interface AttemptQuestionBody {
    slot: number;
    questionAttemptId: string;
    questionId: string;
    feedback: unknown;
    generalFeedback: unknown;
    manualComment: string | null;
  }
  interface AttemptViewBody {
    attempt: { id: string; state: string; sumGrades: number | null };
    questions: AttemptQuestionBody[];
    overallFeedback: string | null;
  }

  const MANUAL_COMMENT = 'Bài viết mạch lạc, dẫn chứng tốt.';
  const BAND_TEXT = 'Nhận xét tổng quát: đã hoàn thành bài.';

  async function setup() {
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Feedback bank ${Date.now()}`, contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const mkQuestion = async (body: Record<string, unknown>): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({ categoryId: bankCatId, ...body });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.question.id as string;
    };
    const mcId = await mkQuestion({
      qtype: 'multichoice', name: 'MC feedback', questionText: '2 + 2 = ?', defaultMark: 1,
      generalFeedback: 'Lời giải: cộng hai số tự nhiên, 2 + 2 = 4.',
      answers: [
        { text: '4', fraction: 1, feedback: 'Chính xác, 2 + 2 = 4.' },
        { text: '5', fraction: 0, feedback: 'Chưa đúng, hãy cộng lại.' },
      ],
      options: { single: true },
    });
    const essayId = await mkQuestion({
      qtype: 'essay', name: 'Essay feedback', questionText: 'Viết đoạn văn ngắn.', defaultMark: 2,
    });

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const u = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, u.id);
    const student = (await login(app, u.username, STRONG_PASSWORD)).accessToken;

    const teacherView = await http(app).get(`/api/v1/questions/${mcId}`).set('Authorization', `Bearer ${admin}`);
    const wrongAnswerId = (teacherView.body.answers as { id: string; fraction: number }[]).find((a) => a.fraction === 0)!.id;

    return { courseId: course.id, sectionId, student, mcId, essayId, wrongAnswerId };
  }

  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function mkQuiz(ctx: Ctx, name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const quizRes = await http(app).post(`/api/v1/courses/${ctx.courseId}/quizzes`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.sectionId, name, grade: 3, ...extra });
    if (quizRes.status !== 201 && quizRes.status !== 200) throw new Error(`quiz failed: ${quizRes.status} ${JSON.stringify(quizRes.body)}`);
    const quizId = quizRes.body.id as string;
    await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set('Authorization', `Bearer ${admin}`).send({ questionId: ctx.mcId });
    await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set('Authorization', `Bearer ${admin}`).send({ questionId: ctx.essayId });
    const band = await http(app).post(`/api/v1/quizzes/${quizId}/feedbacks`).set('Authorization', `Bearer ${admin}`)
      .send({ minPercent: 0, maxPercent: 100, feedback: BAND_TEXT });
    if (band.status !== 201 && band.status !== 200) throw new Error(`band failed: ${band.status} ${JSON.stringify(band.body)}`);
    return quizId;
  }

  /** HS làm bài (chọn đáp án SAI của câu MC + viết essay), nộp, GV chấm tay essay kèm nhận xét. */
  async function playAndGrade(ctx: Ctx, quizId: string, comment: string): Promise<string> {
    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const view = start.body as AttemptViewBody;
    const mc = view.questions.find((q) => q.questionId === ctx.mcId)!;
    const essay = view.questions.find((q) => q.questionId === ctx.essayId)!;
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: mc.questionAttemptId, response: ctx.wrongAnswerId });
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: essay.questionAttemptId, response: 'Bài viết của học sinh.' });
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect((submit.body as AttemptViewBody).attempt.state).toBe('needsgrading');
    const graded = await http(app)
      .post(`/api/v1/quiz-attempts/${view.attempt.id}/questions/${essay.questionAttemptId}/grade`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ mark: 2, comment });
    expect(graded.status === 200 || graded.status === 201).toBe(true);
    return view.attempt.id;
  }

  async function getView(attemptId: string, token: string): Promise<AttemptViewBody> {
    const r = await http(app).get(`/api/v1/quiz-attempts/${attemptId}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    return r.body as AttemptViewBody;
  }

  it('cổng mở: HS thấy feedback của đáp án đã chọn + lời giải + nhận xét chấm tay + nhận xét tổng quát', async () => {
    const ctx = await setup();
    const quizId = await mkQuiz(ctx, 'Đề phản hồi mở');
    const attemptId = await playAndGrade(ctx, quizId, MANUAL_COMMENT);

    const view = await getView(attemptId, ctx.student);
    const mc = view.questions.find((q) => q.questionId === ctx.mcId)!;
    const essay = view.questions.find((q) => q.questionId === ctx.essayId)!;
    // Feedback của đáp án SAI đã chọn — không phải feedback của đáp án đúng.
    expect(JSON.stringify(mc.feedback)).toContain('Chưa đúng, hãy cộng lại.');
    expect(JSON.stringify(mc.feedback)).not.toContain('Chính xác');
    expect(JSON.stringify(mc.generalFeedback)).toContain('Lời giải: cộng hai số tự nhiên');
    expect(essay.manualComment).toBe(MANUAL_COMMENT);
    // 0 (MC sai) + 2 (essay) trên tổng 3 → 66,7% rơi vào dải 0–100.
    expect(view.overallFeedback).toBe(BAND_TEXT);
  });

  it('cổng đóng (masks = 0): cả 4 tầng đều null phía HS dù GV đã chấm kèm nhận xét; GV vẫn thấy đủ', async () => {
    const ctx = await setup();
    const quizId = await mkQuiz(ctx, 'Đề phản hồi đóng', {
      reviewSpecificFeedback: 0,
      reviewGeneralFeedback: 0,
      reviewOverallFeedback: 0,
    });
    const attemptId = await playAndGrade(ctx, quizId, MANUAL_COMMENT);

    const studentView = await getView(attemptId, ctx.student);
    const mcS = studentView.questions.find((q) => q.questionId === ctx.mcId)!;
    const essayS = studentView.questions.find((q) => q.questionId === ctx.essayId)!;
    expect(mcS.feedback).toBeNull();
    expect(mcS.generalFeedback).toBeNull();
    expect(essayS.manualComment).toBeNull();
    expect(studentView.overallFeedback).toBeNull();

    // Dữ liệu có thật — GV (privileged) xem cùng attempt vẫn thấy đủ,
    // chứng tỏ chính cổng review che phía học sinh chứ không phải thiếu dữ liệu.
    const teacherView = await getView(attemptId, admin);
    const essayT = teacherView.questions.find((q) => q.questionId === ctx.essayId)!;
    const mcT = teacherView.questions.find((q) => q.questionId === ctx.mcId)!;
    expect(essayT.manualComment).toBe(MANUAL_COMMENT);
    expect(JSON.stringify(mcT.feedback)).toContain('Chưa đúng, hãy cộng lại.');
  });
});
