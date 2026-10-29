import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN, adminToken, assignRole, createContextViaApi, createTestApp, createUserViaApi, http, login, roleIdByShortname, systemContextId,
} from '../../support/identity-access-helpers';
import { PermissionEvaluator } from '../../../src/modules/access/permission-evaluator.service';
import { QuestionsService } from '../../../src/modules/questions/questions.service';
import { QuizService } from '../../../src/modules/quiz/quiz.service';

/**
 * Đặc trưng hoá số đếm ứng viên của ô ma trận (issue #488, điểm DL-02).
 *
 * Tại thời điểm viết đặc trưng hoá, `cellAvailableCount` đếm bằng cách
 * nạp toàn bộ ứng viên của ô qua `cellCandidatesForUser` rồi lấy độ dài
 * mảng. Test này ghim số đếm ĐÚNG theo từng kịch bản ô × người dùng
 * trên dữ kiện mẫu cố định — gồm ca người dùng bị chặn bởi quyền
 * `question:useall` tại context của category chứa câu — và đối chiếu
 * hai cách đếm trên cùng dữ kiện: cách đếm THAM CHIẾU bằng nạp view
 * (liệt kê ứng viên qua `listQuestionsByCurriculumFilter` rồi lọc
 * theo cổng `question:useall` tại context của category của từng câu —
 * đúng định nghĩa đếm trước refactor) với bề mặt đếm công khai
 * (`importAvailability` và `matrixAvailability` của QuizService, hai
 * đường dùng chung `cellAvailableCount`). Sau refactor đếm bằng
 * `count()` ở SQL, mọi con số ở đây phải giữ nguyên.
 *
 * Dữ kiện mẫu (mọi câu đều gắn YCCĐ của ĐVK, trạng thái ready trừ câu
 * nháp): ô (ĐVK, biết, multichoice) có 5 ứng viên thô — 3 câu ở
 * category context hệ thống + 2 câu ở category context khoá học; ô
 * (ĐVK, hiểu, multichoice) có 1; ô (ĐVK, biết, truefalse) có 1. Quản
 * trị viên dùng được cả hai context; giáo viên chỉ dùng được context
 * khoá học; người lạ không dùng được context nào.
 */
