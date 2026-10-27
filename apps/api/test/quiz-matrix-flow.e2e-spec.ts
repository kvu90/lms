import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from './exam-pin-helpers';

/**
 * Quiz Chặng 3 (issue #30) — ma trận đề + sinh slots + chấm Đ–S chùm +
 * bản đặc tả, đối chiếu hồ sơ thiết kế mục C:
 *  - ma trận neo Chương trình GDPT 2018 (môn → chương trình → ĐVK);
 *    ô = ĐVK × mức × dạng (issue #249 — ma trận KHÔNG gắn YCCĐ, YCCĐ
 *    chỉ hiện ở cột suy ra của bản đặc tả), preset chụp lúc tạo, lệch
 *    tỉ lệ chỉ cảnh báo;
 *  - generate khoá cứng 422 khi thiếu câu ở bất kỳ ô nào; generate
 *    rút MỘT bộ câu cố định ghim cứng vào slots của exam version
 *    (bỏ hẳn drawMode/per_student theo chốt #226) — hai học sinh làm
 *    cùng một pin nhận cùng một bộ câu;
 *  - chùm Đ–S (1 stimulus + 4 câu truefalse) chấm theo thang lũy tiến
 *    QĐ 764 mặc định [0,10,25,50,100]% — KHÔNG cộng tuyến tính;
 *  - bản đặc tả theo Mẫu 2 CV 7991 + xuất xlsx/docx.
 */
