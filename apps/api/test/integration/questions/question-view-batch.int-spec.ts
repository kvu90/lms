import { randomUUID } from 'node:crypto';
import { NotFoundException, type INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ADMIN, adminToken, assignRole, createContextViaApi, createTestApp, createUserViaApi, http, login, roleIdByShortname, systemContextId,
} from '../../support/identity-access-helpers';
import { QuestionsRepository } from '@lms/db/repositories/questions';
import { QuestionsService } from '../../../src/modules/questions/questions.service';
import { questionBankEntries } from '../../../src/db/schema';

/**
 * Đặc trưng hoá hình dạng QuestionView của ba đường liệt kê câu hỏi
 * (issue #488, điểm DL-01): `listQuestions`,
 * `listQuestionsByCurriculumFilter` và bản có cổng đọc
 * `listQuestionsByCurriculumFilterForViewer`.
 *
 * Ba đường này lắp view từng câu bằng một vòng lặp await tại thời điểm
 * viết đặc trưng hoá. Test này ghim HÀNH VI đang có — tập câu trả về,
 * thứ tự, và hình dạng đầy đủ của từng view (answers theo thứ tự lưu,
 * options theo dạng câu, bản ghi phía đáp án, ngữ liệu, version mới
 * nhất) — bằng cách đối chiếu từng view của đường liệt kê với
 * `getQuestion` của chính câu đó (đường đọc đơn không đổi) cộng các
 * khẳng định cụ thể theo từng dạng câu. Refactor sang loader theo lô
 * phải giữ test này xanh nguyên vẹn; đổi hình dạng/thứ tự/quyền ở bất
 * kỳ đường nào là test phải đỏ.
 */
