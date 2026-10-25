import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * EB-2 hậu gộp Đề (#226; bản gốc issue #153 về recipe/materialize đã
 * bị thay thế bởi chốt bỏ recipe 26/10) — generate từ ma trận + mã đề:
 *  - generate rút MỘT bộ câu cố định → exams(kind=snapshot, ghim
 *    matrix version) → ghim vào khoá (exam_pins); exam_id là truy
 *    vết chính, matrix_id là truy vết phụ;
 *  - cùng một đề ghim cho 2 khoá: MỌI học sinh nhận CÙNG một bộ câu
 *    (không còn rút lại theo từng học sinh);
 *  - đề sinh ra là snapshot thường: sửa trực tiếp bằng swap-cùng-ô
 *    (version mới), lượt thi trước + pin cũ nguyên vẹn;
 *  - mã đề (variant_code) sinh ở tầng GHIM kèm seed; in đề kèm mã đề
 *    theo pin.
 */
describe('EB-2 generated snapshot exams + variant codes (post-merge)', () => {
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

  interface SlotBody { id: string; slot: number; questionId: string | null; matrixCellId: string | null; clusterId: string | null; maxMark: number }
  interface QuizBody { id: string; matrixId: string | null; examId: string | null; examVersionId: string | null; slots: SlotBody[]; sumGrades: number; variants: { code: string; seed: number }[] }
  interface PaperSlot { position: number; questionId: string; pinnedVersionNumber: number | null; maxMark: number; matrixCellId: string | null }
  interface PaperBody {
    paper: { id: string; kind: string; status: string; derivedFromExamId: string | null; latestVersion: number };
    version: { id: string; matrixId: string | null; matrixVersion: number | null };
    slots: PaperSlot[];
  }
  interface AttemptViewBody { attempt: { id: string; state: string }; questions: { slot: number; questionId: string }[] }

  interface Ctx {
    subjectId: string; curriculumId: string;
    outcomeBiet: string; outcomeHieu: string;
    course1: { id: string; sectionId: string };
    course2: { id: string; sectionId: string };
    students1: string[]; students2: string[];
    poolA: string[]; poolB: string[];
  }

  async function setup(): Promise<Ctx> {
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;

    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set('Authorization', `Bearer ${admin}`)
      .send({ contextId: systemCtx.id, name: 'Toán học', slug: `toan-eb2-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    const subjectId = subjRes.body.id as string;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set('Authorization', `Bearer ${admin}`)
      .send({ subjectId, grade: 10 });
    const curriculumId = currRes.body.id as string;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, title: 'Hàm số', kind: 'topic' });
    const lessonRes = await http(app).post('/api/v1/curriculum/nodes').set('Authorization', `Bearer ${admin}`)
      .send({ curriculumId, parentId: topicRes.body.id, title: 'Hàm số bậc hai', kind: 'lesson' });
    const mkOutcome = async (content: string) => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set('Authorization', `Bearer ${admin}`)
        .send({ nodeId: lessonRes.body.id, content });
      return r.body.id as string;
    };
    const outcomeBiet = await mkOutcome('Nhận biết được tính đồng biến của hàm số bậc hai.');
    const outcomeHieu = await mkOutcome('Giải thích được mối liên hệ giữa đồ thị và hệ số a.');

    const cat = await createCategory(app, admin);
    const mkCourse = async (nStudents: number) => {
      const course = await createCourse(app, admin, cat.id);
      const sectionId = await getFirstSectionId(app, admin, course.id);
      const instance = await createEnrolInstance(app, admin, course.id);
      const students: string[] = [];
      for (let i = 0; i < nStudents; i++) {
        const u = await createUserViaApi(app, admin);
        await enrolUser(app, admin, course.id, instance.id, u.id);
        students.push((await login(app, u.username, STRONG_PASSWORD)).accessToken);
      }
      return { id: course.id, sectionId, students };
    };
    const c1 = await mkCourse(3);
    const c2 = await mkCourse(3);

    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'EB2 bank', contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const mkQuestion = async (name: string): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({
        categoryId: bankCatId, qtype: 'multichoice', name, questionText: `${name}: chọn đáp án đúng.`, defaultMark: 1,
        answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }], options: { single: true },
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.question.id as string;
    };
    const tag = async (questionId: string, outcomeId: string, level: string) => {
      const r = await http(app).post(`/api/v1/questions/${questionId}/outcomes`).set('Authorization', `Bearer ${admin}`)
        .send({ outcomeId, cognitiveLevel: level });
      if (r.status !== 201 && r.status !== 200) throw new Error(`tag failed: ${r.status} ${JSON.stringify(r.body)}`);
    };
    const poolA: string[] = [];
    for (let i = 1; i <= 6; i++) { const q = await mkQuestion(`A${i}`); await tag(q, outcomeBiet, 'biet'); poolA.push(q); }
    const poolB: string[] = [];
    for (let i = 1; i <= 2; i++) { const q = await mkQuestion(`B${i}`); await tag(q, outcomeHieu, 'hieu'); poolB.push(q); }

    return {
      subjectId, curriculumId, outcomeBiet, outcomeHieu,
      course1: { id: c1.id, sectionId: c1.sectionId }, course2: { id: c2.id, sectionId: c2.sectionId },
      students1: c1.students, students2: c2.students, poolA, poolB,
    };
  }

  async function createMatrix(ctx: Ctx): Promise<{ id: string; version: number }> {
    const r = await http(app).post('/api/v1/exam-matrices').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Ma trận EB-2', subjectId: ctx.subjectId, curriculumId: ctx.curriculumId, totalScore: 4 });
    if (r.status !== 201 && r.status !== 200) throw new Error(`matrix failed: ${r.status} ${JSON.stringify(r.body)}`);
    const matrix = r.body as { id: string; version: number };
    const cellA = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/cells`).set('Authorization', `Bearer ${admin}`)
      .send({ learningOutcomeId: ctx.outcomeBiet, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 3, cellScore: 3, minutes: 10 });
    if (cellA.status !== 201 && cellA.status !== 200) throw new Error(`cellA failed: ${cellA.status} ${JSON.stringify(cellA.body)}`);
    const cellB = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/cells`).set('Authorization', `Bearer ${admin}`)
      .send({ learningOutcomeId: ctx.outcomeHieu, cognitiveLevel: 'hieu', qtype: 'multichoice', questionCount: 1, cellScore: 1, minutes: 5 });
    if (cellB.status !== 201 && cellB.status !== 200) throw new Error(`cellB failed: ${cellB.status} ${JSON.stringify(cellB.body)}`);
    return matrix;
  }

  async function generate(ctx: Ctx, matrixId: string, course: { id: string; sectionId: string }, name: string) {
    return http(app).post(`/api/v1/exam-matrices/${matrixId}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: course.id, sectionId: course.sectionId, name });
  }

  async function startAttempt(token: string, quizId: string): Promise<AttemptViewBody> {
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send({});
    if (start.status !== 201 && start.status !== 200) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
    return start.body as AttemptViewBody;
  }

  /** Bộ câu của một attempt theo ô: slot 1–3 thuộc ô A, slot 4 thuộc ô B. */
  function setsByCell(view: AttemptViewBody): { a: Set<string>; b: Set<string> } {
    const a = new Set(view.questions.filter((q) => q.slot <= 3).map((q) => q.questionId));
    const b = new Set(view.questions.filter((q) => q.slot === 4).map((q) => q.questionId));
    return { a, b };
  }

  it('generate: one fixed snapshot exam; the same exam pinned into two courses serves every student the SAME set; variant codes live on the pin', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx);

    const gen = await generate(ctx, matrix.id, ctx.course1, 'Đề luyện tập');
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz1 = gen.body as QuizBody;
    // Truy vết: exam là chính, matrix là phụ; slots đã ghim câu cụ thể
    // ngay từ lúc sinh (bỏ hẳn slot chỉ-mang-ô của recipe).
    expect(quiz1.examId).toBeTruthy();
    expect(quiz1.matrixId).toBe(matrix.id);
    expect(quiz1.slots).toHaveLength(4);
    for (const sl of quiz1.slots) {
      expect(sl.questionId).toBeTruthy();
      expect(sl.matrixCellId).toBeTruthy();
    }
    expect(quiz1.variants.map((v) => v.code)).toEqual(['001']);

    // Đề đã nằm trong ngân hàng đề: snapshot ready, ghim matrix version.
    const paperRes = await http(app).get(`/api/v1/exams/${quiz1.examId}`).set('Authorization', `Bearer ${admin}`);
    const paper = paperRes.body as PaperBody;
    expect(paper.paper.kind).toBe('snapshot');
    expect(paper.paper.status).toBe('ready');
    expect(paper.version.matrixId).toBe(matrix.id);
    expect(paper.version.matrixVersion).toBe(matrix.version);
    expect(paper.slots).toHaveLength(4);
    expect(new Set(paper.slots.map((x) => x.questionId))).toEqual(new Set(quiz1.slots.map((x) => x.questionId)));

    // Ghim cùng đề sang khoá 2 với 2 mã đề.
    const pin2Res = await http(app).post(`/api/v1/courses/${ctx.course2.id}/exam-pins`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.course2.sectionId, examId: quiz1.examId, name: 'Đề luyện tập lớp 2', variantCount: 2 });
    expect(pin2Res.status === 200 || pin2Res.status === 201).toBe(true);
    const pin2 = pin2Res.body as QuizBody;
    expect(pin2.examId).toBe(quiz1.examId);
    expect(pin2.variants.map((v) => v.code)).toEqual(['001', '002']);

    // Hai khoá làm bài: cấu trúc theo ô giữ nguyên (3 câu ô A + 1 câu
    // ô B, đều thuộc pool của ô) và MỌI lượt nhận CÙNG một bộ câu.
    const seen = new Set<string>();
    const checkAttempt = async (token: string, quizId: string) => {
      const view = await startAttempt(token, quizId);
      const { a, b } = setsByCell(view);
      expect(a.size).toBe(3);
      expect(b.size).toBe(1);
      for (const q of a) expect(ctx.poolA).toContain(q);
      for (const q of b) expect(ctx.poolB).toContain(q);
      seen.add([...view.questions.map((q) => q.questionId)].sort().join(','));
      return view;
    };
    for (const t of ctx.students1) await checkAttempt(t, quiz1.id);
    for (const t of ctx.students2) await checkAttempt(t, pin2.id);
    expect(seen.size).toBe(1);

    // Sổ ghim của đề theo khoá: mỗi khoá đúng một pin của đề này, số
    // mã đề theo từng lần ghim (1 và 2).
    const pins1 = await http(app).get(`/api/v1/courses/${ctx.course1.id}/exam-pins`).set('Authorization', `Bearer ${admin}`);
    const pins2 = await http(app).get(`/api/v1/courses/${ctx.course2.id}/exam-pins`).set('Authorization', `Bearer ${admin}`);
    const mine1 = (pins1.body as QuizBody[]).filter((x) => x.examId === quiz1.examId);
    const mine2 = (pins2.body as QuizBody[]).filter((x) => x.examId === quiz1.examId);
    expect(mine1).toHaveLength(1);
    expect(mine2).toHaveLength(1);
    expect([mine1[0]!.variants.length, mine2[0]!.variants.length].sort()).toEqual([1, 2]);
  }, 120_000);

  it('generated exam is a plain snapshot: same-cell swap makes a new version, earlier attempts and the original pin stay intact, print follows the pin variant', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx);
    const gen = await generate(ctx, matrix.id, ctx.course1, 'Đề sinh từ ma trận');
    const quiz1 = gen.body as QuizBody;
    const examId = quiz1.examId!;
    // Một lượt thi TRƯỚC khi swap — phải nguyên vẹn về sau.
    const before = await startAttempt(ctx.students1[0]!, quiz1.id);
    const beforeSet = new Set(before.questions.map((q) => q.questionId));

    // Đề sinh ra sửa tay trực tiếp được (không còn khoá recipe): đổi
    // toàn bộ slots qua setSlots tạo version mới.
    const paperRes = await http(app).get(`/api/v1/exams/${examId}`).set('Authorization', `Bearer ${admin}`);
    const snapshot = paperRes.body as PaperBody;
    expect(snapshot.paper.kind).toBe('snapshot');
    expect(snapshot.slots).toHaveLength(4);
    for (const sl of snapshot.slots) {
      expect(sl.matrixCellId).toBeTruthy();
      expect(sl.pinnedVersionNumber).toBeTruthy();
    }

    // Swap-cùng-ô: câu ngoài pool của ô bị chặn; câu trong pool được.
    const slotA = snapshot.slots.find((x) => x.position <= 3)!;
    const wrongCell = await http(app).post(`/api/v1/exams/${examId}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ position: slotA.position, questionId: ctx.poolB[0] });
    expect(wrongCell.status).toBe(400);
    expect(wrongCell.body.code).toBe('exam.swap_candidate_out_of_cell');
    const inPaper = new Set(snapshot.slots.map((x) => x.questionId));
    const candidate = ctx.poolA.find((q) => !inPaper.has(q))!;
    const swapped = await http(app).post(`/api/v1/exams/${examId}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ position: slotA.position, questionId: candidate });
    expect(swapped.status === 200 || swapped.status === 201).toBe(true);
    const after = swapped.body as PaperBody;
    expect(after.paper.latestVersion).toBe(2);
    expect(after.slots.find((x) => x.position === slotA.position)?.questionId).toBe(candidate);

    // Ghim version đã sửa (pin mới, 3 mã đề); học sinh thấy đúng bộ đã swap.
    const pin2Res = await http(app).post(`/api/v1/courses/${ctx.course1.id}/exam-pins`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.course1.sectionId, examId, examVersionId: after.version.id, name: 'Đề đã sửa', variantCount: 3 });
    expect(pin2Res.status === 200 || pin2Res.status === 201).toBe(true);
    const pin2 = pin2Res.body as QuizBody;
    expect(pin2.variants.map((v) => v.code)).toEqual(['001', '002', '003']);
    const view2 = await startAttempt(ctx.students1[1]!, pin2.id);
    expect(new Set(view2.questions.map((q) => q.questionId))).toEqual(new Set(after.slots.map((x) => x.questionId)));

    // In đề kèm mã đề theo pin.
    const print = await http(app).get(`/api/v1/exams/${examId}/print`)
      .query({ pinId: pin2.id, variantCode: '002' })
      .set('Authorization', `Bearer ${admin}`);
    expect(print.status).toBe(200);
    expect(print.text).toContain('Mã đề: 002');
    // In theo pin gốc (version 1) cũng được — mọi đề đã ghim đều là
    // snapshot in được, không còn lớp recipe bị chặn in.
    const print1 = await http(app).get(`/api/v1/exams/${examId}/print`)
      .query({ pinId: quiz1.id, variantCode: '001' })
      .set('Authorization', `Bearer ${admin}`);
    expect(print1.status).toBe(200);
    expect(print1.text).toContain('Mã đề: 001');

    // Đề gốc ở version 2 sau swap; pin gốc vẫn ghim version 1 và lượt
    // thi trước nguyên vẹn.
    const examAfter = await http(app).get(`/api/v1/exams/${examId}`).set('Authorization', `Bearer ${admin}`);
    const examBody = examAfter.body as PaperBody;
    expect(examBody.paper.latestVersion).toBe(2);
    expect(examBody.slots).toHaveLength(4);
    const pin1After = await http(app).get(`/api/v1/exam-pins/${quiz1.id}`).set('Authorization', `Bearer ${admin}`);
    expect((pin1After.body as { quiz: QuizBody }).quiz.examVersionId).not.toBe(after.version.id);
    const beforeAgain = await http(app).get(`/api/v1/quiz-attempts/${before.attempt.id}`).set('Authorization', `Bearer ${ctx.students1[0]}`);
    expect(beforeAgain.status).toBe(200);
    expect(new Set((beforeAgain.body as AttemptViewBody).questions.map((q) => q.questionId))).toEqual(beforeSet);
  }, 120_000);

  it('generate: one-step works, and the generated paper is a ready snapshot carrying the drawn set', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx);
    const gen = await generate(ctx, matrix.id, ctx.course1, 'Đề cố định');
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz = gen.body as QuizBody;
    expect(quiz.examId).toBeTruthy();
    expect(quiz.matrixId).toBe(matrix.id);
    expect(quiz.slots).toHaveLength(4);
    for (const s of quiz.slots) expect(s.questionId).toBeTruthy();
    const paperRes = await http(app).get(`/api/v1/exams/${quiz.examId}`).set('Authorization', `Bearer ${admin}`);
    const paper = paperRes.body as PaperBody;
    expect(paper.paper.kind).toBe('snapshot');
    expect(paper.paper.status).toBe('ready');
    // Không còn trường recipeSpec trên version (bỏ hẳn recipe).
    expect((paper.version as unknown as Record<string, unknown>).recipeSpec).toBeUndefined();
    expect(new Set(paper.slots.map((s) => s.questionId))).toEqual(new Set(quiz.slots.map((s) => s.questionId)));
  }, 120_000);
});
