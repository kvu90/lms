import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from './exam-pin-helpers';

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
 * Bổ sung — chốt đáp án shortanswer: trường `answers` của câu
 * shortanswer chính là tập đáp án được chấp nhận (chấm khớp chính
 * xác), nên nó phải qua cùng cổng reviewRightAnswer như `solution`.
 * Các ca shortanswer ở cuối spec khoá ba phía: đang làm và sau nộp
 * khi cổng đóng thì `answers` rỗng và toàn bộ payload không chứa
 * nguyên văn đáp án được chấp nhận; cổng mở thì `solution` hiện như
 * cũ; phía GV (privileged) không bị che.
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
    qtype: string;
    answers: { id: string; text: unknown }[];
    feedback: unknown;
    generalFeedback: unknown;
    manualComment: string | null;
    guidance: unknown;
    solution: { correctAnswerId?: string; answer?: unknown; acceptedAnswers?: string[] } | null;
  }
  interface AttemptViewBody {
    attempt: { id: string; state: string; sumGrades: number | null };
    questions: AttemptQuestionBody[];
    overallFeedback: string | null;
  }

  const MANUAL_COMMENT = 'Bài viết mạch lạc, dẫn chứng tốt.';
  const BAND_TEXT = 'Nhận xét tổng quát: đã hoàn thành bài.';
  // Câu shortanswer của fixture: API chuẩn hoá MỌI đáp án liệt kê của
  // shortanswer đều là đáp án được chấp nhận (các biến thể chính tả
  // của cùng một đáp án, không có dòng mồi như trắc nghiệm) — cả hai
  // chuỗi đều không được xuất hiện trong bất kỳ đáp ứng nào phía học
  // viên khi cổng đáp án đúng đang đóng.
  const SA_ACCEPTED = 'Hà Nội';
  const SA_VARIANT = 'hà nội';

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
      qtype: 'multichoice', questionText: '2 + 2 = ?', defaultMark: 1,
      guidance: 'Gợi ý: tách thành hai lần cộng 2.',
      generalFeedback: 'Lời giải: cộng hai số tự nhiên, 2 + 2 = 4.',
      answers: [
        { text: '4', correct: true, feedback: 'Chính xác, 2 + 2 = 4.' },
        { text: '5', correct: false, feedback: 'Chưa đúng, hãy cộng lại.' },
        { text: '6', correct: false },
        { text: '3', correct: false },
      ],
    });
    const essayId = await mkQuestion({
      qtype: 'essay', questionText: 'Viết đoạn văn ngắn.', defaultMark: 2,
      guidance: 'Gợi ý: viết 3–4 câu, có câu mở đoạn.',
      solution: { answer: 'Bài mẫu: đoạn văn mẫu đạt yêu cầu.' },
    });
    const saId = await mkQuestion({
      qtype: 'shortanswer', questionText: 'Thủ đô của Việt Nam là gì?', defaultMark: 1,
      answers: [
        { text: SA_ACCEPTED, correct: true },
        { text: SA_VARIANT, correct: true },
      ],
    });

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const u = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, u.id);
    const student = (await login(app, u.username, STRONG_PASSWORD)).accessToken;

    const teacherView = await http(app).get(`/api/v1/questions/${mcId}`).set('Authorization', `Bearer ${admin}`);
    const wrongAnswerId = (teacherView.body.answers as { id: string; isCorrect: boolean }[]).find((a) => !a.isCorrect)!.id;

    return { courseId: course.id, sectionId, student, mcId, essayId, saId, wrongAnswerId };
  }

  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function mkQuiz(ctx: Ctx, name: string, extra: Record<string, unknown> = {}): Promise<string> {
    // Hành trình gộp Đề (#226): soạn đề → ready → ghim (extra là cấu hình tổ chức của pin).
    const draft = await createExamDraft(app, admin, name, 3);
    await addExamSlot(app, admin, draft, { questionId: ctx.mcId });
    await addExamSlot(app, admin, draft, { questionId: ctx.essayId });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId, ...extra });
    const quizId = pin.id as string;
    const band = await http(app).post(`/api/v1/exam-pins/${quizId}/feedbacks`).set('Authorization', `Bearer ${admin}`)
      .send({ minPercent: 0, maxPercent: 100, feedback: BAND_TEXT });
    if (band.status !== 201 && band.status !== 200) throw new Error(`band failed: ${band.status} ${JSON.stringify(band.body)}`);
    return quizId;
  }

  /** Đề chỉ gồm câu shortanswer (tổng 1 điểm) cho các ca gác trường `answers`. */
  async function mkQuizSa(ctx: Ctx, name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const draft = await createExamDraft(app, admin, name, 1);
    await addExamSlot(app, admin, draft, { questionId: ctx.saId });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId, ...extra });
    return pin.id as string;
  }

  /** HS làm bài (chọn đáp án SAI của câu MC + viết essay), nộp, GV chấm tay essay kèm nhận xét. */
  async function playAndGrade(ctx: Ctx, quizId: string, comment: string): Promise<string> {
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
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

  it('guidance hiện kèm câu hỏi NGAY trong lúc làm (D-4); solution chỉ lộ theo cổng reviewRightAnswer', async () => {
    const ctx = await setup();
    // Mask 4368 = đủ các cửa sổ sau nộp (ngay sau nộp + trong lúc mở +
    // sau đóng) như preset 'regular' — mặc định DB của reviewRightAnswer
    // (272) không gồm cửa sổ "ngay sau nộp" nên phải mở tường minh.
    const quizId = await mkQuiz(ctx, 'Đề hướng dẫn + lời giải', { reviewRightAnswer: 4368 });

    // Đang làm bài: học sinh thấy guidance của cả hai câu; solution
    // (đáp án đúng/lời giải mẫu) chưa lộ ở bất kỳ dạng nào.
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const inProgress = start.body as AttemptViewBody;
    const mcDoing = inProgress.questions.find((q) => q.questionId === ctx.mcId)!;
    const essayDoing = inProgress.questions.find((q) => q.questionId === ctx.essayId)!;
    expect(JSON.stringify(mcDoing.guidance)).toContain('Gợi ý: tách thành hai lần cộng 2.');
    expect(JSON.stringify(essayDoing.guidance)).toContain('Gợi ý: viết 3–4 câu');
    expect(mcDoing.solution).toBeNull();
    expect(essayDoing.solution).toBeNull();

    // Sau khi nộp + chấm (cổng reviewRightAnswer mặc định mở): solution
    // của MC trỏ đúng dòng đáp án đúng; của essay là lời giải mẫu.
    const attemptId = (inProgress.attempt as { id: string }).id;
    const mc = inProgress.questions.find((q) => q.questionId === ctx.mcId)!;
    await http(app).post(`/api/v1/quiz-attempts/${attemptId}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: mc.questionAttemptId, response: ctx.wrongAnswerId });
    const essay = inProgress.questions.find((q) => q.questionId === ctx.essayId)!;
    await http(app).post(`/api/v1/quiz-attempts/${attemptId}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: essay.questionAttemptId, response: 'Bài viết của học sinh.' });
    await http(app).post(`/api/v1/quiz-attempts/${attemptId}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});
    const teacherQ = await http(app).get(`/api/v1/questions/${ctx.mcId}`).set('Authorization', `Bearer ${admin}`);
    const correctAnswerId = (teacherQ.body.answers as { id: string; isCorrect: boolean }[]).find((a) => a.isCorrect)!.id;
    const reviewed = await getView(attemptId, ctx.student);
    const mcDone = reviewed.questions.find((q) => q.questionId === ctx.mcId)!;
    const essayDone = reviewed.questions.find((q) => q.questionId === ctx.essayId)!;
    expect(mcDone.solution).toEqual({ correctAnswerId });
    expect(JSON.stringify(essayDone.solution?.answer)).toContain('Bài mẫu: đoạn văn mẫu đạt yêu cầu.');
    // Guidance vẫn hiện ở màn xem lại như trong lúc làm.
    expect(JSON.stringify(mcDone.guidance)).toContain('Gợi ý: tách thành hai lần cộng 2.');
  });

  it('cổng reviewRightAnswer đóng: solution null ở cả MC và essay sau nộp, nhưng guidance vẫn hiện (guidance không qua cổng xem lại)', async () => {
    const ctx = await setup();
    const quizId = await mkQuiz(ctx, 'Đề đóng cổng đáp án đúng', { reviewRightAnswer: 0 });
    const attemptId = await playAndGrade(ctx, quizId, MANUAL_COMMENT);
    const view = await getView(attemptId, ctx.student);
    const mc = view.questions.find((q) => q.questionId === ctx.mcId)!;
    const essay = view.questions.find((q) => q.questionId === ctx.essayId)!;
    expect(mc.solution).toBeNull();
    expect(essay.solution).toBeNull();
    expect(JSON.stringify(mc.guidance)).toContain('Gợi ý: tách thành hai lần cộng 2.');
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

  it('đang làm: answers của shortanswer rỗng phía HS — đáp án được chấp nhận không có ở bất kỳ trường nào; GV vẫn thấy đủ', async () => {
    const ctx = await setup();
    const quizId = await mkQuizSa(ctx, 'Đề shortanswer đang làm');
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const view = start.body as AttemptViewBody;
    const sa = view.questions.find((q) => q.questionId === ctx.saId)!;
    expect(sa.qtype).toBe('shortanswer');
    expect(sa.answers).toEqual([]);
    expect(sa.solution).toBeNull();
    // Toàn bộ payload không chứa nguyên văn bất kỳ đáp án được chấp nhận nào.
    expect(JSON.stringify(view)).not.toContain(SA_ACCEPTED);
    expect(JSON.stringify(view)).not.toContain(SA_VARIANT);

    // Lưu một câu trả lời đoán sai rồi tải lại view: bề mặt lưu từng
    // câu cũng trả lại toàn bộ view qua cùng một hàm dựng — vẫn sạch.
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: sa.questionAttemptId, response: 'Đà Nẵng' });
    const reloaded = await getView(view.attempt.id, ctx.student);
    const saReloaded = reloaded.questions.find((q) => q.questionId === ctx.saId)!;
    expect(saReloaded.answers).toEqual([]);
    expect(JSON.stringify(reloaded)).not.toContain(SA_ACCEPTED);
    expect(JSON.stringify(reloaded)).not.toContain(SA_VARIANT);

    // GV (privileged) xem cùng lượt đang làm: answers vẫn đầy đủ —
    // chốt chỉ che phía chủ lượt không đặc quyền.
    const teacherView = await getView(view.attempt.id, admin);
    const saTeacher = teacherView.questions.find((q) => q.questionId === ctx.saId)!;
    expect(JSON.stringify(saTeacher.answers)).toContain(SA_ACCEPTED);
  });

  it('sau nộp với cổng đáp án đúng đóng: shortanswer vẫn không lộ đáp án được chấp nhận', async () => {
    const ctx = await setup();
    const quizId = await mkQuizSa(ctx, 'Đề shortanswer đóng cổng đáp án', { reviewRightAnswer: 0 });
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const doing = start.body as AttemptViewBody;
    const saDoing = doing.questions.find((q) => q.questionId === ctx.saId)!;
    await http(app).post(`/api/v1/quiz-attempts/${doing.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: saDoing.questionAttemptId, response: 'Đà Nẵng' });
    await http(app).post(`/api/v1/quiz-attempts/${doing.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});

    const view = await getView(doing.attempt.id, ctx.student);
    const sa = view.questions.find((q) => q.questionId === ctx.saId)!;
    // Cửa sổ xem lại mở (thấy nội dung câu) nhưng cổng đáp án đúng
    // đóng: solution null VÀ answers rỗng — không còn đường vòng.
    expect(sa.solution).toBeNull();
    expect(sa.answers).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(SA_ACCEPTED);
    expect(JSON.stringify(view)).not.toContain(SA_VARIANT);
  });

  it('sau nộp với cổng đáp án đúng mở: solution hiện đáp án được chấp nhận như cũ (không mất tính năng xem lại)', async () => {
    const ctx = await setup();
    // Mask 4368 = cổng mở ở mọi cửa sổ sau nộp (như ca guidance ở trên).
    const quizId = await mkQuizSa(ctx, 'Đề shortanswer mở cổng đáp án', { reviewRightAnswer: 4368 });
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const doing = start.body as AttemptViewBody;
    const saDoing = doing.questions.find((q) => q.questionId === ctx.saId)!;
    await http(app).post(`/api/v1/quiz-attempts/${doing.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: saDoing.questionAttemptId, response: 'Đà Nẵng' });
    await http(app).post(`/api/v1/quiz-attempts/${doing.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});

    const view = await getView(doing.attempt.id, ctx.student);
    const sa = view.questions.find((q) => q.questionId === ctx.saId)!;
    // Tính năng xem lại giữ nguyên: đáp án được chấp nhận hiện qua
    // solution đã qua cổng. Tại cửa sổ này khía cạnh đáp án đúng đã
    // được phép hiện nên chốt không áp dụng — answers (nếu còn) cũng
    // chỉ chứa đúng tập đáp án đã công bố qua solution, không lộ thêm
    // gì; phần phải khoá là hai ca cổng đóng ở trên.
    expect(sa.solution).toEqual({ acceptedAnswers: [SA_ACCEPTED, SA_VARIANT] });
  });
});
