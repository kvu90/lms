import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * EB-2 (issue #153) — đề recipe + generate hai bước + materialize +
 * mã đề, đối chiếu hồ sơ ngân hàng đề/ma trận (E-3, D.3, E-5):
 *  - generate per_student đi matrix → exam_papers(kind=recipe, ghim
 *    matrix version + recipeSpec) → deploy quiz; quizzes.paper_id là
 *    truy vết chính, matrix_id là truy vết phụ;
 *  - một recipe triển khai cho 2 lớp: hai bộ câu tương đương cùng
 *    cấu trúc (cùng ô/số câu/điểm), câu rút tại attempt theo pool;
 *  - materialize chụp recipe xuống snapshot (derived_from → recipe),
 *    sửa bằng swap-cùng-ô; recipe gốc + lần thi trước nguyên vẹn;
 *  - mã đề (variant_code) sinh ở tầng triển khai kèm seed; in đề
 *    snapshot kèm mã đề.
 */
describe('EB-2 recipe papers + two-step generate + materialize + variant codes', () => {
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
  interface QuizBody { id: string; matrixId: string | null; paperId: string | null; examVersionId: string | null; slots: SlotBody[]; sumGrades: number }
  interface PaperSlot { position: number; questionId: string; pinnedVersionNumber: number | null; maxMark: number; matrixCellId: string | null }
  interface CellReport { sourceCellId: string; expectedUnits: number; actualUnits: number; expectedScore: number; actualScore: number; deviated: boolean }
  interface PaperBody {
    paper: { id: string; kind: string; status: string; derivedFromExamId: string | null; latestVersion: number };
    version: { id: string; matrixId: string | null; matrixVersion: number | null; recipeSpec: { drawMode: string; sourceBankScope: string | null; cells: unknown[] } | null };
    slots: PaperSlot[];
    cellReport: CellReport[] | null;
  }
  interface DeploymentBody { id: string; quizId: string; variantCount: number; variants: { code: string; seed: number }[] }
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
      .send({ name: 'Ma trận EB-2', subjectId: ctx.subjectId, curriculumId: ctx.curriculumId, presetKind: 'custom', totalScore: 4 });
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

  async function generate(ctx: Ctx, matrixId: string, course: { id: string; sectionId: string }, drawMode: string, name: string) {
    return http(app).post(`/api/v1/exam-matrices/${matrixId}/generate`).set('Authorization', `Bearer ${admin}`)
      .send({ courseId: course.id, sectionId: course.sectionId, name, drawMode });
  }

  async function startAttempt(token: string, quizId: string): Promise<AttemptViewBody> {
    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send({});
    if (start.status !== 201 && start.status !== 200) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
    return start.body as AttemptViewBody;
  }

  /** Bộ câu của một attempt theo ô: slot 1–3 thuộc ô A, slot 4 thuộc ô B. */
  function setsByCell(view: AttemptViewBody): { a: Set<string>; b: Set<string> } {
    const a = new Set(view.questions.filter((q) => q.slot <= 3).map((q) => q.questionId));
    const b = new Set(view.questions.filter((q) => q.slot === 4).map((q) => q.questionId));
    return { a, b };
  }

  it('generate per_student: two-step via a recipe paper; same recipe deployed to two classes gives equivalent sets with the same structure', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx);

    const gen = await generate(ctx, matrix.id, ctx.course1, 'per_student', 'Đề luyện tập');
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz1 = gen.body as QuizBody & { deployment: DeploymentBody };
    // Truy vết: paper là chính, matrix là phụ; slots chỉ mang ô nguồn.
    expect(quiz1.examId).toBeTruthy();
    expect(quiz1.matrixId).toBe(matrix.id);
    expect(quiz1.slots).toHaveLength(4);
    for (const s of quiz1.slots) {
      expect(s.questionId).toBeNull();
      expect(s.matrixCellId).toBeTruthy();
    }
    expect(quiz1.deployment.variants.map((v) => v.code)).toEqual(['001']);

    // Đề recipe đã nằm trong ngân hàng đề: ghim matrix version + công thức.
    const paperRes = await http(app).get(`/api/v1/exam-papers/${quiz1.examId}`).set('Authorization', `Bearer ${admin}`);
    const paper = paperRes.body as PaperBody;
    expect(paper.paper.kind).toBe('recipe');
    expect(paper.paper.status).toBe('ready');
    expect(paper.version.matrixId).toBe(matrix.id);
    expect(paper.version.matrixVersion).toBe(matrix.version);
    expect(paper.version.recipeSpec?.drawMode).toBe('per_student');
    expect(paper.version.recipeSpec?.cells).toHaveLength(2);
    expect(paper.slots).toHaveLength(0);

    // Triển khai cùng recipe sang lớp 2 với 2 mã đề.
    const quiz2Res = await http(app).post(`/api/v1/courses/${ctx.course2.id}/quizzes`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.course2.sectionId, name: 'Đề luyện tập lớp 2' });
    const quiz2 = quiz2Res.body as QuizBody;
    const deploy = await http(app).post(`/api/v1/exam-papers/${quiz1.examId}/deploy`).set('Authorization', `Bearer ${admin}`)
      .send({ quizId: quiz2.id, variantCount: 2 });
    expect(deploy.status === 200 || deploy.status === 201).toBe(true);
    expect((deploy.body as QuizBody).examId).toBe(quiz1.examId);
    expect((deploy.body as { deployment: DeploymentBody }).deployment.variants.map((v) => v.code)).toEqual(['001', '002']);

    // Hai lớp làm bài: cấu trúc tương đương (3 câu ô A + 1 câu ô B, đều
    // thuộc pool của ô), bộ câu rút tại attempt.
    const seen = new Set<string>();
    const checkAttempt = async (token: string, quizId: string) => {
      const view = await startAttempt(token, quizId);
      const { a, b } = setsByCell(view);
      expect(a.size).toBe(3);
      expect(b.size).toBe(1);
      for (const q of a) expect(ctx.poolA).toContain(q);
      for (const q of b) expect(ctx.poolB).toContain(q);
      seen.add([...a].sort().join(','));
      return view;
    };
    for (const t of ctx.students1) await checkAttempt(t, quiz1.id);
    for (const t of ctx.students2) await checkAttempt(t, quiz2.id);
    // 6 lượt rút từ pool 6 chọn 3: không thể mọi lượt trùng một bộ duy nhất.
    expect(seen.size).toBeGreaterThan(1);

    // Sổ triển khai của đề: 2 lần (generate + deploy tay), mã theo từng lần.
    const deps = await http(app).get(`/api/v1/exam-papers/${quiz1.examId}/deployments`).set('Authorization', `Bearer ${admin}`);
    const rows = deps.body as DeploymentBody[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.variantCount).sort()).toEqual([1, 2]);
  }, 120_000);

  it('materialize: snapshot from recipe, same-cell swap, deploy again — recipe and the earlier attempt stay intact', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx);
    const gen = await generate(ctx, matrix.id, ctx.course1, 'per_student', 'Đề recipe gốc');
    const quiz1 = gen.body as QuizBody;
    const recipeId = quiz1.examId!;
    // Một lượt thi TRƯỚC khi materialize/swap — phải nguyên vẹn về sau.
    const before = await startAttempt(ctx.students1[0]!, quiz1.id);
    const beforeSet = new Set(before.questions.map((q) => q.questionId));

    // Recipe không sửa tay trực tiếp.
    const putSlots = await http(app).put(`/api/v1/exam-papers/${recipeId}/slots`).set('Authorization', `Bearer ${admin}`)
      .send({ slots: [{ questionId: ctx.poolA[0] }] });
    expect(putSlots.status).toBe(400);
    expect(putSlots.body.code).toBe('exam.recipe_not_editable');

    // Chụp xuống snapshot.
    const mat = await http(app).post(`/api/v1/exam-papers/${recipeId}/materialize`).set('Authorization', `Bearer ${admin}`).send({});
    expect(mat.status === 200 || mat.status === 201).toBe(true);
    const snapshot = mat.body as PaperBody;
    expect(snapshot.paper.kind).toBe('snapshot');
    expect(snapshot.paper.derivedFromExamId).toBe(recipeId);
    expect(snapshot.version.matrixVersion).toBe(matrix.version);
    expect(snapshot.slots).toHaveLength(4);
    for (const s of snapshot.slots) {
      expect(s.matrixCellId).toBeTruthy();
      expect(s.pinnedVersionNumber).toBeTruthy();
    }
    expect(snapshot.cellReport).toHaveLength(2);
    for (const c of snapshot.cellReport!) expect(c.deviated).toBe(false);

    // Swap-cùng-ô: câu ngoài pool của ô bị chặn; câu trong pool được.
    const slotA = snapshot.slots.find((s) => s.position <= 3)!;
    const wrongCell = await http(app).post(`/api/v1/exam-papers/${snapshot.paper.id}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ position: slotA.position, questionId: ctx.poolB[0] });
    expect(wrongCell.status).toBe(400);
    expect(wrongCell.body.code).toBe('exam.swap_candidate_out_of_cell');
    const inPaper = new Set(snapshot.slots.map((s) => s.questionId));
    const candidate = ctx.poolA.find((q) => !inPaper.has(q))!;
    const swapped = await http(app).post(`/api/v1/exam-papers/${snapshot.paper.id}/swap`).set('Authorization', `Bearer ${admin}`)
      .send({ position: slotA.position, questionId: candidate });
    expect(swapped.status === 200 || swapped.status === 201).toBe(true);
    const after = swapped.body as PaperBody;
    expect(after.paper.latestVersion).toBe(2);
    expect(after.slots.find((s) => s.position === slotA.position)?.questionId).toBe(candidate);
    for (const c of after.cellReport!) expect(c.deviated).toBe(false);

    // Triển khai snapshot đã sửa với 3 mã đề; học sinh thấy đúng bộ đã swap.
    await http(app).post(`/api/v1/exam-papers/${snapshot.paper.id}/status`).set('Authorization', `Bearer ${admin}`).send({ status: 'ready' });
    const quiz2Res = await http(app).post(`/api/v1/courses/${ctx.course1.id}/quizzes`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.course1.sectionId, name: 'Đề chụp đã sửa' });
    const quiz2 = quiz2Res.body as QuizBody;
    const deploy = await http(app).post(`/api/v1/exam-papers/${snapshot.paper.id}/deploy`).set('Authorization', `Bearer ${admin}`)
      .send({ quizId: quiz2.id, variantCount: 3 });
    expect(deploy.status === 200 || deploy.status === 201).toBe(true);
    const deployment = (deploy.body as { deployment: DeploymentBody }).deployment;
    expect(deployment.variants.map((v) => v.code)).toEqual(['001', '002', '003']);
    const view2 = await startAttempt(ctx.students1[1]!, quiz2.id);
    expect(new Set(view2.questions.map((q) => q.questionId))).toEqual(new Set(after.slots.map((s) => s.questionId)));

    // In đề kèm mã đề.
    const print = await http(app).get(`/api/v1/exam-papers/${snapshot.paper.id}/print`)
      .query({ deploymentId: deployment.id, variantCode: '002' })
      .set('Authorization', `Bearer ${admin}`);
    expect(print.status).toBe(200);
    expect(print.text).toContain('Mã đề: 002');

    // In RECIPE bị chặn: chỉ snapshot mới in được — recipe triển khai xong
    // vẫn không in trực tiếp (tránh in nhầm tờ trống, ghi nhận đóng gói EB-2).
    const quiz3Res = await http(app).post(`/api/v1/courses/${ctx.course1.id}/quizzes`).set('Authorization', `Bearer ${admin}`)
      .send({ sectionId: ctx.course1.sectionId, name: 'Đề recipe để in thử' });
    const quiz3 = quiz3Res.body as QuizBody;
    const recipeDeploy = await http(app).post(`/api/v1/exam-papers/${recipeId}/deploy`).set('Authorization', `Bearer ${admin}`)
      .send({ quizId: quiz3.id, variantCount: 1 });
    expect(recipeDeploy.status === 200 || recipeDeploy.status === 201).toBe(true);
    const recipeDeployment = (recipeDeploy.body as { deployment: DeploymentBody }).deployment;
    const printRecipe = await http(app).get(`/api/v1/exam-papers/${recipeId}/print`)
      .query({ deploymentId: recipeDeployment.id, variantCode: '001' })
      .set('Authorization', `Bearer ${admin}`);
    expect(printRecipe.status).toBe(400);
    expect(printRecipe.body.code).toBe('exam.print_requires_snapshot');

    // Recipe gốc + lượt thi trước nguyên vẹn.
    const recipeAfter = await http(app).get(`/api/v1/exam-papers/${recipeId}`).set('Authorization', `Bearer ${admin}`);
    const recipeBody = recipeAfter.body as PaperBody;
    expect(recipeBody.paper.latestVersion).toBe(1);
    expect(recipeBody.slots).toHaveLength(0);
    expect(recipeBody.version.recipeSpec?.cells).toHaveLength(2);
    const beforeAgain = await http(app).get(`/api/v1/quiz-attempts/${before.attempt.id}`).set('Authorization', `Bearer ${ctx.students1[0]}`);
    expect(beforeAgain.status).toBe(200);
    expect(new Set((beforeAgain.body as AttemptViewBody).questions.map((q) => q.questionId))).toEqual(beforeSet);
  }, 120_000);

  it('generate fixed: one-step still works, and the generated paper is a ready snapshot carrying the drawn set', async () => {
    const ctx = await setup();
    const matrix = await createMatrix(ctx);
    const gen = await generate(ctx, matrix.id, ctx.course1, 'fixed', 'Đề cố định');
    expect(gen.status === 200 || gen.status === 201).toBe(true);
    const quiz = gen.body as QuizBody;
    expect(quiz.examId).toBeTruthy();
    expect(quiz.matrixId).toBe(matrix.id);
    expect(quiz.slots).toHaveLength(4);
    for (const s of quiz.slots) expect(s.questionId).toBeTruthy();
    const paperRes = await http(app).get(`/api/v1/exam-papers/${quiz.examId}`).set('Authorization', `Bearer ${admin}`);
    const paper = paperRes.body as PaperBody;
    expect(paper.paper.kind).toBe('snapshot');
    expect(paper.paper.status).toBe('ready');
    expect(paper.version.recipeSpec).toBeNull();
    expect(new Set(paper.slots.map((s) => s.questionId))).toEqual(new Set(quiz.slots.map((s) => s.questionId)));
  }, 120_000);
});
