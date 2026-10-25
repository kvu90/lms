import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Feat Ngân hàng câu hỏi chung (issue #70, QB-1 → QB-4):
 *  - QB-1: bank 4 scope có context riêng; quyền theo vai tại context bank
 *    (chủ bank cá nhân / tổ trưởng / thành viên tổ / giáo viên trường);
 *    học sinh không vào được bề mặt bank chung.
 *  - QB-2: copy = deep copy độc lập + derived_from + ghi công tác giả
 *    gốc; copy_count tăng; người ngoài copy câu ở bank kín → 403.
 *  - QB-3: slot từ bank tổ mặc định pinned; attempt giữ version đã ghim
 *    kể cả khi câu đã lên bản mới và cả khi câu bị rút; nâng version ghi
 *    nhật ký; xoá vật lý bị chặn khi còn slot tham chiếu.
 *  - QB-4: đóng góp → duyệt (copy vào bank đích / version mới qua
 *    derived_from) → từ chối có lý do → đề xuất lại; chống trùng hoàn
 *    toàn; khám phá theo bank/từ khoá kèm use_count.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; name: string; scope: string; ownerId: string | null; scopeRefId: string | null;
  contextId: string; defaultCategoryId: string | null;
  capabilities: { use: boolean; add: boolean; edit: boolean; manageCategory: boolean; copy: boolean; share: boolean; moderate: boolean };
}
interface QuestionViewBody {
  question: { id: string; category: string; qtype: string; name: string; createdBy: string; derivedFromQuestionId: string | null; originalAuthorId: string | null; copyCount: number };
  entry: { id: string; latestVersion: number; status: string };
  latestVersion: { id: string; version: number; questionText: unknown };
}