describe('Đặc trưng hoá số đếm ứng viên ô ma trận theo người dùng (issue #488)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let pg: Client;
  let quiz: QuizService;
  let questions: QuestionsService;
  let evaluator: PermissionEvaluator;

  let lessonId = '';
  let subjectId = '';
  let curriculumId = '';
  let teacherId = '';
  let strangerId = '';

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    adminId = (await login(app, ADMIN.username, ADMIN.password)).userId;
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    quiz = app.get(QuizService);
    questions = app.get(QuestionsService);
    evaluator = app.get(PermissionEvaluator);
    const sysCtx = await systemContextId(app, admin);

    const courseCtx = await createContextViaApi(app, admin, 50, randomUUID(), sysCtx);
    const teacher = await createUserViaApi(app, admin);
    teacherId = teacher.id;
    await assignRole(app, admin, teacherId, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    strangerId = (await createUserViaApi(app, admin)).id;

    const mkCategory = async (name: string, contextId: string): Promise<string> => {
      const r = await http(app).post('/api/v1/questions/categories').set(bearer(admin)).send({ name, contextId });
      if (r.status !== 201 && r.status !== 200) throw new Error(`category failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id as string;
    };
    const catSys = await mkCategory('Count sys', sysCtx);
    const catCourse = await mkCategory('Count course', courseCtx.id);

    const subj = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: sysCtx, name: 'Toán học', slug: `toan-count-${Date.now()}` });
    subjectId = subj.body.id as string;
    const curr = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 10 });
    curriculumId = curr.body.id as string;
    const topic = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, title: 'Chủ đề count', kind: 'topic' });
    const topicId = topic.body.id as string;
    const lesson = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: topicId, title: 'ĐVK count', kind: 'lesson' });
    lessonId = lesson.body.id as string;
    const otherLesson = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: topicId, title: 'ĐVK khác', kind: 'lesson' });
    const mkOutcome = async (nodeId: string, content: string): Promise<string> => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({ nodeId, content });
      if (r.status !== 201 && r.status !== 200) throw new Error(`outcome failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id as string;
    };
    const outcomeBiet = await mkOutcome(lessonId, 'YCCĐ biết của ĐVK count.');
    const outcomeHieu = await mkOutcome(lessonId, 'YCCĐ hiểu của ĐVK count.');
    const outcomeOther = await mkOutcome(otherLesson.body.id as string, 'YCCĐ của ĐVK khác.');

    const stim = await http(app).post('/api/v1/stimuli').set(bearer(admin))
      .send({ categoryId: catSys, content: 'Ngữ liệu cho câu Đúng–Sai đếm ứng viên.' });
    if (stim.status !== 201 && stim.status !== 200) throw new Error(`stimulus failed: ${stim.status} ${JSON.stringify(stim.body)}`);
    const stimulusId = stim.body.id as string;

    const fourAnswers = [
      { text: 'Đúng', correct: true }, { text: 'Sai', correct: false },
      { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false },
    ];
    const mkMc = async (categoryId: string, text: string): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
        categoryId, qtype: 'multichoice', questionText: text, defaultMark: 1, answers: fourAnswers,
      });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return (r.body as { question: { id: string } }).question.id;
    };
    const tag = async (questionId: string, outcomeId: string, level: string): Promise<void> => {
      const r = await http(app).post(`/api/v1/questions/${questionId}/outcomes`).set(bearer(admin))
        .send({ outcomeId, cognitiveLevel: level });
      if (r.status !== 201 && r.status !== 200) throw new Error(`tag failed: ${r.status} ${JSON.stringify(r.body)}`);
    };

    for (const name of ['SYS-B1', 'SYS-B2', 'SYS-B3']) await tag(await mkMc(catSys, `${name}: câu hệ thống mức biết.`), outcomeBiet, 'biet');
    for (const name of ['CRS-B1', 'CRS-B2']) await tag(await mkMc(catCourse, `${name}: câu khoá học mức biết.`), outcomeBiet, 'biet');
    await tag(await mkMc(catSys, 'SYS-H1: câu hệ thống mức hiểu.'), outcomeHieu, 'hieu');
    await tag(await mkMc(catSys, 'SYS-O1: câu của ĐVK khác.'), outcomeOther, 'biet');
    const draftId = await mkMc(catSys, 'SYS-D1: câu nháp mức biết.');
    await tag(draftId, outcomeBiet, 'biet');
    // Câu nháp không thuộc diện ứng viên: trạng thái của bank entry là
    // điều kiện lọc (status = ready) — đặt thẳng trạng thái fixture.
    await pg.query("update question_bank_entries set status = 'draft' where question_id = $1", [draftId]);

    const tfCorrects = [true, false, true, false];
    const tfRes = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId: catSys, qtype: 'truefalse', defaultMark: 1, stimulusId,
      questionText: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Ngữ liệu cho câu Đúng–Sai đếm ứng viên.' }] },
          {
            type: 'statementList',
            content: tfCorrects.map((v, i) => ({
              type: 'statement', attrs: { id: `s${i + 1}` },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề ${i + 1}` }] }],
            })),
          },
        ],
      },
      solution: { answers: tfCorrects.map((v, i) => ({ statementId: `s${i + 1}`, value: v })) },
    });
    if (tfRes.status !== 201 && tfRes.status !== 200) throw new Error(`tf failed: ${tfRes.status} ${JSON.stringify(tfRes.body)}`);
    await tag((tfRes.body as { question: { id: string } }).question.id, outcomeBiet, 'biet');
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  const cases: { actor: () => string; actorName: string; cell: { cognitiveLevel: string; qtype: string }; expected: number }[] = [
    { actor: () => adminId, actorName: 'quản trị viên', cell: { cognitiveLevel: 'biet', qtype: 'multichoice' }, expected: 5 },
    { actor: () => teacherId, actorName: 'giáo viên chỉ có quyền ở context khoá học', cell: { cognitiveLevel: 'biet', qtype: 'multichoice' }, expected: 2 },
    { actor: () => strangerId, actorName: 'người dùng không có quyền ở context nào', cell: { cognitiveLevel: 'biet', qtype: 'multichoice' }, expected: 0 },
    { actor: () => adminId, actorName: 'quản trị viên', cell: { cognitiveLevel: 'hieu', qtype: 'multichoice' }, expected: 1 },
    { actor: () => teacherId, actorName: 'giáo viên chỉ có quyền ở context khoá học', cell: { cognitiveLevel: 'hieu', qtype: 'multichoice' }, expected: 0 },
    { actor: () => adminId, actorName: 'quản trị viên', cell: { cognitiveLevel: 'biet', qtype: 'truefalse' }, expected: 1 },
    { actor: () => teacherId, actorName: 'giáo viên chỉ có quyền ở context khoá học', cell: { cognitiveLevel: 'biet', qtype: 'truefalse' }, expected: 0 },
    { actor: () => adminId, actorName: 'quản trị viên', cell: { cognitiveLevel: 'biet', qtype: 'essay' }, expected: 0 },
  ];

  /**
   * Cách đếm tham chiếu bằng nạp view: liệt kê ứng viên thô của ô rồi
   * đếm các câu thuộc category mà người dùng có `question:useall` tại
   * context của category (cache theo context) — đúng định nghĩa mà
   * đường đếm cũ (`cellCandidatesForUser(...).length`) áp dụng.
   */
  async function countByViews(actorId: string, cell: { curriculumNodeId: string; cognitiveLevel: string; qtype: string }): Promise<number> {
    const all = await questions.listQuestionsByCurriculumFilter({
      nodeId: cell.curriculumNodeId, cognitiveLevel: cell.cognitiveLevel, qtype: cell.qtype, status: 'ready',
    });
    const usableByContext = new Map<string, boolean>();
    let total = 0;
    for (const view of all) {
      const category = await questions.getCategory(view.entry.questionCategoryId);
      let usable = usableByContext.get(category.contextId);
      if (usable === undefined) {
        usable = await evaluator.hasCapability(actorId, 'question:useall', category.contextId);
        usableByContext.set(category.contextId, usable);
      }
      if (usable) total += 1;
    }
    return total;
  }

  for (const c of cases) {
    it(`số ứng viên ô (${c.cell.cognitiveLevel}, ${c.cell.qtype}) cho ${c.actorName} bằng ${c.expected} và trùng với cách đếm bằng nạp view`, async () => {
      const cell = { curriculumNodeId: lessonId, cognitiveLevel: c.cell.cognitiveLevel, qtype: c.cell.qtype };
      const viaImport = await quiz.importAvailability(c.actor(), [{ ...cell, questionCount: 1 }]);
      expect(viaImport).toHaveLength(1);
      expect(viaImport[0]!.available).toBe(c.expected);
      expect(viaImport[0]!.available).toBe(await countByViews(c.actor(), cell));
    });
  }

  it('matrixAvailability báo available/deficit theo từng ô khớp số đếm ứng viên và sufficient = false khi còn ô thiếu', async () => {
    const created = await http(app).post('/api/v1/exam-matrices').set(bearer(admin))
      .send({ name: 'Ma trận đếm ứng viên', subjectId, curriculumId });
    if (created.status !== 201 && created.status !== 200) throw new Error(`matrix failed: ${created.status} ${JSON.stringify(created.body)}`);
    const matrixId = (created.body as { id: string }).id;
    const addCell = async (body: Record<string, unknown>): Promise<void> => {
      const r = await http(app).post(`/api/v1/exam-matrices/${matrixId}/cells`).set(bearer(admin)).send(body);
      if (r.status !== 201 && r.status !== 200) throw new Error(`cell failed: ${r.status} ${JSON.stringify(r.body)}`);
    };
    await addCell({ curriculumNodeId: lessonId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 5, cellScore: 5 });
    await addCell({ curriculumNodeId: lessonId, cognitiveLevel: 'hieu', qtype: 'multichoice', questionCount: 2, cellScore: 2 });

    const availability = await quiz.matrixAvailability(adminId, matrixId);
    expect(availability.matrixId).toBe(matrixId);
    expect(availability.cells).toHaveLength(2);
    const biet = availability.cells.find((c) => c.required === 5)!;
    const hieu = availability.cells.find((c) => c.required === 2)!;
    expect(biet.available).toBe(5);
    expect(biet.deficit).toBe(0);
    expect(hieu.available).toBe(1);
    expect(hieu.deficit).toBe(1);
    expect(availability.sufficient).toBe(false);
  });
});