describe('Quiz matrix generation + TF-A grading + specification (stage 3)', () => {
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

  interface SlotBody { id: string; slot: number; questionId: string | null; categoryId: string | null; matrixCellId: string | null; maxMark: number }
  interface QuizBody { id: string; matrixId: string | null; tfScale: number[] | null; slots: SlotBody[]; sumGrades: number }
  interface AttemptViewBody {
    attempt: { id: string; state: string; sumGrades: number | null };
    questions: { slot: number; questionAttemptId: string; questionId: string }[];
  }

  interface Ctx {
    courseId: string;
    sectionId: string;
    subjectId: string;
    curriculumId: string;
    outcomeBiet: string;
    outcomeHieu: string;
    lessonId: string;
    bankCatId: string;
    student: string;
    studentId: string;
    student2: string;
    mcPool: string[];
    mcCross: string;
    mcPoolHieu: string[];
    tfQuestion: string;
    tfCorrects: boolean[];
    mkQuestion: (body: Record<string, unknown>) => Promise<string>;
  }

  async function setup(): Promise<Ctx> {
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;

    // Chương trình: môn → chương trình lớp 10 → chủ đề → đơn vị kiến thức → 2 YCCĐ.
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set('Authorization', `Bearer ${admin}`)
      .send({ contextId: systemCtx.id, name: 'Toán học', slug: `toan-${Date.now()}` });
    if (subjRes.status !== 201 && subjRes.status !== 200) throw new Error(`subject failed: ${subjRes.status} ${JSON.stringify(subjRes.body)}`);
    const subjectId = subjRes.body.id as string;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set('Authorization', `Bearer ${admin}`)
      .send({ subjectId, grade: 10 });
    const curriculumId = currRes.body.id as string;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, title: 'Hàm số', kind: 'topic' });
    const topicId = topicRes.body.id as string;
    const lessonRes = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, parentId: topicId, title: 'Hàm số bậc hai', kind: 'lesson' });
    const lessonId = lessonRes.body.id as string;
    const mkOutcome = async (content: string) => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set('Authorization', `Bearer ${admin}`)
        .send({ nodeId: lessonId, content });
      if (r.status !== 201 && r.status !== 200) throw new Error(`outcome failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id as string;
    };
    const outcomeBiet = await mkOutcome('Nhận biết được tính đồng biến, nghịch biến của hàm số bậc hai.');
    const outcomeHieu = await mkOutcome('Giải thích được mối liên hệ giữa đồ thị và dấu của hệ số a.');
    // ĐVK khác cùng chủ đề (issue #249): câu của ĐVK này KHÔNG được
    // tính vào pool của ô neo ĐVK "Hàm số bậc hai".
    const lesson2Res = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, parentId: topicId, title: 'Hàm số bậc nhất', kind: 'lesson' });
    const lesson2Id = lesson2Res.body.id as string;
    const outcomeOtherRes = await http(app).post('/api/v1/curriculum/outcomes').set('Authorization', `Bearer ${admin}`)
      .send({ nodeId: lesson2Id, content: 'Nhận biết được hàm số bậc nhất.' });
    const outcomeOther = outcomeOtherRes.body.id as string;

    // Khoá học + học sinh.
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const mkStudent = async () => {
      const u = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, u.id);
      return { id: u.id, token: (await login(app, u.username, STRONG_PASSWORD)).accessToken };
    };
    const s1 = await mkStudent();
    const s2 = await mkStudent();

    // Ngân hàng: category ở context hệ thống; câu gắn YCCĐ qua endpoint outcomes.
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Matrix bank', contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const mkQuestion = async (body: Record<string, unknown>): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({ categoryId: bankCatId, ...body });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.question.id as string;
    };
    const tag = async (questionId: string, outcomeId: string, level: string) => {
      const r = await http(app).post(`/api/v1/questions/${questionId}/outcomes`).set('Authorization', `Bearer ${admin}`)
        .send({ outcomeId, cognitiveLevel: level });
      if (r.status !== 201 && r.status !== 200) throw new Error(`tag failed: ${r.status} ${JSON.stringify(r.body)}`);
    };
    const mcPool: string[] = [];
    for (const name of ['MC1', 'MC2', 'MC3']) {
      const q = await mkQuestion({
        qtype: 'multichoice', questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
      });
      await tag(q, outcomeBiet, 'biet');
      mcPool.push(q);
    }
    const mcPoolHieu: string[] = [];
    for (const name of ['MCH1', 'MCH2']) {
      const q = await mkQuestion({
        qtype: 'multichoice', questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
      });
      await tag(q, outcomeHieu, 'hieu');
      mcPoolHieu.push(q);
    }
    // Câu gắn YCCĐ "Hiểu" của CÙNG ĐVK ở mức Biết (issue #249): ô neo
    // ĐVK phải tính câu này vào pool Biết — mô hình cũ neo từng YCCĐ
    // sẽ bỏ sót.
    const mcCross = await mkQuestion({
      qtype: 'multichoice', questionText: 'MCX: chọn đáp án đúng.', defaultMark: 1,
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    await tag(mcCross, outcomeHieu, 'biet');
    // Câu của ĐVK khác ở cùng mức Biết: không thuộc pool của ô.
    for (const name of ['MCO1', 'MCO2']) {
      const q = await mkQuestion({
        qtype: 'multichoice', questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
      });
      await tag(q, outcomeOther, 'biet');
    }
    // Câu Đ–S TF-A: MỘT câu gồm thân chung + 4 mệnh đề (đáp án
    // [Đ, S, Đ, S]) gắn cùng stimulus và outcome/mức Hiểu — chùm là
    // chính câu hỏi, không còn 4 câu rời gom ở tầng ghim/sinh đề.
    const stimRes = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: bankCatId, content: 'Cho hàm số y = x² − 2x + 1. Xét tính đúng sai của các mệnh đề sau.' });
    if (stimRes.status !== 201 && stimRes.status !== 200) throw new Error(`stimulus failed: ${stimRes.status} ${JSON.stringify(stimRes.body)}`);
    const stimulusId = stimRes.body.id as string;
    const tfCorrects = [true, false, true, false];
    const tfQuestion = await mkQuestion({
      qtype: 'truefalse', defaultMark: 1, stimulusId,
      questionText: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Cho hàm số y = x² − 2x + 1. Xét tính đúng sai của các mệnh đề sau.' }] },
          {
            type: 'statementList',
            content: tfCorrects.map((v, i) => ({
              type: 'statement',
              attrs: { id: `s${i + 1}` },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề ${i + 1}` }] }],
            })),
          },
        ],
      },
      solution: { answers: tfCorrects.map((v, i) => ({ statementId: `s${i + 1}`, value: v })) },
    });
    await tag(tfQuestion, outcomeHieu, 'hieu');
    return {
      courseId: course.id, sectionId, subjectId, curriculumId, outcomeBiet, outcomeHieu, lessonId,
      bankCatId, student: s1.token, studentId: s1.id, student2: s2.token, mcPool, mcCross, mcPoolHieu, tfQuestion, tfCorrects,
      mkQuestion,
    };
  }

  async function createMatrix(ctx: Ctx, body: Record<string, unknown> = {}) {
    // presetKind đã bỏ hẳn (chốt #226): ma trận luôn theo khuôn CV
    // 7991 — thân cũ còn truyền presetKind thì lược bỏ tại đây.
    const { presetKind: _presetKind, ...rest } = body;
    const r = await http(app).post('/api/v1/exam-matrices').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ma trận giữa kỳ', subjectId: ctx.subjectId, curriculumId: ctx.curriculumId, ...rest });
    if (r.status !== 201 && r.status !== 200) throw new Error(`matrix failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
  async function addCell(matrixId: string, body: Record<string, unknown>) {
    return http(app).post(`/api/v1/exam-matrices/${matrixId}/cells`).set('Authorization', `Bearer ${admin}`).send(body);
  }
  async function answerAttempt(token: string, attemptId: string, view: AttemptViewBody, questionId: string, response: string) {
    const q = view.questions.find((x) => x.questionId === questionId)!;
    const r = await http(app).post(`/api/v1/quiz-attempts/${attemptId}/responses`).set('Authorization', `Bearer ${token}`)
      .send({ questionAttemptId: q.questionAttemptId, response });
    if (r.status !== 200 && r.status !== 201) throw new Error(`answer failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as AttemptViewBody;
  }
  async function playTfQuiz(token: string, quizId: string, correctCount: number, tfId: string, corrects: boolean[]): Promise<AttemptViewBody> {
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send({});
    if (start.status !== 201 && start.status !== 200) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
    let view = start.body as AttemptViewBody;
    // Đáp án đúng của 4 mệnh đề là `corrects` — trả đúng correctCount
    // ý đầu, các ý còn lại trả ngược phía; response là JSON theo ý.
    const map: Record<string, boolean> = {};
    for (let i = 0; i < 4; i++) {
      map[`s${i + 1}`] = i < correctCount ? corrects[i]! : !corrects[i]!;
    }
    view = await answerAttempt(token, view.attempt.id, view, tfId, JSON.stringify(map));
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${token}`).send({});
    if (submit.status !== 200 && submit.status !== 201) throw new Error(`submit failed: ${submit.status} ${JSON.stringify(submit.body)}`);
    return submit.body as AttemptViewBody;
  }

  it('matrix CRUD: preset targets are snapshotted; ratio mismatch only warns; cell guards hold', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'cv7991_periodic' });
    expect(matrix.targetFormPercents).toEqual({ multichoice: 30, truefalse: 20, shortanswer: 20, essay: 30 });
    expect(matrix.targetLevelPercents).toEqual({ biet: 40, hieu: 30, van_dung: 30 });
    expect(matrix.warnings.length).toBeGreaterThan(0); // chưa có ô nào

    const cell = await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 4, minutes: 10,
    });
    expect(cell.status === 200 || cell.status === 201).toBe(true);
    // Ô mang ĐVK, TUYỆT ĐỐI không còn trường YCCĐ (issue #249).
    const createdCell = (cell.body.cells as Record<string, unknown>[])[0]!;
    expect(createdCell.curriculumNodeId).toBe(ctx.lessonId);
    expect(createdCell.learningOutcomeId).toBeUndefined();
    // Trùng khoá ô bị từ chối.
    const dup = await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 1, cellScore: 1,
    });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('quiz.matrix_cell_exists');
    // van_dung_cao ngoài bộ ba mức bị từ chối.
    const vdc = await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'van_dung_cao', qtype: 'essay',
      questionCount: 1, cellScore: 1,
    });
    expect(vdc.status).toBe(400);
    expect(vdc.body.code).toBe('quiz.matrix_level_not_in_set');
    // Tổng ô (4) khác tổng đích (10) → cảnh báo, không khoá.
    const view = await http(app).get(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`);
    expect(view.body.warnings.some((w: string) => w.includes('Tổng điểm các ô'))).toBe(true);
  });

  it('availability counts candidates per cell BY KNOWLEDGE UNIT (issue #249); generate hard-fails 422 when a cell is short', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 6 });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 5, cellScore: 4,
    });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 2,
    });
    const avail = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/availability`).set('Authorization', `Bearer ${admin}`);
    expect(avail.body.sufficient).toBe(false);
    const mcCell = (avail.body.cells as { required: number; available: number; deficit: number }[])
      .find((c) => c.required === 5)!;
    // Pool của ô = câu gắn BẤT KỲ YCCĐ nào thuộc ĐVK ở mức Biết:
    // 3 câu gắn YCCĐ Biết + 1 câu gắn YCCĐ Hiểu ở mức Biết = 4. Hai
    // câu của ĐVK khác (cùng mức Biết) KHÔNG được tính — mô hình cũ
    // neo từng YCCĐ chỉ đếm được 3, mô hình rò ĐVK sẽ đếm 6.
    expect(mcCell.available).toBe(4);
    expect(mcCell.deficit).toBe(1);
    const tfCell = (avail.body.cells as { required: number; available: number }[]).find((c) => c.required === 1)!;
    expect(tfCell.available).toBe(1); // đúng 1 CÂU TF-A (mỗi câu là một chùm 4 ý)

    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề thiếu câu' });
    expect(gen.status).toBe(422);
    expect(gen.body.code).toBe('quiz.matrix_insufficient_questions');
    // Chi tiết từng ô thiếu đi kèm trên wire (trường errors của problem details).
    const detailText = JSON.stringify(gen.body.errors ?? []);
    expect(detailText).toContain('required 5, available 4, deficit 1');
  });

  it('generate fixed: slots follow cells, TF cell counts TF-A QUESTIONS (one slot per question, full cell marks)', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 6 });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 2, minutes: 5,
    });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4, minutes: 10,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề giữa kỳ' });
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz = gen.body as QuizBody;
    expect(quiz.matrixId).toBe(matrix.id);
    expect(quiz.slots).toHaveLength(3);
    expect(quiz.sumGrades).toBeCloseTo(6, 6);
    const mcSlots = quiz.slots.filter((s) => s.matrixCellId && s.questionId && s.questionId !== ctx.tfQuestion);
    expect(mcSlots).toHaveLength(2);
    expect(new Set(mcSlots.map((s) => s.questionId)).size).toBe(2);
    // Pool của ô Biết = mọi câu multichoice mức Biết thuộc ĐVK (gồm cả
    // câu gắn YCCĐ khác của cùng ĐVK — ctx.mcCross).
    for (const s of mcSlots) expect([...ctx.mcPool, ctx.mcCross]).toContain(s.questionId);
    // Ô TF questionCount=1 → ĐÚNG MỘT slot mang cả câu TF-A với
    // trọn điểm của ô (không còn bẻ chùm thành 4 slot danh nghĩa).
    const tfSlots = quiz.slots.filter((s) => s.questionId === ctx.tfQuestion);
    expect(tfSlots).toHaveLength(1);
    expect(tfSlots[0]!.maxMark).toBeCloseTo(4, 6);
  });

  it('TF-A grading follows the QD764 progressive scale, not linear addition', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 4 });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề chùm' });
    const quiz = gen.body as QuizBody;
    // 2/4 ý đúng → thang QĐ 764 cho 25% × 4 = 1 điểm (tuyến tính sẽ là 2).
    const two = await playTfQuiz(ctx.student, quiz.id, 2, ctx.tfQuestion, ctx.tfCorrects);
    expect(two.attempt.state).toBe('finished');
    expect(two.attempt.sumGrades).toBeCloseTo(1, 6);
    // 3/4 ý đúng → 50% × 4 = 2 điểm (tuyến tính sẽ là 3).
    const three = await playTfQuiz(ctx.student2, quiz.id, 3, ctx.tfQuestion, ctx.tfCorrects);
    expect(three.attempt.sumGrades).toBeCloseTo(2, 6);
    // Điểm bài đã ghi: thang grade của quiz = 4 nên điểm = sumGrades.
    const info = await http(app).get(`/api/v1/exam-pins/${quiz.id}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(info.body.myGrade).toBeCloseTo(1, 6);
  });

  it('generate draws ONE fixed set for the whole pin: slots carry pinned questions + source cells; two students receive the same set; exam swap makes a new version; the pin version freezes after a real attempt', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 4 });
    const cellARes = await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 2,
    });
    const cellA = (cellARes.body.cells as { id: string; qtype: string }[]).find((c) => c.qtype === 'multichoice')!.id;
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'multichoice',
      questionCount: 1, cellScore: 1,
    });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 1,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề cố định' });
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz = gen.body as QuizBody & { examId: string };
    // Mọi slot đều đã ghim câu cụ thể ngay từ lúc sinh đề (không còn
    // slot chỉ mang ô chờ rút lúc attempt).
    expect(quiz.slots).toHaveLength(4);
    expect(quiz.slots.every((x) => x.questionId !== null)).toBe(true);
    const mcFromA = quiz.slots.filter((x) => x.matrixCellId === cellA);
    expect(mcFromA).toHaveLength(2);
    const bietPool = [...ctx.mcPool, ctx.mcCross];
    for (const x of mcFromA) expect(bietPool).toContain(x.questionId);

    // Swap-cùng-ô trên ĐỀ: thay câu của slot đầu ô A bằng câu còn lại
    // của pool ô A → version đề mới; pin vẫn chỉ version cũ cho tới
    // khi được nâng.
    const slotA = mcFromA[0]!;
    const spare = bietPool.find((q) => !mcFromA.some((x) => x.questionId === q))!;
    const swap = await http(app).post(`/api/v1/exams/${quiz.examId}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ position: slotA.slot, questionId: spare });
    expect(swap.status === 200 || swap.status === 201).toBe(true);

    // Hai học sinh làm cùng pin nhận CÙNG một bộ câu (bộ đã ghim của
    // version pin đang giữ — chưa gồm câu vừa swap ở version mới).
    const start1 = await http(app).post(`/api/v1/exam-pins/${quiz.id}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start1.status === 200 || start1.status === 201).toBe(true);
    const view1 = start1.body as AttemptViewBody;
    expect(view1.questions).toHaveLength(4);
    const start2 = await http(app).post(`/api/v1/exam-pins/${quiz.id}/attempts`).set('Authorization', `Bearer ${ctx.student2}`).send({});
    expect(start2.status === 200 || start2.status === 201).toBe(true);
    const view2 = start2.body as AttemptViewBody;
    expect(view2.questions.map((q) => q.questionId).sort()).toEqual(view1.questions.map((q) => q.questionId).sort());
    expect(view1.questions.map((q) => q.questionId)).not.toContain(spare);

    // Đã có lượt thật → nâng pin lên version mới bị khoá.
    const newVersionId = (swap.body.version as { id: string }).id;
    const frozen = await http(app).patch(`/api/v1/exam-pins/${quiz.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ examVersionId: newVersionId });
    expect(frozen.status).toBe(400);
    expect(frozen.body.code).toBe('exam.pin_locked');
  });

  it('specification follows the matrix and the generated quiz; exports produce real files', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'cv7991_periodic', totalScore: 6 });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 2,
    });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề đặc tả' });
    const quiz = gen.body as QuizBody;

    const spec = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification`).set('Authorization', `Bearer ${admin}`);
    expect(spec.status).toBe(200);
    expect(spec.body.subject.name).toBe('Toán học');
    expect(spec.body.topics[0].topicTitle).toBe('Hàm số');
    const outcomeTexts = JSON.stringify(spec.body.topics);
    expect(outcomeTexts).toContain('Nhận biết được tính đồng biến');
    // Cột YCCĐ của bản đặc tả = MỌI YCCĐ thuộc ĐVK của ô (issue #249):
    // cả hai YCCĐ của bài "Hàm số bậc hai" đều hiện, dù mỗi ô trước
    // đây chỉ neo đúng một YCCĐ; ô nằm ở cấp ĐVK, không nằm dưới YCCĐ.
    const specNode = spec.body.topics[0].nodes[0] as {
      outcomes: { content: string }[];
      cells: { cellId: string }[];
    };
    expect(specNode.outcomes.map((o) => o.content)).toEqual(expect.arrayContaining([
      'Nhận biết được tính đồng biến, nghịch biến của hàm số bậc hai.',
      'Giải thích được mối liên hệ giữa đồ thị và dấu của hệ số a.',
    ]));
    expect(specNode.cells).toHaveLength(2);
    expect(spec.body.totals.totalScore).toBeCloseTo(6, 6);
    expect(spec.body.totals.totalQuestions).toBe(3); // 2 MC + 1 câu TF-A (ô TF đếm theo CÂU)
    expect(spec.body.quiz).toBeNull();

    const specWithQuiz = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification?pinId=${quiz.id}`).set('Authorization', `Bearer ${admin}`);
    expect(specWithQuiz.status).toBe(200);
    expect(JSON.stringify(specWithQuiz.body)).toContain('slotNumbers":[1,2]');
    // pinId của lần ghim không thuộc ma trận → 400.
    const otherDraft = await createExamDraft(app, admin, 'Đề lạ');
    await addExamSlot(app, admin, otherDraft, { questionId: ctx.mcPool[0]! });
    const other = await pinExam(app, admin, ctx.courseId, otherDraft, { sectionId: ctx.sectionId });
    const mismatch = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification?pinId=${other.id}`).set('Authorization', `Bearer ${admin}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('quiz.spec_quiz_mismatch');

    const xlsx = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification/export?format=xlsx&pinId=${quiz.id}`)
      .set('Authorization', `Bearer ${admin}`).responseType('arraybuffer');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(Buffer.from(xlsx.body as ArrayBuffer).subarray(0, 2).toString()).toBe('PK');
    const docx = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification/export?format=docx`)
      .set('Authorization', `Bearer ${admin}`).responseType('arraybuffer');
    expect(docx.status).toBe(200);
    expect(Buffer.from(docx.body as ArrayBuffer).subarray(0, 2).toString()).toBe('PK');
    const pdf = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification/export?format=pdf`).set('Authorization', `Bearer ${admin}`);
    expect(pdf.status).toBe(400);
    expect(pdf.body.code).toBe('quiz.spec_export_format');
  });

  it('hand-made TF-A slot: a single TF-A slot in a hand-built exam grades by the tf scale on its own', async () => {
    const ctx = await setup();
    // Không còn cơ chế gom chùm ở tầng ghim: đề tay chỉ gồm MỘT slot
    // TF-A; thang áp ngay trên chính slot đó.
    const draft = await createExamDraft(app, admin, 'Đề tay TF-A', 4);
    await addExamSlot(app, admin, draft, { questionId: ctx.tfQuestion, maxMark: 4 });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId });
    // 1/4 ý đúng → thang mặc định QĐ 764: 10% × 4 = 0,4 (tuyến tính = 1).
    const one = await playTfQuiz(ctx.student, pin.id as string, 1, ctx.tfQuestion, ctx.tfCorrects);
    expect(one.attempt.sumGrades).toBeCloseTo(0.4, 6);
  });

  it('matrix bank fields (MB-0): defaults, status lifecycle and version bump on content edit after ready', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 10 });
    expect(matrix.status).toBe('draft');
    expect(matrix.version).toBe(1);
    expect(matrix.isTemplate).toBe(false);
    expect(matrix.bankId).toBeNull();
    expect(matrix.derivedFromMatrixId).toBeNull();
    // Sửa khi còn draft: version giữ nguyên.
    const draftEdit = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ma trận nháp v1' });
    expect(draftEdit.body.version).toBe(1);
    // Chuyển ready rồi sửa nội dung → version tăng.
    const ready = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ status: 'ready' });
    expect(ready.body.status).toBe('ready');
    expect(ready.body.version).toBe(1);
    const edit = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ma trận đã duyệt — sửa tên' });
    expect(edit.body.version).toBe(2);
    // Thêm/sửa/xoá Ô trên ma trận đã ready cũng tăng version: bản đặc
    // tả sinh trực tiếp từ ô, sửa ô lặng lẽ sẽ làm đặc tả đã nộp lệch
    // version mà không ai biết.
    const withCell = await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 1, cellScore: 2,
    });
    expect(withCell.status).toBeLessThan(300);
    expect(withCell.body.version).toBe(3);
    const cellId = (withCell.body.cells as { id: string }[])[0]!.id;
    const cellEdit = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}/cells/${cellId}`).set('Authorization', `Bearer ${admin}`)
      .send({ questionCount: 2 });
    expect(cellEdit.body.version).toBe(4);
    const cellDel = await http(app).delete(`/api/v1/exam-matrices/${matrix.id}/cells/${cellId}`).set('Authorization', `Bearer ${admin}`);
    expect(cellDel.body.version).toBe(5);
  });

  it('TF-A review presentation (Q-a): one question, scale fraction and mark, per-statement solution, no cluster block', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'qd764_graduation', totalScore: 4 });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề TF-A review' });
    const quiz = gen.body as QuizBody;
    // Pin sinh từ ma trận mang reviewRightAnswer mặc định DB = 272
    // (laterWhileOpen 256 + afterClose 16, KHÔNG có bit immediatelyAfter
    // 4096) nên GET ngay sau nộp — trong cửa sổ 2 phút sau khi nộp —
    // sẽ bị cổng reviewRightAnswer đóng và solution = null là ĐÚNG
    // chính sách. Ca này kiểm solution nên mở cổng ngay sau nộp:
    // 4368 = 272 + immediatelyAfter 4096.
    const openReview = await http(app).patch(`/api/v1/exam-pins/${quiz.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ reviewRightAnswer: 4368 });
    expect(openReview.status).toBeLessThan(300);
    const played = await playTfQuiz(ctx.student, quiz.id, 2, ctx.tfQuestion, ctx.tfCorrects);
    const view = await http(app).get(`/api/v1/quiz-attempts/${played.attempt.id}`).set('Authorization', `Bearer ${ctx.student}`);
    const qs = view.body.questions as {
      fraction: number | null; mark: number | null;
      solution: { statements: { statementId: string; value: boolean }[] } | null;
      rightAnswer: string | null;
    }[];
    // Câu TF-A là MỘT question attempt: 2/4 ý đúng → fraction 0,25
    // theo thang, điểm = 25% × 4 = 1; không còn khối cluster.
    expect(qs).toHaveLength(1);
    const q = qs[0]!;
    expect(q.fraction).toBeCloseTo(0.25, 6);
    expect(q.mark).toBeCloseTo(1, 6);
    expect(q).not.toHaveProperty('cluster');
    expect(q.solution?.statements).toEqual([
      { statementId: 's1', value: true },
      { statementId: 's2', value: false },
      { statementId: 's3', value: true },
      { statementId: 's4', value: false },
    ]);
    expect(q.rightAnswer).toBe('Đúng, Sai, Đúng, Sai');
  });

  it('grade-by-question (Q-b): queue lists every submitted attempt for one question; bulk grading finishes the attempts', async () => {
    const ctx = await setup();
    const essay = await ctx.mkQuestion({
      qtype: 'essay', questionText: 'Viết đoạn văn ngắn.', defaultMark: 2,
    });
    const draft = await createExamDraft(app, admin, 'Đề tự luận', 2);
    await addExamSlot(app, admin, draft, { questionId: essay });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId });
    const quizId = pin.id as string;
    const playEssay = async (token: string, text: string): Promise<string> => {
      const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send({});
      const view = start.body as AttemptViewBody;
      const q = view.questions[0]!;
      await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${token}`)
        .send({ questionAttemptId: q.questionAttemptId, response: text });
      const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${token}`).send({});
      expect((submit.body as AttemptViewBody).attempt.state).toBe('needsgrading');
      return view.attempt.id;
    };
    const a1 = await playEssay(ctx.student, 'Bài của học sinh 1');
    const a2 = await playEssay(ctx.student2, 'Bài của học sinh 2');
    const queue = await http(app).get(`/api/v1/exam-pins/${quizId}/grade-by-question/${essay}`).set('Authorization', `Bearer ${admin}`);
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveLength(2);
    expect((queue.body as { response: string | null }[]).map((r) => r.response).sort())
      .toEqual(['Bài của học sinh 1', 'Bài của học sinh 2']);
    const graded = await http(app).post(`/api/v1/exam-pins/${quizId}/grade-by-question`).set('Authorization', `Bearer ${admin}`)
      .send({ questionId: essay, grades: [{ attemptId: a1, mark: 2 }, { attemptId: a2, mark: 1 }] });
    expect(graded.status === 200 || graded.status === 201).toBe(true);
    const summaries = graded.body as { id: string; state: string; sumGrades: number | null }[];
    expect(summaries.map((s) => s.state)).toEqual(['finished', 'finished']);
    expect(summaries.find((s) => s.id === a1)!.sumGrades).toBe(2);
    expect(summaries.find((s) => s.id === a2)!.sumGrades).toBe(1);
  });

  it('overall feedback bands (Q-c layer 4): the finished attempt view carries the band matching its percent', async () => {
    const ctx = await setup();
    const draft = await createExamDraft(app, admin, 'Đề feedback', 10);
    await addExamSlot(app, admin, draft, { questionId: ctx.mcPool[0]! });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId });
    const quizId = pin.id as string;
    const band1 = await http(app).post(`/api/v1/exam-pins/${quizId}/feedbacks`).set('Authorization', `Bearer ${admin}`)
      .send({ minPercent: 0, maxPercent: 50, feedback: 'Cần ôn lại kiến thức nền.' });
    expect(band1.status === 200 || band1.status === 201).toBe(true);
    await http(app).post(`/api/v1/exam-pins/${quizId}/feedbacks`).set('Authorization', `Bearer ${admin}`)
      .send({ minPercent: 50, maxPercent: 100, feedback: 'Làm tốt, tiếp tục phát huy.' });
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    const view = start.body as AttemptViewBody;
    const q = view.questions[0]!;
    // Đáp án đúng của câu MC trong pool: dòng đáp án mang isCorrect — lấy qua view của giáo viên.
    const teacherView = await http(app).get(`/api/v1/questions/${ctx.mcPool[0]}`).set('Authorization', `Bearer ${admin}`);
    const rightId = (teacherView.body.answers as { id: string; isCorrect: boolean }[]).find((a) => a.isCorrect)!.id;
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: q.questionAttemptId, response: rightId });
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect((submit.body as { overallFeedback: string | null }).overallFeedback).toBe('Làm tốt, tiếp tục phát huy.');
    const bands = await http(app).get(`/api/v1/exam-pins/${quizId}/feedbacks`).set('Authorization', `Bearer ${admin}`);
    expect(bands.body).toHaveLength(2);
  });

  it('TF-A statistics: the removed cluster endpoint is gone; per-question stats count the TF-A slot as one question', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'qd764_graduation', totalScore: 4 });
    await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề thống kê TF-A' });
    const quiz = gen.body as QuizBody;
    await playTfQuiz(ctx.student, quiz.id, 2, ctx.tfQuestion, ctx.tfCorrects);
    await playTfQuiz(ctx.student2, quiz.id, 4, ctx.tfQuestion, ctx.tfCorrects);
    // Endpoint thống kê chùm đã xoá hẳn cùng cơ chế chùm.
    const gone = await http(app).get(`/api/v1/exam-pins/${quiz.id}/cluster-statistics`).set('Authorization', `Bearer ${admin}`);
    expect(gone.status).toBe(404);
    // Thống kê theo câu: slot TF-A là MỘT câu — 2 lượt làm, 1 lượt
    // chưa trọn (2/4 ý), không lượt nào sai toàn phần.
    const results = await http(app).get(`/api/v1/exam-pins/${quiz.id}/results`).set('Authorization', `Bearer ${admin}`);
    expect(results.status).toBe(200);
    const stats = results.body.questionStats as { questionId: string | null; attemptsCount: number; wrongCount: number; fullyWrongCount: number }[];
    const tfStat = stats.find((x) => x.questionId === ctx.tfQuestion)!;
    expect(tfStat.attemptsCount).toBe(2);
    expect(tfStat.wrongCount).toBe(1);
    expect(tfStat.fullyWrongCount).toBe(0);
  });

  it('level-set downgrade guard (issue #233, lát D-2): four→three is blocked while a van_dung_cao cell exists; allowed after removing the cell', async () => {
    const ctx = await setup();
    // Ma trận bộ 4 mức có một ô Vận dụng cao — tiền đề của ca chặn:
    // mức Vận dụng cao là tuỳ chọn bật thêm của CV 7991, hạ về bộ 3
    // mức trong khi ô của mức đó còn tồn tại sẽ làm mất ô lặng lẽ.
    const matrix = await createMatrix(ctx, { levelSet: 'four' });
    expect(matrix.levelSet).toBe('four');
    const withCell = await addCell(matrix.id, {
      curriculumNodeId: ctx.lessonId, cognitiveLevel: 'van_dung_cao', qtype: 'essay',
      questionCount: 1, cellScore: 1,
    });
    expect(withCell.status).toBeLessThan(300);
    const vdcCell = (withCell.body.cells as { id: string; cognitiveLevel: string }[])
      .find((c) => c.cognitiveLevel === 'van_dung_cao')!;
    expect(vdcCell).toBeTruthy();

    // Hạ bộ mức → 400 quiz.matrix_level_in_use và ma trận KHÔNG đổi
    // (vẫn bộ bốn mức, vẫn còn ô, version không tăng).
    const blocked = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ levelSet: 'three' });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('quiz.matrix_level_in_use');
    const afterBlocked = await http(app).get(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`);
    expect(afterBlocked.body.levelSet).toBe('four');
    expect(afterBlocked.body.version).toBe(matrix.version);
    expect(afterBlocked.body.cells).toHaveLength(1);

    // Ca đối chứng: xoá ô Vận dụng cao trước thì hạ bộ mức thành công.
    const del = await http(app).delete(`/api/v1/exam-matrices/${matrix.id}/cells/${vdcCell.id}`).set('Authorization', `Bearer ${admin}`);
    expect(del.status).toBeLessThan(300);
    const lowered = await http(app).patch(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`)
      .send({ levelSet: 'three' });
    expect(lowered.status).toBeLessThan(300);
    expect(lowered.body.levelSet).toBe('three');
  });
});