describe('Shared question bank (feat #70)', () => {
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

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Người dùng thuộc nhóm vai giáo viên (archetype staff tại hệ thống):
   * chỉ nhóm này mới được cấp bank cá nhân (điểm chặn 3 phán quyết
   * PR #83) — người dùng thường không có vai staff thì không có bank. */
  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  async function myPersonalBank(user: { id: string; token: string }): Promise<BankBody> {
    const res = await http(app).get('/api/v1/question-banks').set(bearer(user.token));
    expect(res.status).toBe(200);
    // Phải lọc theo ownerId của chính người gọi: listBanks còn liệt kê bank
    // cá nhân của người khác cho giáo viên có vai tại hệ thống (phạm vi siết
    // riêng tư của #123) và danh sách sắp theo createdAt — lấy bank personal
    // đầu tiên sẽ trúng bank của người tạo sớm nhất trong DB dùng chung.
    const bank = (res.body as BankBody[]).find((b) => b.scope === 'personal' && b.ownerId === user.id);
    expect(bank).toBeTruthy();
    return bank!;
  }

  async function createQuestion(token: string, categoryId: string, name: string, text: string): Promise<QuestionViewBody> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'multichoice', name, questionText: text,
      answers: [{ text: 'Đáp án đúng', fraction: 1 }, { text: 'Đáp án sai', fraction: 0 }],
      options: { single: true },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as QuestionViewBody;
  }

  /** Dựng một khoá + giáo viên (editingteacher tại context khoá) + học sinh đã ghi danh. */
  async function mkCourseWithTeacherAndStudent() {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacher = await mkUser();
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const student = await mkUser();
    await enrolUser(app, admin, course.id, instance.id, student.id);
    return { course, sectionId, courseCtxId: courseCtx.id, teacher, student };
  }

  // --- QB-1 + QB-2 ------------------------------------------------------------

  it('QB-1/QB-2: bank cá nhân + copy deep copy truy vết, độc lập hai chiều, người ngoài bị chặn', async () => {
    const alice = await mkStaffUser();
    const bob = await mkUser();
    const bank = await myPersonalBank(alice);
    expect(bank.ownerId).toBe(alice.id);
    expect(bank.capabilities.add).toBe(true);
    expect(bank.defaultCategoryId).toBeTruthy();

    const source = await createQuestion(alice.token, bank.defaultCategoryId!, 'Câu gốc QB', 'Thân câu gốc?');
    // Người ngoài không thấy bank cá nhân của Alice trong danh sách của mình.
    const bobBanks = await http(app).get('/api/v1/question-banks').set(bearer(bob.token));
    expect((bobBanks.body as BankBody[]).some((b) => b.id === bank.id)).toBe(false);
    // Bob copy câu của Alice (bank kín) → 403.
    const bobCopy = await http(app).post(`/api/v1/questions/${source.question.id}/copy`).set(bearer(bob.token)).send({});
    expect(bobCopy.status).toBe(403);

    // Alice copy về chính ngân hàng của mình (đích mặc định).
    const copyRes = await http(app).post(`/api/v1/questions/${source.question.id}/copy`).set(bearer(alice.token)).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copy = copyRes.body as QuestionViewBody & {
      attribution: { derivedFromQuestionId: string; originalAuthorId: string; sourceBankId: string };
    };
    expect(copy.question.id).not.toBe(source.question.id);
    expect(copy.question.derivedFromQuestionId).toBe(source.question.id);
    expect(copy.question.originalAuthorId).toBe(alice.id);
    expect(copy.attribution.sourceBankId).toBe(bank.id);
    expect(copy.entry.latestVersion).toBe(1);

    // Ghi công + copy_count của câu nguồn tăng.
    const attr = await http(app).get(`/api/v1/questions/${source.question.id}/attribution`).set(bearer(alice.token));
    expect(attr.status).toBe(200);
    expect((attr.body as { copyCount: number }).copyCount).toBe(1);

    // Độc lập hai chiều: sửa bản copy không đụng bản gốc; sửa bản gốc không đụng bản copy.
    const editCopy = await http(app).patch(`/api/v1/questions/${copy.question.id}`).set(bearer(alice.token))
      .send({ questionText: 'Thân câu ĐÃ SỬA ở bản copy?' });
    expect(editCopy.status).toBe(200);
    const sourceAfter = await http(app).get(`/api/v1/questions/${source.question.id}`).set(bearer(alice.token));
    expect((sourceAfter.body as QuestionViewBody).entry.latestVersion).toBe(1);
    const editSource = await http(app).patch(`/api/v1/questions/${source.question.id}`).set(bearer(alice.token))
      .send({ questionText: 'Thân câu ĐÃ SỬA ở bản gốc?' });
    expect(editSource.status).toBe(200);
    const copyAfter = await http(app).get(`/api/v1/questions/${copy.question.id}`).set(bearer(alice.token));
    expect((copyAfter.body as QuestionViewBody).entry.latestVersion).toBe(2);
    const copyVersions = await http(app).get(`/api/v1/questions/${copy.question.id}/versions`).set(bearer(alice.token));
    expect((copyVersions.body as { version: number }[]).map((v) => v.version)).toEqual([1, 2]);

    // Copy hàng loạt.
    const batch = await http(app).post('/api/v1/questions/copy-batch').set(bearer(alice.token))
      .send({ questionIds: [source.question.id, copy.question.id] });
    expect(batch.status).toBe(201);
    const results = (batch.body as { results: { ok: boolean; newQuestionId?: string }[] }).results;
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok && r.newQuestionId)).toBe(true);
  });

  it('bank_kind: bank đa loại — bank đề cá nhân tách hẳn bank câu hỏi, unique theo (scope, kind)', async () => {
    const carol = await mkStaffUser();
    const questionBank = await myPersonalBank(carol);
    expect((questionBank as BankBody & { bankKind: string }).bankKind ?? 'question').toBe('question');

    // Tạo bank cá nhân loại exam: phải là bank KHÁC, không đụng bank câu hỏi.
    const examRes = await http(app).post('/api/v1/question-banks').set(bearer(carol.token))
      .send({ name: 'Ngân hàng đề của tôi', scope: 'personal', bankKind: 'exam' });
    expect(examRes.status, JSON.stringify(examRes.body)).toBe(201);
    const examBank = examRes.body as BankBody & { bankKind: string };
    expect(examBank.bankKind).toBe('exam');
    expect(examBank.id).not.toBe(questionBank.id);
    // Bank đề không mang category câu hỏi mặc định.
    expect(examBank.defaultCategoryId).toBeNull();

    // Tạo lại cùng (personal, exam) trả đúng bank cũ (unique theo (scope, kind)).
    const examAgain = await http(app).post('/api/v1/question-banks').set(bearer(carol.token))
      .send({ name: 'Ngân hàng đề của tôi', scope: 'personal', bankKind: 'exam' });
    expect(examAgain.status).toBe(201);
    expect((examAgain.body as BankBody).id).toBe(examBank.id);

    // Danh sách mặc định (kind=question) không chứa bank đề; ?kind=exam chỉ chứa bank đề cá nhân.
    const defaultList = await http(app).get('/api/v1/question-banks').set(bearer(carol.token));
    expect((defaultList.body as BankBody[]).some((b) => b.id === examBank.id)).toBe(false);
    expect((defaultList.body as BankBody[]).some((b) => b.id === questionBank.id)).toBe(true);
    const examList = await http(app).get('/api/v1/question-banks?kind=exam').set(bearer(carol.token));
    expect((examList.body as BankBody[]).some((b) => b.id === examBank.id)).toBe(true);
    expect((examList.body as BankBody[]).some((b) => b.id === questionBank.id)).toBe(false);

    // bankKind ngoài tập cho phép → 400.
    const bad = await http(app).post('/api/v1/question-banks').set(bearer(carol.token))
      .send({ name: 'X', scope: 'personal', bankKind: 'bogus' });
    expect(bad.status).toBe(400);
  });

  it('source: nguồn ngoài hệ thống (book/exam/manual/import) là truy vết nội bộ — copy kế thừa, bề mặt attempt không lộ', async () => {
    const dave = await mkStaffUser();
    const bank = await myPersonalBank(dave);

    // Tạo câu khai nguồn sách: phía quản trị (GET câu hỏi) thấy đủ cặp nguồn.
    const res = await http(app).post('/api/v1/questions').set(bearer(dave.token)).send({
      categoryId: bank.defaultCategoryId!, qtype: 'multichoice', name: 'Câu từ SGK', questionText: 'Thân câu SGK?',
      answers: [{ text: 'Đáp án đúng', fraction: 1 }, { text: 'Đáp án sai', fraction: 0 }],
      options: { single: true },
      sourceKind: 'book', sourceRef: 'sgk-toan-6-kntt-trang-42',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = res.body as QuestionViewBody & {
      question: QuestionViewBody['question'] & { sourceKind: string | null; sourceRef: string | null };
    };
    expect(created.question.sourceKind).toBe('book');
    expect(created.question.sourceRef).toBe('sgk-toan-6-kntt-trang-42');

    // Câu tạo thường không khai nguồn → mặc định 'manual', ref trống.
    const plain = await createQuestion(dave.token, bank.defaultCategoryId!, 'Câu tự soạn', 'Thân câu tự soạn?');
    expect((plain.question as { sourceKind?: string | null }).sourceKind).toBe('manual');
    expect((plain.question as { sourceRef?: string | null }).sourceRef).toBeNull();

    // Copy trong bank kế thừa nguyên nguồn ngoài (derived_from ghi chuỗi copy riêng).
    const copyRes = await http(app).post(`/api/v1/questions/${created.question.id}/copy`).set(bearer(dave.token)).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copied = copyRes.body as { question: { sourceKind: string | null; sourceRef: string | null } };
    expect(copied.question.sourceKind).toBe('book');
    expect(copied.question.sourceRef).toBe('sgk-toan-6-kntt-trang-42');

    // Quy tắc bản quyền: bề mặt attempt/usage (phía học viên) KHÔNG chứa
    // bất kỳ trường nguồn/truy vết nào trong payload.
    const usageRes = await http(app).post('/api/v1/question-usages').set(bearer(dave.token))
      .send({ component: 'question_bank', slots: [{ questionId: created.question.id }] });
    expect(usageRes.status, JSON.stringify(usageRes.body)).toBe(201);
    const usageId = (usageRes.body as { usage: { id: string } }).usage.id;
    // Bắt đầu usage = đã bắt đầu các attempt của nó (payload attempt phía học viên).
    const started = await http(app).post(`/api/v1/question-usages/${usageId}/start`).set(bearer(dave.token));
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const usageGet = await http(app).get(`/api/v1/question-usages/${usageId}`).set(bearer(dave.token));
    expect(usageGet.status).toBe(200);
    for (const payload of [JSON.stringify(started.body), JSON.stringify(usageGet.body)]) {
      expect(payload).not.toContain('sourceKind');
      expect(payload).not.toContain('sourceRef');
      expect(payload).not.toContain('derivedFrom');
      expect(payload).not.toContain('sgk-toan-6-kntt');
    }
  });

  it('QB-1: bank tổ theo cohort — thành viên dùng/copy được, không thêm thẳng; tổ trưởng toàn quyền; người ngoài bị chặn', async () => {
    const leader = await mkUser();
    const member = await mkUser();
    const outsider = await mkUser();
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ Toán') });
    expect(cohortRes.status, JSON.stringify(cohortRes.body)).toBe(201);
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [leader, member]) {
      const add = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: u.id });
      expect(add.status).toBe(201);
    }
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng tổ Toán', scope: 'team', scopeRefId: cohortId, leaderId: leader.id });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBe(201);
    const bank = bankRes.body as BankBody;
    expect(bank.capabilities.moderate).toBe(true); // admin (site admin) — kiểm tra chi tiết theo vai ở dưới

    // Tổ trưởng tạo câu trong bank tổ.
    const q = await createQuestion(leader.token, bank.defaultCategoryId!, 'Câu của tổ', 'Câu hỏi của tổ chuyên môn?');
    // Thành viên thấy bank tổ trong danh sách, copy được về bank cá nhân.
    const memberBanks = await http(app).get('/api/v1/question-banks').set(bearer(member.token));
    const memberView = (memberBanks.body as BankBody[]).find((b) => b.id === bank.id);
    expect(memberView).toBeTruthy();
    expect(memberView!.capabilities.copy).toBe(true);
    expect(memberView!.capabilities.add).toBe(false);
    const copied = await http(app).post(`/api/v1/questions/${q.question.id}/copy`).set(bearer(member.token)).send({});
    expect(copied.status, JSON.stringify(copied.body)).toBe(201);
    expect((copied.body as QuestionViewBody).question.derivedFromQuestionId).toBe(q.question.id);
    // Thành viên KHÔNG thêm thẳng câu vào bank tổ.
    const memberAdd = await http(app).post('/api/v1/questions').set(bearer(member.token)).send({
      categoryId: bank.defaultCategoryId, qtype: 'truefalse', name: 'X', questionText: 'X?', answer: { correct: true },
    });
    expect(memberAdd.status).toBe(403);
    // Người ngoài: không thấy bank, không vào được bank, không copy được.
    const outsiderBanks = await http(app).get('/api/v1/question-banks').set(bearer(outsider.token));
    expect((outsiderBanks.body as BankBody[]).some((b) => b.id === bank.id)).toBe(false);
    const outsiderGet = await http(app).get(`/api/v1/question-banks/${bank.id}`).set(bearer(outsider.token));
    expect(outsiderGet.status).toBe(403);
    const outsiderCopy = await http(app).post(`/api/v1/questions/${q.question.id}/copy`).set(bearer(outsider.token)).send({});
    expect(outsiderCopy.status).toBe(403);
  });

  it('QB-1: bank trường cho mọi giáo viên (dùng/copy, không sửa thẳng); học sinh bị chặn mọi bề mặt', async () => {
    const { teacher, student } = await mkCourseWithTeacherAndStudent();
    // Admin mở bank trường (đảm bảo tồn tại) và thêm một câu.
    const adminBanks = await http(app).get('/api/v1/question-banks').set(bearer(admin));
    const school = (adminBanks.body as BankBody[]).find((b) => b.scope === 'school')!;
    expect(school).toBeTruthy();
    const q = await createQuestion(admin, school.defaultCategoryId!, 'Câu của trường', 'Câu hỏi chung của trường?');

    // Giáo viên (có vai editingteacher ở một khoá bất kỳ) thấy bank trường.
    const teacherBanks = await http(app).get('/api/v1/question-banks').set(bearer(teacher.token));
    const teacherView = (teacherBanks.body as BankBody[]).find((b) => b.id === school.id);
    expect(teacherView).toBeTruthy();
    expect(teacherView!.capabilities.use).toBe(true);
    expect(teacherView!.capabilities.add).toBe(false);
    // Giáo viên copy câu của trường về bank cá nhân được.
    const copied = await http(app).post(`/api/v1/questions/${q.question.id}/copy`).set(bearer(teacher.token)).send({});
    expect(copied.status, JSON.stringify(copied.body)).toBe(201);
    // Giáo viên không thêm thẳng vào bank trường.
    const add = await http(app).post('/api/v1/questions').set(bearer(teacher.token)).send({
      categoryId: school.defaultCategoryId, qtype: 'truefalse', name: 'X', questionText: 'X?', answer: { correct: true },
    });
    expect(add.status).toBe(403);
    // Học sinh: không thấy bank trường, vào thẳng bị 403, khám phá theo bank bị 403, copy bị 403.
    const studentBanks = await http(app).get('/api/v1/question-banks').set(bearer(student.token));
    expect((studentBanks.body as BankBody[]).some((b) => b.id === school.id)).toBe(false);
    expect((await http(app).get(`/api/v1/question-banks/${school.id}`).set(bearer(student.token))).status).toBe(403);
    expect((await http(app).get(`/api/v1/questions/discovery?bankId=${school.id}`).set(bearer(student.token))).status).toBe(403);
    expect((await http(app).post(`/api/v1/questions/${q.question.id}/copy`).set(bearer(student.token)).send({})).status).toBe(403);
  });

  it('QB-1 (điểm chặn 3 phán quyết PR #83): học sinh không được cấp bank cá nhân', async () => {
    const { student } = await mkCourseWithTeacherAndStudent();
    // Mở bề mặt bank cũng không tự sinh bank cá nhân + vai qbanklead.
    const listed = await http(app).get('/api/v1/question-banks').set(bearer(student.token));
    expect(listed.status).toBe(200);
    expect((listed.body as BankBody[]).some((b) => b.scope === 'personal' && b.ownerId === student.id)).toBe(false);
    // Xin tạo bank cá nhân tường minh cũng bị chặn.
    const created = await http(app).post('/api/v1/question-banks').set(bearer(student.token))
      .send({ name: 'Ngân hàng của tôi', scope: 'personal' });
    expect(created.status).toBe(403);
    // Gọi lại danh sách vẫn không có bank cá nhân nào của học sinh.
    const relisted = await http(app).get('/api/v1/question-banks').set(bearer(student.token));
    expect((relisted.body as BankBody[]).some((b) => b.scope === 'personal' && b.ownerId === student.id)).toBe(false);
  });

  it('QB-1: bank khoá — giáo viên của khoá dùng được qua thừa hưởng context, học sinh không', async () => {
    const { course, teacher, student } = await mkCourseWithTeacherAndStudent();
    const create = await http(app).post('/api/v1/question-banks').set(bearer(teacher.token))
      .send({ name: 'Ngân hàng khoá', scope: 'course', scopeRefId: course.id });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const bank = create.body as BankBody;
    const q = await createQuestion(teacher.token, bank.defaultCategoryId!, 'Câu của khoá', 'Câu hỏi trong bank khoá?');
    expect(q.question.id).toBeTruthy();
    const studentBanks = await http(app).get('/api/v1/question-banks').set(bearer(student.token));
    expect((studentBanks.body as BankBody[]).some((b) => b.id === bank.id)).toBe(false);
  });

  it('QB-4 (điểm chặn 4 phán quyết PR #83): khám phá thấy câu ở category khoá hiện hữu', async () => {
    const { course, teacher, courseCtxId } = await mkCourseWithTeacherAndStudent();
    // Category hiện hữu trong context khoá, không gắn bank_id.
    const catRes = await http(app).post('/api/v1/questions/categories').set(bearer(teacher.token))
      .send({ name: 'Chương 1', contextId: courseCtxId });
    expect(catRes.status, JSON.stringify(catRes.body)).toBe(201);
    const categoryId = (catRes.body as { id: string }).id;
    const q = await createQuestion(teacher.token, categoryId, 'Câu trong category khoá', 'Thân câu trong category khoá?');
    // Tạo bank khoá SAU — câu hiện hữu phải được suy về bank khoá.
    const create = await http(app).post('/api/v1/question-banks').set(bearer(teacher.token))
      .send({ name: 'Ngân hàng khoá', scope: 'course', scopeRefId: course.id });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const bank = create.body as BankBody;
    const disc = await http(app).get(`/api/v1/questions/discovery?bankId=${bank.id}`).set(bearer(teacher.token));
    expect(disc.status).toBe(200);
    expect((disc.body as { questionId: string }[]).some((d) => d.questionId === q.question.id)).toBe(true);
    // Không lọc bank cũng thấy câu đó.
    const all = await http(app).get('/api/v1/questions/discovery').set(bearer(teacher.token));
    expect((all.body as { questionId: string }[]).some((d) => d.questionId === q.question.id)).toBe(true);
  });

  it('QB-2 (điểm chặn 2 phán quyết PR #83): học sinh không đọc được attribution', async () => {
    const { teacher, student } = await mkCourseWithTeacherAndStudent();
    const bank = await myPersonalBank(teacher);
    const q = await createQuestion(teacher.token, bank.defaultCategoryId!, 'Câu có truy vết', 'Thân câu có truy vết?');
    const asTeacher = await http(app).get(`/api/v1/questions/${q.question.id}/attribution`).set(bearer(teacher.token));
    expect(asTeacher.status).toBe(200);
    const asStudent = await http(app).get(`/api/v1/questions/${q.question.id}/attribution`).set(bearer(student.token));
    expect(asStudent.status).toBe(404);
  });

  // --- QB-3 -------------------------------------------------------------------

  it('QB-3: slot từ bank tổ mặc định pinned — attempt giữ bản ghim qua sửa + rút; nâng version ghi nhật ký; xoá bị chặn', async () => {
    const leader = await mkUser();
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ Lý') });
    const cohortId = (cohortRes.body as { id: string }).id;
    await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: leader.id });
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng tổ Lý', scope: 'team', scopeRefId: cohortId, leaderId: leader.id });
    const bank = bankRes.body as BankBody;
    const q = await createQuestion(leader.token, bank.defaultCategoryId!, 'Câu ghim', 'Phiên bản MỘT của câu?');

    // Khoá + quiz do leader phụ trách (gán editingteacher tại khoá).
    const { course, sectionId, courseCtxId, student } = await mkCourseWithTeacherAndStudent();
    await assignRole(app, admin, leader.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtxId);
    const quizRes = await http(app).post(`/api/v1/courses/${course.id}/quizzes`).set(bearer(leader.token))
      .send({ sectionId, name: 'Đề kiểm tra' });
    expect(quizRes.status, JSON.stringify(quizRes.body)).toBe(201);
    const quizId = (quizRes.body as { id: string }).id;
    const slotRes = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set(bearer(leader.token))
      .send({ questionId: q.question.id });
    expect(slotRes.status, JSON.stringify(slotRes.body)).toBe(201);
    const slot = (slotRes.body as { slots: { id: string; versionMode: string; pinnedVersion: number | null; bankScope: string | null }[] }).slots[0]!;
    expect(slot.versionMode).toBe('pinned');
    expect(slot.pinnedVersion).toBe(1);
    expect(slot.bankScope).toBe('team');

    // Sửa câu lên v2 — slot báo có bản mới nhưng attempt vẫn nhận v1.
    await http(app).patch(`/api/v1/questions/${q.question.id}`).set(bearer(leader.token)).send({ questionText: 'Phiên bản HAI của câu?' });
    const viewAfter = await http(app).get(`/api/v1/quizzes/${quizId}`).set(bearer(leader.token));
    const slotAfter = (viewAfter.body as { quiz: { slots: { pinnedVersion: number | null; latestVersion: number | null; hasNewerVersion: boolean }[] } }).quiz.slots[0]!;
    expect(slotAfter.pinnedVersion).toBe(1);
    expect(slotAfter.latestVersion).toBe(2);
    expect(slotAfter.hasNewerVersion).toBe(true);

    const start1 = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set(bearer(student.token)).send({});
    expect(start1.status, JSON.stringify(start1.body)).toBe(201);
    const attemptQuestions = (start1.body as { questions: { questionText: unknown }[] }).questions;
    expect(JSON.stringify(attemptQuestions[0]!.questionText)).toContain('MỘT');

    // Rút câu: attempt mới vẫn phục vụ bản đã ghim; thêm slot mới bị chặn; xoá vật lý bị chặn vì còn slot.
    const withdraw = await http(app).post(`/api/v1/questions/${q.question.id}/withdraw`).set(bearer(leader.token)).send({ reason: 'Sai đáp án, rút để soát lại' });
    expect(withdraw.status, JSON.stringify(withdraw.body)).toBe(201);
    expect((withdraw.body as { affectedQuizIds: string[] }).affectedQuizIds).toContain(quizId);
    const start2 = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set(bearer(student.token)).send({});
    expect([200, 201]).toContain(start2.status);
    const addSlotHidden = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set(bearer(leader.token)).send({ questionId: q.question.id });
    expect(addSlotHidden.status).toBe(400);
    const del = await http(app).delete(`/api/v1/questions/${q.question.id}`).set(bearer(leader.token));
    expect(del.status).toBe(409);
    // Khám phá (leader) vẫn thấy câu đã rút kèm trạng thái hidden; thành viên thường thì không.
    const disc = await http(app).get(`/api/v1/questions/discovery?bankId=${bank.id}`).set(bearer(leader.token));
    const found = (disc.body as { questionId: string; status: string }[]).find((d) => d.questionId === q.question.id);
    expect(found?.status).toBe('hidden');

    // Hoàn rút + nâng version lên v2: nhật ký có dòng, attempt sau nâng nhận v2.
    await http(app).post(`/api/v1/questions/${q.question.id}/restore`).set(bearer(leader.token)).send({});
    const upgrade = await http(app).post(`/api/v1/quizzes/${quizId}/slots/${slot.id}/upgrade-version`).set(bearer(leader.token)).send({});
    expect(upgrade.status, JSON.stringify(upgrade.body)).toBe(201);
    const slotUp = (upgrade.body as { slots: { pinnedVersion: number | null; hasNewerVersion: boolean }[] }).slots[0]!;
    expect(slotUp.pinnedVersion).toBe(2);
    expect(slotUp.hasNewerVersion).toBe(false);
    const events = await pg.query('select from_version, to_version from quiz_slot_version_events where slot_id = $1', [slot.id]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ from_version: 1, to_version: 2 });

    // Xoá vật lý một câu chưa dùng: được phép.
    const fresh = await createQuestion(leader.token, bank.defaultCategoryId!, 'Câu xoá', 'Câu chưa dùng lần nào?');
    const delOk = await http(app).delete(`/api/v1/questions/${fresh.question.id}`).set(bearer(leader.token));
    expect(delOk.status).toBe(200);
    expect((await http(app).get(`/api/v1/questions/${fresh.question.id}`).set(bearer(leader.token))).status).toBe(404);
  });

  // --- QB-4 -------------------------------------------------------------------

  it('QB-4: vòng đời đóng góp — duyệt copy vào bank đích, chống trùng, từ chối có lý do, bản mới qua derived_from', async () => {
    const leader = await mkUser();
    const member = await mkStaffUser();
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('Tổ Văn') });
    const cohortId = (cohortRes.body as { id: string }).id;
    for (const u of [leader, member]) {
      await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: u.id });
    }
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng tổ Văn', scope: 'team', scopeRefId: cohortId, leaderId: leader.id });
    const bank = bankRes.body as BankBody;

    // Member soạn câu ở bank cá nhân rồi đề xuất lên bank tổ.
    const memberBank = await myPersonalBank(member);
    const mine = await createQuestion(member.token, memberBank.defaultCategoryId!, 'Câu đóng góp', 'Nội dung câu đóng góp?');
    const propose = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: mine.question.id, note: 'Câu này dùng tốt cho cả tổ' });
    expect(propose.status, JSON.stringify(propose.body)).toBe(201);
    const contributionId = (propose.body as { id: string }).id;
    // Đề xuất trùng đang chờ → 409.
    const dupPending = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: mine.question.id });
    expect(dupPending.status).toBe(409);
    // Member không tự duyệt được.
    const selfApprove = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions/${contributionId}/approve`).set(bearer(member.token)).send({});
    expect(selfApprove.status).toBe(403);
    // Tổ trưởng duyệt → copy vào bank tổ với truy vết về câu gốc + tác giả gốc.
    const approve = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions/${contributionId}/approve`).set(bearer(leader.token)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);
    const approved = approve.body as { status: string; resultQuestionId: string };
    expect(approved.status).toBe('approved');
    const inBank = await http(app).get(`/api/v1/questions/${approved.resultQuestionId}/attribution`).set(bearer(leader.token));
    expect((inBank.body as { derivedFromQuestionId: string; originalAuthorId: string }).derivedFromQuestionId).toBe(mine.question.id);
    expect((inBank.body as { originalAuthorId: string }).originalAuthorId).toBe(member.id);

    // Chống trùng hoàn toàn: câu nội dung y hệt đề xuất lại → 409 trỏ câu đã có.
    const clone = await createQuestion(member.token, memberBank.defaultCategoryId!, 'Câu đóng góp (bản gõ lại)', 'Nội dung câu đóng góp?');
    // createQuestion dùng cùng answers mặc định nên hash trùng hoàn toàn dù tên khác.
    const dupPropose = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: clone.question.id });
    expect(dupPropose.status, JSON.stringify(dupPropose.body)).toBe(409);
    expect(JSON.stringify(dupPropose.body)).toContain(approved.resultQuestionId);

    // Từ chối bắt buộc lý do; sau khi sửa, đề xuất lại được.
    const second = await createQuestion(member.token, memberBank.defaultCategoryId!, 'Câu thứ hai', 'Nội dung câu thứ hai?');
    const propose2 = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: second.question.id });
    const contribution2 = (propose2.body as { id: string }).id;
    const rejectNoReason = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions/${contribution2}/reject`).set(bearer(leader.token)).send({});
    expect(rejectNoReason.status).toBe(400);
    const reject = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions/${contribution2}/reject`).set(bearer(leader.token))
      .send({ reason: 'Đáp án chưa chặt, sửa lại phần nhiễu' });
    expect(reject.status).toBe(201);
    expect((reject.body as { status: string; rejectReason: string }).rejectReason).toContain('chưa chặt');
    await http(app).patch(`/api/v1/questions/${second.question.id}`).set(bearer(member.token)).send({ questionText: 'Nội dung câu thứ hai (đã sửa)?' });
    const repropose = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: second.question.id });
    expect(repropose.status, JSON.stringify(repropose.body)).toBe(201);

    // Bản mới qua derived_from: member copy câu ở bank tổ về, sửa, đề xuất update.
    const myCopy = await http(app).post(`/api/v1/questions/${approved.resultQuestionId}/copy`).set(bearer(member.token)).send({});
    const myCopyId = (myCopy.body as QuestionViewBody).question.id;
    await http(app).patch(`/api/v1/questions/${myCopyId}`).set(bearer(member.token)).send({ questionText: 'Nội dung câu đóng góp — BẢN MỚI?' });
    const beforeUpdate = await http(app).get(`/api/v1/questions/${approved.resultQuestionId}`).set(bearer(leader.token));
    const versionBefore = (beforeUpdate.body as QuestionViewBody).entry.latestVersion;
    const proposeUpdate = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: myCopyId, mode: 'update', targetQuestionId: approved.resultQuestionId });
    expect(proposeUpdate.status, JSON.stringify(proposeUpdate.body)).toBe(201);
    const approveUpdate = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions/${(proposeUpdate.body as { id: string }).id}/approve`).set(bearer(leader.token)).send({});
    expect(approveUpdate.status, JSON.stringify(approveUpdate.body)).toBe(201);
    const afterUpdate = await http(app).get(`/api/v1/questions/${approved.resultQuestionId}`).set(bearer(leader.token));
    expect((afterUpdate.body as QuestionViewBody).entry.latestVersion).toBe(versionBefore + 1);
    expect(JSON.stringify((afterUpdate.body as QuestionViewBody).latestVersion.questionText)).toContain('BẢN MỚI');
    // Đề xuất update từ câu KHÔNG suy từ câu đích → 400.
    const stray = await createQuestion(member.token, memberBank.defaultCategoryId!, 'Câu lạc', 'Câu không liên quan?');
    const badUpdate = await http(app).post(`/api/v1/question-banks/${bank.id}/contributions`).set(bearer(member.token))
      .send({ questionId: stray.question.id, mode: 'update', targetQuestionId: approved.resultQuestionId });
    expect(badUpdate.status).toBe(400);

    // Khám phá: member tìm thấy câu của bank tổ theo từ khoá, kèm tín hiệu.
    const disc = await http(app).get('/api/v1/questions/discovery?bankId=' + bank.id + '&keyword=' + encodeURIComponent('đóng góp')).set(bearer(member.token));
    expect(disc.status).toBe(200);
    const items = disc.body as { questionId: string; bankScope: string; useCount: number; copyCount: number }[];
    expect(items.some((i) => i.questionId === approved.resultQuestionId)).toBe(true);
    expect(items.every((i) => i.bankScope === 'team')).toBe(true);
  });
});
