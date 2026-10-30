import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';

/**
 * Issue #123 — siết riêng tư ngân hàng CÁ NHÂN ở tầng QB:
 *
 * Ngân hàng riêng của từng giáo viên là khu vực riêng ("của tôi").
 * Trước lát này, cổng đọc chỉ dựa `question:useall` tại context bank —
 * context bank personal là con của context hệ thống nên GV staff khác
 * kế thừa quyền xuống bank personal của đồng nghiệp: listBanks liệt kê
 * bank personal của GV khác (mọi kind), GET chi tiết bank trả 200, đọc
 * được câu/attribution/ma trận trong bank riêng của đồng nghiệp ở cả
 * REST lẫn MCP (bằng chứng phán quyết MCP-0 6391128869 + EB-1
 * 6391268932).
 *
 * Ma trận ca của spec này:
 *  - Chủ sở hữu: 200/201 mọi đường (bank, câu, category, attribution,
 *    ma trận, bank ma trận).
 *  - GV staff khác: bank personal của đồng nghiệp KHÔNG xuất hiện
 *    trong listBanks (question/exam/matrix); mọi đường đọc thẳng theo
 *    id → 404; copy nguồn thuộc bank personal của đồng nghiệp → 403;
 *    khám phá không rò câu.
 *  - Học sinh: 404 các đường đọc bank personal.
 *  - Bank trường/tổ: hành vi KHÔNG đổi (GV trường đọc được bank trường;
 *    thành viên tổ đọc được bank tổ).
 *  - Khuôn UI "bank personal đầu tiên trong listBanks" còn đúng: bank
 *    personal duy nhất trong danh sách của mỗi GV là của chính họ.
 * Site admin giữ toàn quyền như bất biến hiện hành (khớp MB-1 E-8).
 *
 * VÒNG 2 (phán quyết đánh giá 6392040333 — điểm chặn sườn GHI): spec
 * vòng 1 dùng archetype `teacher` (không có question:add/editall) nên
 * mù lỗ hổng ghi — đồng nghiệp archetype `editingteacher` kế thừa
 * add/editall/managecategory từ context hệ thống xuống bank personal
 * của người khác, sửa/xoá/chen được nội dung. Vòng 2 khoá bằng cổng
 * ghi chủ sở hữu ở QuestionsService (+ phía nguồn của đóng góp):
 *  - editingteacher khác: PATCH câu, POST câu/stimulus vào category
 *    của đồng nghiệp, PATCH/DELETE stimulus, gắn/gỡ subject + YCCĐ,
 *    tạo category trong bank của đồng nghiệp, đề xuất đóng góp bằng
 *    câu của đồng nghiệp → 404 (mã not-found của chính tài nguyên).
 *  - Chủ sở hữu editingteacher + site admin: ghi bình thường.
 *  - Bank trường: editingteacher không phải chủ câu vẫn ghi theo
 *    capability như cũ (cổng chỉ áp bank personal).
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; name: string; scope: string; bankKind: string; ownerId: string | null;
  contextId: string; defaultCategoryId: string | null;
}
interface QuestionViewBody {
  question: { id: string; category: string; createdBy: string };
  entry: { id: string; status: string };
}

describe('Riêng tư cá nhân của ngân hàng (issue #123)', () => {
  let app: INestApplication;
  let admin: string;

  let teacherA: { id: string; username: string; token: string };
  let teacherB: { id: string; username: string; token: string };
  let teacherC: { id: string; username: string; token: string };
  let student: { id: string; username: string; token: string };

  // Vòng 2: cặp editingteacher (có add/editall thật) — nạn nhân + kẻ tấn công.
  let editorA: { id: string; username: string; token: string };
  let editorB: { id: string; username: string; token: string };
  let bankEA: BankBody;
  let catEA: string;
  let questionEA: QuestionViewBody;
  let stimEA: string;
  let linkSubjectId: string;
  let linkSubject2Id: string;
  let linkOutcomeId: string;

  let bankA: BankBody;
  let catA: string;
  let questionA: QuestionViewBody;
  let examBankA: BankBody;
  let matrixBankA: BankBody;
  let matrixAId: string;
  let schoolBank: BankBody;
  let questionSchool: QuestionViewBody;
  let teamBank: BankBody;
  let questionTeam: QuestionViewBody;

  const SECRET_TEXT = 'PRIV123-SECRET-QUESTION-TEXT';

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Giáo viên: vai teacher tại context hệ thống (nhóm archetype staff). */
  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  /** GV archetype editingteacher — vai Teacher thật, CÓ question:add/editall/managecategory. */
  async function mkEditorUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'editingteacher'), await systemContextId(app, admin));
    return u;
  }

  async function listBanks(token: string, kind?: string): Promise<BankBody[]> {
    const res = await http(app).get(`/api/v1/question-banks${kind ? `?kind=${kind}` : ''}`).set(bearer(token));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as BankBody[];
  }

  async function createQuestion(token: string, categoryId: string, name: string, text: string): Promise<QuestionViewBody> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'multichoice', questionText: text,
      answers: [{ text: 'Đáp án đúng', correct: true }, { text: 'Đáp án sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as QuestionViewBody;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    teacherA = await mkStaffUser();
    teacherB = await mkStaffUser();
    teacherC = await mkStaffUser();
    student = await mkUser();

    // Bank personal (kind question) của A + một câu riêng.
    const banksA = await listBanks(teacherA.token);
    bankA = banksA.find((b) => b.scope === 'personal')!;
    expect(bankA).toBeTruthy();
    expect(bankA.ownerId).toBe(teacherA.id);
    catA = bankA.defaultCategoryId!;
    questionA = await createQuestion(teacherA.token, catA, 'Câu riêng của A', SECRET_TEXT);

    // Bank personal kind exam + kind matrix của A (tạo lười qua list).
    examBankA = (await listBanks(teacherA.token, 'exam')).find((b) => b.scope === 'personal')!;
    expect(examBankA).toBeTruthy();
    matrixBankA = (await listBanks(teacherA.token, 'matrix')).find((b) => b.scope === 'personal')!;
    expect(matrixBankA).toBeTruthy();

    // Ma trận riêng của A trong bank ma trận personal của A.
    const systemCtxId = await systemContextId(app, admin);
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: uniqueName('Toán 123'), slug: `toan-123-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(subjRes.status, JSON.stringify(subjRes.body)).toBe(201);
    const subjectId = (subjRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 9 });
    expect(currRes.status, JSON.stringify(currRes.body)).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;
    const matrixRes = await http(app).post('/api/v1/exam-matrices').set(bearer(teacherA.token)).send({
      name: 'Ma trận riêng của A', subjectId, curriculumId, bankId: matrixBankA.id, status: 'ready',
    });
    expect(matrixRes.status, JSON.stringify(matrixRes.body)).toBe(201);
    matrixAId = (matrixRes.body as { id: string }).id;

    // Bank trường + câu chung của trường (A tạo).
    schoolBank = banksA.find((b) => b.scope === 'school')!;
    expect(schoolBank).toBeTruthy();
    questionSchool = await createQuestion(teacherA.token, schoolBank.defaultCategoryId!, 'Câu của trường', 'Câu hỏi chung của trường?');

    // Bank tổ (cohort gồm A + C), A là tổ trưởng, một câu của tổ.
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ 123') });
    expect(cohortRes.status, JSON.stringify(cohortRes.body)).toBe(201);
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [teacherA, teacherC]) {
      const add = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: u.id });
      expect(add.status).toBe(201);
    }
    const teamRes = await http(app).post('/api/v1/question-banks').set(bearer(teacherA.token))
      .send({ name: 'Ngân hàng tổ 123', scope: 'team', scopeRefId: cohortId, leaderId: teacherA.id });
    expect(teamRes.status, JSON.stringify(teamRes.body)).toBe(201);
    teamBank = teamRes.body as BankBody;
    questionTeam = await createQuestion(teacherA.token, teamBank.defaultCategoryId!, 'Câu của tổ', 'Câu hỏi của tổ chuyên môn?');

    // --- Vòng 2: fixtures editingteacher -------------------------------------
    editorA = await mkEditorUser();
    editorB = await mkEditorUser();
    bankEA = (await listBanks(editorA.token)).find((b) => b.scope === 'personal')!;
    expect(bankEA).toBeTruthy();
    expect(bankEA.ownerId).toBe(editorA.id);
    catEA = bankEA.defaultCategoryId!;
    questionEA = await createQuestion(editorA.token, catEA, 'Câu riêng của editorA', 'PRIV123-EDITOR-SECRET');
    const stimRes = await http(app).post('/api/v1/stimuli').set(bearer(editorA.token))
      .send({ categoryId: catEA, content: 'PRIV123-EDITOR-STIMULUS' });
    expect(stimRes.status, JSON.stringify(stimRes.body)).toBe(201);
    stimEA = (stimRes.body as { id: string }).id;

    // Môn + YCCĐ cho các ca gắn/gỡ link trên câu của editorA.
    const mkSubject = async (label: string): Promise<string> => {
      const res = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
        .send({ contextId: systemCtxId, name: uniqueName(label), slug: `priv123-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return (res.body as { id: string }).id;
    };
    linkSubjectId = await mkSubject('Môn link 123');
    linkSubject2Id = await mkSubject('Môn link 123 phụ');
    const curr2Res = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId: linkSubjectId, grade: 9 });
    expect(curr2Res.status, JSON.stringify(curr2Res.body)).toBe(201);
    const nodeRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId: (curr2Res.body as { id: string }).id, parentId: null, title: 'Mạch link 123', kind: 'strand' });
    expect(nodeRes.status, JSON.stringify(nodeRes.body)).toBe(201);
    const outcomeRes = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
      .send({ nodeId: (nodeRes.body as { id: string }).id, content: 'YCCĐ cho ca gắn link 123.' });
    expect(outcomeRes.status, JSON.stringify(outcomeRes.body)).toBe(201);
    linkOutcomeId = (outcomeRes.body as { id: string }).id;
    // Chủ sở hữu gắn sẵn subject + outcome — nền cho các ca gỡ trái phép ở vòng 2.
    const attachSubj = await http(app).post(`/api/v1/questions/${questionEA.question.id}/subjects`)
      .set(bearer(editorA.token)).send({ subjectId: linkSubjectId });
    expect(attachSubj.status, JSON.stringify(attachSubj.body)).toBe(201);
    const attachOut = await http(app).post(`/api/v1/questions/${questionEA.question.id}/outcomes`)
      .set(bearer(editorA.token)).send({ outcomeId: linkOutcomeId, cognitiveLevel: 'biet' });
    expect(attachOut.status, JSON.stringify(attachOut.body)).toBe(201);
  });
  afterAll(async () => { await app.close(); });

  it('chủ sở hữu giữ toàn quyền trên bank personal của mình', async () => {
    const bank = await http(app).get(`/api/v1/question-banks/${bankA.id}`).set(bearer(teacherA.token));
    expect(bank.status).toBe(200);
    const q = await http(app).get(`/api/v1/questions/${questionA.question.id}`).set(bearer(teacherA.token));
    expect(q.status).toBe(200);
    const inCat = await http(app).get(`/api/v1/questions/categories/${catA}/questions`).set(bearer(teacherA.token));
    expect(inCat.status).toBe(200);
    expect(JSON.stringify(inCat.body)).toContain(questionA.question.id);
    const attr = await http(app).get(`/api/v1/questions/${questionA.question.id}/attribution`).set(bearer(teacherA.token));
    expect(attr.status).toBe(200);
    const versions = await http(app).get(`/api/v1/questions/${questionA.question.id}/versions`).set(bearer(teacherA.token));
    expect(versions.status).toBe(200);
    const matrix = await http(app).get(`/api/v1/exam-matrices/${matrixAId}`).set(bearer(teacherA.token));
    expect(matrix.status).toBe(200);
    const bankMatrices = await http(app).get(`/api/v1/question-banks/${matrixBankA.id}/matrices`).set(bearer(teacherA.token));
    expect(bankMatrices.status).toBe(200);
    expect(JSON.stringify(bankMatrices.body)).toContain(matrixAId);
  });

  it('listBanks: GV khác không thấy bank personal của đồng nghiệp ở mọi kind; bank personal duy nhất trong list là của chính mình', async () => {
    for (const [kind, foreign] of [['question', bankA.id], ['exam', examBankA.id], ['matrix', matrixBankA.id]] as const) {
      const banks = await listBanks(teacherB.token, kind);
      expect(banks.some((b) => b.id === foreign), `kind=${kind}`).toBe(false);
      const personals = banks.filter((b) => b.scope === 'personal');
      expect(personals).toHaveLength(1);
      expect(personals[0]!.ownerId).toBe(teacherB.id);
    }
    // Danh sách mặc định (kind question) cũng sạch.
    const banks = await listBanks(teacherB.token);
    expect(banks.some((b) => b.id === bankA.id)).toBe(false);
  });

  it('GV khác đọc thẳng theo id: 404 ở mọi bề mặt, không lộ nội dung', async () => {
    const attempts: [string, string][] = [
      ['chi tiết bank', `/api/v1/question-banks/${bankA.id}`],
      ['chi tiết bank exam', `/api/v1/question-banks/${examBankA.id}`],
      ['chi tiết bank ma trận', `/api/v1/question-banks/${matrixBankA.id}`],
      ['hàng chờ đóng góp của bank', `/api/v1/question-banks/${bankA.id}/contributions`],
      ['chi tiết câu', `/api/v1/questions/${questionA.question.id}`],
      ['versions của câu', `/api/v1/questions/${questionA.question.id}/versions`],
      ['attribution của câu', `/api/v1/questions/${questionA.question.id}/attribution`],
      ['câu trong category', `/api/v1/questions/categories/${catA}/questions`],
      ['category theo context bank', `/api/v1/questions/categories?contextId=${bankA.contextId}`],
      ['ma trận trong bank personal', `/api/v1/exam-matrices/${matrixAId}`],
      ['danh sách ma trận của bank personal', `/api/v1/question-banks/${matrixBankA.id}/matrices`],
    ];
    for (const [label, url] of attempts) {
      const res = await http(app).get(url).set(bearer(teacherB.token));
      expect(res.status, label).toBe(404);
      expect(JSON.stringify(res.body), label).not.toContain(SECRET_TEXT);
    }
    // Mã lỗi của chi tiết bank đúng mã not-found hiện hành.
    const bankRes = await http(app).get(`/api/v1/question-banks/${bankA.id}`).set(bearer(teacherB.token));
    expect((bankRes.body as { code?: string }).code).toBe('question.bank_not_found');
  });

  it('GV khác không copy được câu thuộc bank personal của đồng nghiệp; khám phá không rò câu riêng', async () => {
    const copy = await http(app).post(`/api/v1/questions/${questionA.question.id}/copy`).set(bearer(teacherB.token)).send({});
    expect(copy.status).toBe(403);
    const discovery = await http(app).get('/api/v1/questions/discovery').set(bearer(teacherB.token));
    expect(discovery.status).toBe(200);
    expect(JSON.stringify(discovery.body)).not.toContain(questionA.question.id);
    expect(JSON.stringify(discovery.body)).not.toContain(SECRET_TEXT);
  });

  it('học sinh: 404 các đường đọc bank personal của giáo viên', async () => {
    const bank = await http(app).get(`/api/v1/question-banks/${bankA.id}`).set(bearer(student.token));
    expect(bank.status).toBe(404);
    const q = await http(app).get(`/api/v1/questions/${questionA.question.id}`).set(bearer(student.token));
    expect(q.status).toBe(404);
    const banks = await listBanks(student.token);
    expect(banks.some((b) => b.id === bankA.id)).toBe(false);
  });

  it('bank trường + bank tổ giữ nguyên hành vi cho GV khác/thành viên', async () => {
    // GV khác (không phải chủ) vẫn đọc được bank trường + câu của trường.
    const school = await http(app).get(`/api/v1/question-banks/${schoolBank.id}`).set(bearer(teacherB.token));
    expect(school.status).toBe(200);
    const qSchool = await http(app).get(`/api/v1/questions/${questionSchool.question.id}`).set(bearer(teacherB.token));
    expect(qSchool.status).toBe(200);
    const banksB = await listBanks(teacherB.token);
    expect(banksB.some((b) => b.id === schoolBank.id)).toBe(true);
    // Thành viên tổ vẫn đọc được bank tổ + câu của tổ.
    const team = await http(app).get(`/api/v1/question-banks/${teamBank.id}`).set(bearer(teacherC.token));
    expect(team.status).toBe(200);
    const qTeam = await http(app).get(`/api/v1/questions/${questionTeam.question.id}`).set(bearer(teacherC.token));
    expect(qTeam.status).toBe(200);
  });

  it('vòng 2: editingteacher khác KHÔNG ghi được vào bank personal của đồng nghiệp (câu/stimulus/category/link/đóng góp)', async () => {
    const qid = questionEA.question.id;
    // PATCH câu của đồng nghiệp → 404 question.not_found, câu còn nguyên.
    const patch = await http(app).patch(`/api/v1/questions/${qid}`).set(bearer(editorB.token))
      .send({ questionText: 'PRIV123-HACKED-TEXT' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(404);
    expect((patch.body as { code?: string }).code).toBe('question.not_found');
    const still = await http(app).get(`/api/v1/questions/${qid}`).set(bearer(editorA.token));
    expect(still.status).toBe(200);
    // Câu còn nguyên: thân câu vẫn là nội dung gốc, không có dấu vết
    // của lần PATCH lạ (câu hỏi không còn trường tên — bất biến kiểm
    // trên chính nội dung thân câu).
    expect(JSON.stringify(still.body)).toContain('PRIV123-EDITOR-SECRET');
    expect(JSON.stringify(still.body)).not.toContain('PRIV123-HACKED-TEXT');
    expect((still.body as { entry: { latestVersion: number } }).entry.latestVersion).toBe(1);

    // POST câu vào category của đồng nghiệp → 404 question.category_not_found, không chèn được.
    const create = await http(app).post('/api/v1/questions').set(bearer(editorB.token)).send({
      categoryId: catEA, qtype: 'multichoice', questionText: 'injected',
      answers: [{ text: 'x', correct: true }, { text: 'y', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    expect(create.status, JSON.stringify(create.body)).toBe(404);
    expect((create.body as { code?: string }).code).toBe('question.category_not_found');
    const inCat = await http(app).get(`/api/v1/questions/categories/${catEA}/questions`).set(bearer(editorA.token));
    expect(JSON.stringify(inCat.body)).not.toContain('Câu lạ chèn vào bank editorA');

    // POST/PATCH/DELETE stimulus trong bank của đồng nghiệp → 404.
    const createStim = await http(app).post('/api/v1/stimuli').set(bearer(editorB.token))
      .send({ categoryId: catEA, content: 'stimulus lạ' });
    expect(createStim.status, JSON.stringify(createStim.body)).toBe(404);
    const patchStim = await http(app).patch(`/api/v1/stimuli/${stimEA}`).set(bearer(editorB.token))
      .send({ content: 'PRIV123-HACKED-STIMULUS' });
    expect(patchStim.status, JSON.stringify(patchStim.body)).toBe(404);
    expect((patchStim.body as { code?: string }).code).toBe('stimulus.not_found');
    const delStim = await http(app).delete(`/api/v1/stimuli/${stimEA}`).set(bearer(editorB.token));
    expect(delStim.status, JSON.stringify(delStim.body)).toBe(404);
    const stimStill = await http(app).get(`/api/v1/stimuli/${stimEA}`).set(bearer(editorA.token));
    expect(stimStill.status).toBe(200);

    // Gắn/gỡ subject + YCCĐ trên câu của đồng nghiệp → 404 mọi đường, link còn nguyên.
    const attachSubj = await http(app).post(`/api/v1/questions/${qid}/subjects`).set(bearer(editorB.token))
      .send({ subjectId: linkSubject2Id });
    expect(attachSubj.status, JSON.stringify(attachSubj.body)).toBe(404);
    const detachSubj = await http(app).delete(`/api/v1/questions/${qid}/subjects/${linkSubjectId}`).set(bearer(editorB.token));
    expect(detachSubj.status, JSON.stringify(detachSubj.body)).toBe(404);
    const attachOut = await http(app).post(`/api/v1/questions/${qid}/outcomes`).set(bearer(editorB.token))
      .send({ outcomeId: linkOutcomeId, cognitiveLevel: 'hieu' });
    expect(attachOut.status, JSON.stringify(attachOut.body)).toBe(404);
    const patchOut = await http(app).patch(`/api/v1/questions/${qid}/outcomes/${linkOutcomeId}`).set(bearer(editorB.token))
      .send({ cognitiveLevel: 'van_dung' });
    expect(patchOut.status, JSON.stringify(patchOut.body)).toBe(404);
    const detachOut = await http(app).delete(`/api/v1/questions/${qid}/outcomes/${linkOutcomeId}`).set(bearer(editorB.token));
    expect(detachOut.status, JSON.stringify(detachOut.body)).toBe(404);
    const links = await http(app).get(`/api/v1/questions/${qid}/curriculum-links`).set(bearer(editorA.token));
    expect(links.status).toBe(200);
    expect((links.body as { subjectIds: string[] }).subjectIds).toContain(linkSubjectId);
    expect((links.body as { outcomes: { outcomeId: string }[] }).outcomes.map((o) => o.outcomeId)).toContain(linkOutcomeId);

    // Tạo category trong bank của đồng nghiệp (tường minh bankId + ngầm qua context) → 404 bank_not_found.
    const catExplicit = await http(app).post('/api/v1/questions/categories').set(bearer(editorB.token))
      .send({ name: 'Category lạ', contextId: bankEA.contextId, bankId: bankEA.id });
    expect(catExplicit.status, JSON.stringify(catExplicit.body)).toBe(404);
    expect((catExplicit.body as { code?: string }).code).toBe('question.bank_not_found');
    const catImplicit = await http(app).post('/api/v1/questions/categories').set(bearer(editorB.token))
      .send({ name: 'Category lạ 2', contextId: bankEA.contextId });
    expect(catImplicit.status, JSON.stringify(catImplicit.body)).toBe(404);

    // Đề xuất đóng góp bằng câu của đồng nghiệp vào bank trường → 404 question.not_found.
    const contrib = await http(app).post(`/api/v1/question-banks/${schoolBank.id}/contributions`).set(bearer(editorB.token))
      .send({ questionId: qid });
    expect(contrib.status, JSON.stringify(contrib.body)).toBe(404);
    expect((contrib.body as { code?: string }).code).toBe('question.not_found');
  });

  it('vòng 2: chủ sở hữu editingteacher vẫn ghi bình thường trên bank personal của mình', async () => {
    const qid = questionEA.question.id;
    const patch = await http(app).patch(`/api/v1/questions/${qid}`).set(bearer(editorA.token))
      .send({ questionText: 'PRIV123-EDITOR-SECRET (đã sửa)' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    expect((patch.body as { entry: { latestVersion: number } }).entry.latestVersion).toBe(2);
    const stim = await http(app).post('/api/v1/stimuli').set(bearer(editorA.token))
      .send({ categoryId: catEA, content: 'Stimulus vòng đời của editorA' });
    expect(stim.status, JSON.stringify(stim.body)).toBe(201);
    const stimId = (stim.body as { id: string }).id;
    const patchStim = await http(app).patch(`/api/v1/stimuli/${stimId}`).set(bearer(editorA.token))
      .send({ content: 'Stimulus vòng đời của editorA (đã sửa)' });
    expect(patchStim.status, JSON.stringify(patchStim.body)).toBe(200);
    const delStim = await http(app).delete(`/api/v1/stimuli/${stimId}`).set(bearer(editorA.token));
    expect(delStim.status, JSON.stringify(delStim.body)).toBe(200);
    const cat = await http(app).post('/api/v1/questions/categories').set(bearer(editorA.token))
      .send({ name: 'Category riêng của editorA', contextId: bankEA.contextId, bankId: bankEA.id });
    expect(cat.status, JSON.stringify(cat.body)).toBe(201);
    // Gỡ + gắn lại link của chính mình chạy như cũ.
    const detach = await http(app).delete(`/api/v1/questions/${qid}/subjects/${linkSubjectId}`).set(bearer(editorA.token));
    expect(detach.status, JSON.stringify(detach.body)).toBe(200);
    const reattach = await http(app).post(`/api/v1/questions/${qid}/subjects`).set(bearer(editorA.token))
      .send({ subjectId: linkSubjectId });
    expect(reattach.status, JSON.stringify(reattach.body)).toBe(201);
  });

  it('vòng 2: ghi vào bank TRƯỜNG không hồi quy — editingteacher không phải chủ câu vẫn sửa/tạo theo capability', async () => {
    const patch = await http(app).patch(`/api/v1/questions/${questionSchool.question.id}`).set(bearer(editorB.token))
      .send({ questionText: 'Câu hỏi chung của trường (editorB sửa)?' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
    const create = await http(app).post('/api/v1/questions').set(bearer(editorB.token)).send({
      categoryId: schoolBank.defaultCategoryId!, qtype: 'multichoice', 
      questionText: 'Câu hỏi chung do editorB tạo?',
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
  });

  it('vòng 2: site admin vẫn ghi được vào bank personal của giáo viên (ngoại lệ đã được chấp nhận)', async () => {
    const patch = await http(app).patch(`/api/v1/questions/${questionEA.question.id}`).set(bearer(admin))
      .send({ questionText: 'PRIV123-EDITOR-SECRET (admin sửa)' });
    expect(patch.status, JSON.stringify(patch.body)).toBe(200);
  });
});
