import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Quiz Chặng 3 (issue #30) — ma trận đề + sinh slots + chấm Đ–S chùm +
 * bản đặc tả, đối chiếu hồ sơ thiết kế mục C:
 *  - ma trận neo Chương trình GDPT 2018 (môn → chương trình → node →
 *    YCCĐ), preset chụp lúc tạo, lệch tỉ lệ chỉ cảnh báo;
 *  - generate khoá cứng 422 khi thiếu câu ở bất kỳ ô nào; fixed rút
 *    không lặp, per_student rút theo ô lúc bắt đầu lượt;
 *  - chùm Đ–S (1 stimulus + 4 câu truefalse) chấm theo thang lũy tiến
 *    QĐ 764 mặc định [0,10,25,50,100]% — KHÔNG cộng tuyến tính;
 *  - bản đặc tả theo Mẫu 2 CV 7991 + xuất xlsx/docx.
 */
describe('Quiz matrix generation + cluster grading + specification (stage 3)', () => {
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

  interface SlotBody { id: string; slot: number; questionId: string | null; categoryId: string | null; matrixCellId: string | null; clusterId: string | null; maxMark: number }
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
    bankCatId: string;
    student: string;
    studentId: string;
    student2: string;
    mcPool: string[];
    mcPoolHieu: string[];
    tfClusterQuestions: string[];
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
        qtype: 'multichoice', name, questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }], options: { single: true },
      });
      await tag(q, outcomeBiet, 'biet');
      mcPool.push(q);
    }
    const mcPoolHieu: string[] = [];
    for (const name of ['MCH1', 'MCH2']) {
      const q = await mkQuestion({
        qtype: 'multichoice', name, questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }], options: { single: true },
      });
      await tag(q, outcomeHieu, 'hieu');
      mcPoolHieu.push(q);
    }
    // Chùm Đ–S: một stimulus + 4 câu truefalse cùng gắn outcome/mức Hiểu.
    const stimRes = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: bankCatId, content: 'Cho hàm số y = x² − 2x + 1. Xét tính đúng sai của các mệnh đề sau.' });
    if (stimRes.status !== 201 && stimRes.status !== 200) throw new Error(`stimulus failed: ${stimRes.status} ${JSON.stringify(stimRes.body)}`);
    const stimulusId = stimRes.body.id as string;
    const tfClusterQuestions: string[] = [];
    const corrects = [true, false, true, false];
    for (let i = 0; i < 4; i++) {
      const q = await mkQuestion({
        qtype: 'truefalse', name: `DS${i + 1}`, questionText: `Mệnh đề ${i + 1}`, defaultMark: 1,
        answer: { correct: corrects[i] }, stimulusId,
      });
      await tag(q, outcomeHieu, 'hieu');
      tfClusterQuestions.push(q);
    }
    return {
      courseId: course.id, sectionId, subjectId, curriculumId, outcomeBiet, outcomeHieu,
      bankCatId, student: s1.token, studentId: s1.id, student2: s2.token, mcPool, mcPoolHieu, tfClusterQuestions,
    };
  }

  async function createMatrix(ctx: Ctx, body: Record<string, unknown> = {}) {
    const r = await http(app).post('/api/v1/exam-matrices').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ma trận giữa kỳ', subjectId: ctx.subjectId, curriculumId: ctx.curriculumId, ...body });
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
  async function playClusterQuiz(token: string, quizId: string, correctCount: number, tfIds: string[]): Promise<AttemptViewBody> {
    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send({});
    if (start.status !== 201 && start.status !== 200) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
    let view = start.body as AttemptViewBody;
    // Thứ tự đúng của chùm trong setup: [true, false, true, false] — trả đúng correctCount câu đầu.
    const correctAnswers = ['true', 'false', 'true', 'false'];
    for (let i = 0; i < 4; i++) {
      const wantCorrect = i < correctCount;
      const response = wantCorrect ? correctAnswers[i]! : (correctAnswers[i] === 'true' ? 'false' : 'true');
      view = await answerAttempt(token, view.attempt.id, view, tfIds[i]!, response);
    }
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
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 4, minutes: 10,
    });
    expect(cell.status === 200 || cell.status === 201).toBe(true);
    // Trùng khoá ô bị từ chối.
    const dup = await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 1, cellScore: 1,
    });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('quiz.matrix_cell_exists');
    // van_dung_cao ngoài bộ ba mức bị từ chối.
    const vdc = await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'van_dung_cao', qtype: 'essay',
      questionCount: 1, cellScore: 1,
    });
    expect(vdc.status).toBe(400);
    expect(vdc.body.code).toBe('quiz.matrix_level_not_in_set');
    // Tổng ô (4) khác tổng đích (10) → cảnh báo, không khoá.
    const view = await http(app).get(`/api/v1/exam-matrices/${matrix.id}`).set('Authorization', `Bearer ${admin}`);
    expect(view.body.warnings.some((w: string) => w.includes('Tổng điểm các ô'))).toBe(true);
  });

  it('availability counts candidates per cell; generate hard-fails 422 when a cell is short', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 6 });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 4, cellScore: 4,
    });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 2,
    });
    const avail = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/availability`).set('Authorization', `Bearer ${admin}`);
    expect(avail.body.sufficient).toBe(false);
    const mcCell = (avail.body.cells as { required: number; available: number; deficit: number }[])
      .find((c) => c.required === 4)!;
    expect(mcCell.available).toBe(3); // pool có 3 câu multichoice
    expect(mcCell.deficit).toBe(1);
    const tfCell = (avail.body.cells as { required: number; available: number }[]).find((c) => c.required === 1)!;
    expect(tfCell.available).toBe(1); // đúng 1 chùm 4 câu

    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề thiếu câu', drawMode: 'fixed' });
    expect(gen.status).toBe(422);
    expect(gen.body.code).toBe('quiz.matrix_insufficient_questions');
  });

  it('generate fixed: slots follow cells, TF cell becomes one cluster of 4 slots with nominal marks', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 6 });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 2, minutes: 5,
    });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4, minutes: 10,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề giữa kỳ', drawMode: 'fixed' });
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz = gen.body as QuizBody;
    expect(quiz.matrixId).toBe(matrix.id);
    expect(quiz.slots).toHaveLength(6);
    expect(quiz.sumGrades).toBeCloseTo(6, 6);
    const mcSlots = quiz.slots.filter((s) => s.matrixCellId && s.questionId && !s.clusterId);
    expect(mcSlots).toHaveLength(2);
    expect(new Set(mcSlots.map((s) => s.questionId)).size).toBe(2);
    for (const s of mcSlots) expect(ctx.mcPool).toContain(s.questionId);
    const tfSlots = quiz.slots.filter((s) => s.clusterId);
    expect(tfSlots).toHaveLength(4);
    expect(new Set(tfSlots.map((s) => s.clusterId)).size).toBe(1);
    for (const s of tfSlots) {
      expect(s.maxMark).toBeCloseTo(1, 6); // điểm chùm 4 / 4 slot
      expect(ctx.tfClusterQuestions).toContain(s.questionId);
    }
  });

  it('cluster grading follows the QD764 progressive scale, not linear addition', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 4 });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề chùm', drawMode: 'fixed' });
    const quiz = gen.body as QuizBody;
    // 2/4 ý đúng → thang QĐ 764 cho 25% × 4 = 1 điểm (tuyến tính sẽ là 2).
    const two = await playClusterQuiz(ctx.student, quiz.id, 2, ctx.tfClusterQuestions);
    expect(two.attempt.state).toBe('finished');
    expect(two.attempt.sumGrades).toBeCloseTo(1, 6);
    // 3/4 ý đúng → 50% × 4 = 2 điểm (tuyến tính sẽ là 3).
    const three = await playClusterQuiz(ctx.student2, quiz.id, 3, ctx.tfClusterQuestions);
    expect(three.attempt.sumGrades).toBeCloseTo(2, 6);
    // Điểm bài đã ghi: thang grade của quiz = 4 nên điểm = sumGrades.
    const info = await http(app).get(`/api/v1/quizzes/${quiz.id}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(info.body.myGrade).toBeCloseTo(1, 6);
  });

  it('generate per_student: slots carry only the cell; swap retargets the source cell; each attempt draws from the cell pools; swap freezes after a real attempt', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'custom', totalScore: 4 });
    const cellARes = await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 2,
    });
    const cellA = (cellARes.body.cells as { id: string; qtype: string }[]).find((c) => c.qtype === 'multichoice')!.id;
    const cellBRes = await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'multichoice',
      questionCount: 1, cellScore: 1,
    });
    const cellB = (cellBRes.body.cells as { id: string }[]).find((c) => c.id !== cellA)!.id;
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 1,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề per-student', drawMode: 'per_student' });
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz = gen.body as QuizBody;
    expect(quiz.slots.every((s) => s.questionId === null)).toBe(true);
    expect(quiz.slots).toHaveLength(7);

    // Đổi ô nguồn của một slot per-student (A → B) trước khi có lượt thật.
    const slotA = quiz.slots.find((s) => s.matrixCellId === cellA)!;
    const swap = await http(app).post(`/api/v1/quizzes/${quiz.id}/slots/${slotA.id}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ matrixCellId: cellB });
    expect(swap.status === 200 || swap.status === 201).toBe(true);
    const swappedSlot = (swap.body.slots as SlotBody[]).find((s) => s.id === slotA.id)!;
    expect(swappedSlot.matrixCellId).toBe(cellB);

    const start = await http(app).post(`/api/v1/quizzes/${quiz.id}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const view = start.body as AttemptViewBody;
    expect(view.questions).toHaveLength(7);
    const mcDrawn = view.questions.filter((q) => ctx.mcPool.includes(q.questionId));
    expect(mcDrawn).toHaveLength(1); // ô A còn 1 slot sau swap
    const mcHieuDrawn = view.questions.filter((q) => ctx.mcPoolHieu.includes(q.questionId));
    expect(mcHieuDrawn).toHaveLength(2); // ô B có 2 slot (gốc + slot vừa swap sang), rút không trùng
    expect(new Set(mcHieuDrawn.map((q) => q.questionId)).size).toBe(2);
    const tfDrawn = view.questions.filter((q) => ctx.tfClusterQuestions.includes(q.questionId));
    expect(tfDrawn).toHaveLength(4); // cả chùm được rút cho một lượt

    // Đã có lượt thật → swap bị đóng băng.
    const frozen = await http(app).post(`/api/v1/quizzes/${quiz.id}/slots/${slotA.id}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ matrixCellId: cellA });
    expect(frozen.status).toBe(400);
    expect(frozen.body.code).toBe('quiz.slots_frozen');
  });

  it('specification follows the matrix and the generated quiz; exports produce real files', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx, { presetKind: 'cv7991_periodic', totalScore: 6 });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice',
      questionCount: 2, cellScore: 2,
    });
    await addCell(matrix.id, {
      learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'truefalse',
      questionCount: 1, cellScore: 4,
    });
    const gen = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: ctx.courseId, sectionId: ctx.sectionId, name: 'Đề đặc tả', drawMode: 'fixed' });
    const quiz = gen.body as QuizBody;

    const spec = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification`).set('Authorization', `Bearer ${admin}`);
    expect(spec.status).toBe(200);
    expect(spec.body.subject.name).toBe('Toán học');
    expect(spec.body.topics[0].topicTitle).toBe('Hàm số');
    const outcomeTexts = JSON.stringify(spec.body.topics);
    expect(outcomeTexts).toContain('Nhận biết được tính đồng biến');
    expect(spec.body.totals.totalScore).toBeCloseTo(6, 6);
    expect(spec.body.totals.totalQuestions).toBe(6);
    expect(spec.body.quiz).toBeNull();

    const specWithQuiz = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification?quizId=${quiz.id}`).set('Authorization', `Bearer ${admin}`);
    expect(specWithQuiz.status).toBe(200);
    expect(JSON.stringify(specWithQuiz.body)).toContain('slotNumbers":[1,2]');
    // quizId của đề không thuộc ma trận → 400.
    const other = await http(app).post(`/api/v1/courses/${ctx.courseId}/quizzes`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.sectionId, name: 'Đề lạ' });
    const mismatch = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification?quizId=${other.body.id}`).set('Authorization', `Bearer ${admin}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.code).toBe('quiz.spec_quiz_mismatch');

    const xlsx = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/specification/export?format=xlsx&quizId=${quiz.id}`)
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

  it('hand-made cluster: grouping 4 TF slots of one stimulus applies the quiz tf scale', async () => {
    const ctx = await setup();
    const quizRes = await http(app).post(`/api/v1/courses/${ctx.courseId}/quizzes`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.sectionId, name: 'Đề tay chùm', grade: 4 });
    const quizId = quizRes.body.id as string;
    const slotIds: string[] = [];
    for (const q of ctx.tfClusterQuestions) {
      const s = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set('Authorization', `Bearer ${admin}`)
        .send({ questionId: q, maxMark: 1 });
      slotIds.push((s.body.slots as SlotBody[]).find((x) => x.questionId === q)!.id);
    }
    const clustered = await http(app).post(`/api/v1/quizzes/${quizId}/slots/cluster`).set('Authorization', `Bearer ${admin}`)
      .send({ slotIds });
    expect(clustered.status === 200 || clustered.status === 201).toBe(true);
    expect(new Set((clustered.body.slots as SlotBody[]).map((s) => s.clusterId)).size).toBe(1);
    // 1/4 ý đúng → thang mặc định QĐ 764: 10% × 4 = 0,4 (tuyến tính = 1).
    const one = await playClusterQuiz(ctx.student, quizId, 1, ctx.tfClusterQuestions);
    expect(one.attempt.sumGrades).toBeCloseTo(0.4, 6);
  });
});