describe('Đặc trưng hoá view của các đường liệt kê câu hỏi (issue #488)', () => {
  let app: INestApplication;
  let admin: string;
  let adminId: string;
  let questions: QuestionsService;
  let repo: QuestionsRepository;

  let catMain = '';
  let lessonId = '';
  let mcId = '';
  let saId = '';
  let essayId = '';
  let tfId = '';
  let editedId = '';
  let courseMcId = '';
  let stimulusId = '';
  let teacherId = '';
  let strangerId = '';

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    adminId = (await login(app, ADMIN.username, ADMIN.password)).userId;
    questions = app.get(QuestionsService);
    repo = app.get(QuestionsRepository);
    const sysCtx = await systemContextId(app, admin);

    // Context mức khoá học: giáo viên được gán vai editingteacher CHỈ
    // tại context này — có question:useall tại đó, không có tại context
    // hệ thống. Đây là mốc quyền cho bản ForViewer.
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
    catMain = await mkCategory('View batch main', sysCtx);
    const catCourse = await mkCategory('View batch course', courseCtx.id);

    // Chương trình tối thiểu: môn → chương trình → chủ đề → ĐVK → 2 YCCĐ.
    const subj = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: sysCtx, name: 'Toán học', slug: `toan-view-${Date.now()}` });
    const subjectId = subj.body.id as string;
    const curr = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 10 });
    const curriculumId = curr.body.id as string;
    const topic = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, title: 'Chủ đề view', kind: 'topic' });
    const lesson = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: topic.body.id as string, title: 'ĐVK view', kind: 'lesson' });
    lessonId = lesson.body.id as string;
    const mkOutcome = async (content: string): Promise<string> => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({ nodeId: lessonId, content });
      if (r.status !== 201 && r.status !== 200) throw new Error(`outcome failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.id as string;
    };
    const outcomeBiet = await mkOutcome('YCCĐ mức biết của ĐVK view.');
    const outcomeHieu = await mkOutcome('YCCĐ mức hiểu của ĐVK view.');

    const stim = await http(app).post('/api/v1/stimuli').set(bearer(admin))
      .send({ categoryId: catMain, content: 'Ngữ liệu chung cho câu Đúng–Sai.' });
    if (stim.status !== 201 && stim.status !== 200) throw new Error(`stimulus failed: ${stim.status} ${JSON.stringify(stim.body)}`);
    stimulusId = stim.body.id as string;

    const mkQuestion = async (categoryId: string, body: Record<string, unknown>): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set(bearer(admin)).send({ categoryId, ...body });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return (r.body as { question: { id: string } }).question.id;
    };
    const fourAnswers = [
      { text: 'Đúng', correct: true }, { text: 'Sai', correct: false },
      { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false },
    ];
    mcId = await mkQuestion(catMain, {
      qtype: 'multichoice', questionText: 'MC view: chọn đáp án đúng.', defaultMark: 1,
      answers: fourAnswers, options: { shuffleAnswers: false },
    });
    saId = await mkQuestion(catMain, {
      qtype: 'shortanswer', questionText: 'SA view: con ếch tiếng Anh là gì?', defaultMark: 1,
      answers: [{ text: 'frog', correct: true }, { text: 'toad', correct: true }],
      options: { useCase: true },
    });
    essayId = await mkQuestion(catMain, {
      qtype: 'essay', questionText: 'Essay view: phân tích một vấn đề.', defaultMark: 1,
      guidance: 'Đọc kỹ yêu cầu trước khi viết.',
      solution: { answer: 'Ba ý chính cần triển khai.' },
      options: { responseFormat: 'editor', responseFieldLines: 20, minWordLimit: 10, maxWordLimit: 500 },
    });
    const tfCorrects = [true, false, true, false];
    tfId = await mkQuestion(catMain, {
      qtype: 'truefalse', defaultMark: 1, stimulusId,
      questionText: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Ngữ liệu chung cho câu Đúng–Sai.' }] },
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
    editedId = await mkQuestion(catMain, {
      qtype: 'multichoice', questionText: 'Câu sắp sửa — version 1.', defaultMark: 1, answers: fourAnswers,
    });
    const edit = await http(app).patch(`/api/v1/questions/${editedId}`).set(bearer(admin)).send({ questionText: 'Câu đã sửa — version 2.' });
    if (edit.status !== 200) throw new Error(`edit failed: ${edit.status} ${JSON.stringify(edit.body)}`);
    courseMcId = await mkQuestion(catCourse, {
      qtype: 'multichoice', questionText: 'MC view ở category khoá học.', defaultMark: 1, answers: fourAnswers,
    });

    const tag = async (questionId: string, outcomeId: string, level: string): Promise<void> => {
      const r = await http(app).post(`/api/v1/questions/${questionId}/outcomes`).set(bearer(admin))
        .send({ outcomeId, cognitiveLevel: level });
      if (r.status !== 201 && r.status !== 200) throw new Error(`tag failed: ${r.status} ${JSON.stringify(r.body)}`);
    };
    await tag(mcId, outcomeBiet, 'biet');
    await tag(saId, outcomeBiet, 'biet');
    await tag(essayId, outcomeHieu, 'hieu');
    await tag(courseMcId, outcomeBiet, 'biet');
  });
  afterAll(async () => { await app.close(); });

  it('listQuestions trả mọi câu của category theo thứ tự id và mỗi view trùng khớp hoàn toàn với getQuestion của chính câu đó', async () => {
    const views = await questions.listQuestions(catMain);
    const expectedIds = [mcId, saId, essayId, tfId, editedId].sort();
    expect(views.map((v) => v.question.id)).toEqual(expectedIds);
    for (const view of views) {
      expect(view).toEqual(await questions.getQuestion(view.question.id));
    }
  });

  it('view của từng dạng câu mang đúng answers, options, bản ghi phía đáp án và ngữ liệu đã gắn', async () => {
    const views = await questions.listQuestions(catMain);
    const byId = new Map(views.map((v) => [v.question.id, v]));

    const mc = byId.get(mcId)!;
    expect(mc.answers).toHaveLength(4);
    expect(mc.answers.map((a) => a.isCorrect)).toEqual([true, false, false, false]);
    expect(mc.options).toMatchObject({ shuffleAnswers: false });
    expect(mc.answerKey).toEqual({ guidance: null, solution: null });
    expect(mc.stimulus).toBeNull();

    const sa = byId.get(saId)!;
    expect(sa.answers).toHaveLength(2);
    expect(sa.answers.every((a) => a.isCorrect)).toBe(true);
    expect(sa.options).toMatchObject({ useCase: true });

    const essay = byId.get(essayId)!;
    expect(essay.answers).toHaveLength(0);
    expect(essay.options).toMatchObject({ responseFieldLines: 20, minWordLimit: 10, maxWordLimit: 500 });
    expect(essay.answerKey.guidance).not.toBeNull();
    expect(essay.answerKey.solution).not.toBeNull();

    const tf = byId.get(tfId)!;
    expect(tf.stimulus?.id).toBe(stimulusId);
    expect(tf.options).toBeNull();
    expect(tf.answerKey.solution).toMatchObject({
      answers: [
        { statementId: 's1', value: true }, { statementId: 's2', value: false },
        { statementId: 's3', value: true }, { statementId: 's4', value: false },
      ],
    });
  });

  it('view của câu đã sửa mang version mới nhất (version 2) chứ không mang version đầu', async () => {
    const views = await questions.listQuestions(catMain);
    const edited = views.find((v) => v.question.id === editedId)!;
    expect(edited.entry.latestVersion).toBe(2);
    expect(edited.latestVersion.version).toBe(2);
    expect(edited).toEqual(await questions.getQuestion(editedId));
  });

  it('listQuestionsByCurriculumFilter trả đúng tập câu gắn với ĐVK ở mức đã lọc và mỗi view trùng khớp getQuestion', async () => {
    const views = await questions.listQuestionsByCurriculumFilter({ nodeId: lessonId, cognitiveLevel: 'biet' });
    expect(views.map((v) => v.question.id).sort()).toEqual([mcId, saId, courseMcId].sort());
    for (const view of views) {
      expect(view).toEqual(await questions.getQuestion(view.question.id));
    }
    const hieu = await questions.listQuestionsByCurriculumFilter({ nodeId: lessonId, cognitiveLevel: 'hieu' });
    expect(hieu.map((v) => v.question.id)).toEqual([essayId]);
  });

  it('bản ForViewer chỉ trả câu thuộc category mà người đọc có quyền dùng ngân hàng tại context của category', async () => {
    const filter = { nodeId: lessonId, cognitiveLevel: 'biet' };
    const forAdmin = await questions.listQuestionsByCurriculumFilterForViewer(adminId, filter);
    expect(forAdmin.map((v) => v.question.id).sort()).toEqual([mcId, saId, courseMcId].sort());
    // Giáo viên chỉ có question:useall tại context khoá học: chỉ thấy
    // câu của category khoá học, câu ở context hệ thống bị loại hẳn.
    const forTeacher = await questions.listQuestionsByCurriculumFilterForViewer(teacherId, filter);
    expect(forTeacher.map((v) => v.question.id)).toEqual([courseMcId]);
    const forStranger = await questions.listQuestionsByCurriculumFilterForViewer(strangerId, filter);
    expect(forStranger).toEqual([]);
  });

  it('entry có nhiều version: loader theo lô chỉ trả đúng version mới nhất, không kèm version cũ', async () => {
    const sysCtx = await systemContextId(app, admin);
    const catR = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: 'View batch multi-version', contextId: sysCtx });
    if (catR.status !== 201 && catR.status !== 200) throw new Error(`category failed: ${catR.status} ${JSON.stringify(catR.body)}`);
    const catId = catR.body.id as string;
    const fourAnswers = [
      { text: 'Đúng', correct: true }, { text: 'Sai', correct: false },
      { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false },
    ];
    const created = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId: catId, qtype: 'multichoice', questionText: 'Câu nhiều version — bản 1.', defaultMark: 1, answers: fourAnswers,
    });
    if (created.status !== 201 && created.status !== 200) throw new Error(`question failed: ${created.status} ${JSON.stringify(created.body)}`);
    const qid = (created.body as { question: { id: string } }).question.id;
    // Sửa hai lượt nữa → entry tích đủ 3 version, con trỏ mới nhất ở 3.
    for (const text of ['Câu nhiều version — bản 2.', 'Câu nhiều version — bản 3.']) {
      const r = await http(app).patch(`/api/v1/questions/${qid}`).set(bearer(admin)).send({ questionText: text });
      if (r.status !== 200) throw new Error(`edit failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const entry = await repo.getEntryByQuestion(qid);
    expect(entry?.latestVersion).toBe(3);
    // Hàm nạp version theo lô trả đúng MỘT dòng — version 3 — dù entry
    // có hai version cũ nằm cùng bảng.
    const rows = await repo.getLatestVersionsByEntries([entry!]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(3);
    // View của đường liệt kê mang đúng version đó và khớp đường đọc đơn.
    const views = await questions.listQuestions(catId);
    expect(views).toHaveLength(1);
    expect(views[0]?.latestVersion.version).toBe(3);
    expect(views[0]).toEqual(await questions.getQuestion(qid));
  });

  it('entry thiếu dòng version mới nhất: đường liệt kê theo lô ném đúng mã question.version_missing như đường đọc đơn', async () => {
    const sysCtx = await systemContextId(app, admin);
    const catR = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: 'View batch missing version', contextId: sysCtx });
    if (catR.status !== 201 && catR.status !== 200) throw new Error(`category failed: ${catR.status} ${JSON.stringify(catR.body)}`);
    const catId = catR.body.id as string;
    const created = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId: catId, qtype: 'multichoice', questionText: 'Câu thiếu version mới nhất.', defaultMark: 1,
      answers: [
        { text: 'Đúng', correct: true }, { text: 'Sai', correct: false },
        { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false },
      ],
    });
    if (created.status !== 201 && created.status !== 200) throw new Error(`question failed: ${created.status} ${JSON.stringify(created.body)}`);
    const qid = (created.body as { question: { id: string } }).question.id;
    const entry = await repo.getEntryByQuestion(qid);
    // Trỏ con trỏ version mới nhất tới số version không có dòng nào:
    // dữ kiện hỏng mà cả hai đường đọc đều phải báo cùng một mã lỗi.
    await repo.dbHandle.update(questionBankEntries).set({ latestVersion: 99 })
      .where(eq(questionBankEntries.id, entry!.id));
    const brokenEntry = await repo.getEntryByQuestion(qid);
    expect(brokenEntry?.latestVersion).toBe(99);
    // Hàm nạp version theo lô không bịa dòng nào cho entry này.
    expect(await repo.getLatestVersionsByEntries([brokenEntry!])).toEqual([]);
    const fromBatch = await questions.listQuestions(catId).then(() => null, (e: unknown) => e);
    expect(fromBatch).toBeInstanceOf(NotFoundException);
    expect((fromBatch as NotFoundException).getResponse()).toMatchObject({ code: 'question.version_missing' });
    const fromSingle = await questions.getQuestion(qid).then(() => null, (e: unknown) => e);
    expect(fromSingle).toBeInstanceOf(NotFoundException);
    expect((fromSingle as NotFoundException).getResponse()).toMatchObject({ code: 'question.version_missing' });
  });
});
