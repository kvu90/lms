import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Feat Ngân hàng đề (issue #113, EB-1):
 *  - Đề snapshot trong bank đề (bank_kind='exam'): soạn tự do, slot
 *    ghim version ready mới nhất của câu; sửa đề tạo paper version mới.
 *  - Copy = deep copy + derived_from + ghi công tác giả gốc; GV khác
 *    chỉ xem/copy đề ready, không sửa đề cá nhân của người khác;
 *    học sinh không vào được bề mặt ngân hàng đề.
 *  - Ghim vào khoá (exam_pins) ghim exam version: học sinh làm đúng
 *    bộ câu đã ghim; attempt cũ giữ bộ câu của version cũ; đề hidden
 *    không vỡ pin đã ghim; xoá đề thì pin bị xoá theo (FK cascade).
 *  - Đóng góp/duyệt khuôn QB-4 cho đơn vị đề.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; scope: string; bankKind: string; ownerId: string | null;
  defaultCategoryId: string | null;
}
interface PaperSlotBody {
  position: number; section: string; questionId: string; pinnedVersionNumber: number | null; maxMark: number;
}
interface PaperBody {
  paper: {
    id: string; bankId: string; status: string; latestVersion: number; copyCount: number;
    derivedFromExamId: string | null; originalAuthorId: string | null; createdBy: string;
  };
  version: { id: string; version: number; name: string };
  slots: PaperSlotBody[];
  capabilities: { view: boolean; edit: boolean; copy: boolean; share: boolean; moderate: boolean; deploy: boolean };
}
interface QuizBody {
  id: string; cmId: string; examId: string | null; examVersionId: string | null;
  slots: { questionId: string | null; maxMark: number; versionMode: string | null; pinnedVersion: number | null }[];
}
interface AttemptBody {
  attempt: { id: string; state: string };
  questions: { slot: number; questionId: string }[];
}

describe('Exam paper bank (feat #113 EB-1)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  });
  afterAll(async () => { await app.close(); });

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Giáo viên thuộc nhóm vai staff tại hệ thống — chỉ nhóm này mới có ngân hàng cá nhân. */
  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  async function bankOfKind(token: string, kind: 'question' | 'exam', scope: string, ownerId?: string): Promise<BankBody> {
    const res = await http(app).get(`/api/v1/question-banks?kind=${kind}`).set(bearer(token));
    expect(res.status).toBe(200);
    // Bank cá nhân phải lọc thêm theo ownerId: listBanks của QB liệt kê cả bank
    // cá nhân của GV staff khác (chúng có question:useall qua thừa kế) — lấy
    // bank đầu tiên theo scope là lấy nhầm bank người khác (bài học CI EB-1).
    const bank = (res.body as BankBody[]).find(
      (b) => b.scope === scope && b.bankKind === kind && (scope !== 'personal' || b.ownerId === ownerId),
    );
    expect(bank).toBeTruthy();
    return bank!;
  }

  async function createQuestion(token: string, categoryId: string, name: string): Promise<string> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'multichoice', name, questionText: `Thân câu ${name}?`,
      answers: [{ text: 'Đúng', fraction: 1 }, { text: 'Sai', fraction: 0 }],
      options: { single: true },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { question: { id: string } }).question.id;
  }

  async function createPaper(token: string, bankId: string, name: string, slots: { questionId: string; maxMark?: number; section?: string }[]): Promise<PaperBody> {
    const res = await http(app).post(`/api/v1/exams/banks/${bankId}/papers`).set(bearer(token))
      .send({ name, examKind: 'regular', slots });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PaperBody;
  }

  async function setStatus(token: string, paperId: string, status: string) {
    const res = await http(app).post(`/api/v1/exams/${paperId}/status`).set(bearer(token)).send({ status });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as PaperBody;
  }

  /** Khoá học mà `teacher` là editingteacher (ghim đề được), `student` đã ghi danh. */
  async function mkCourse(teacher: { id: string }, student: { id: string }) {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    return { course, sectionId };
  }

  /** Ghim đề vào khoá qua exam-pins (thay cho deploy vào quiz cũ): pin là hoạt động, mang cm + grade item. */
  async function pin(token: string, courseId: string, sectionId: string, paperId: string, name?: string) {
    return http(app).post(`/api/v1/courses/${courseId}/exam-pins`).set(bearer(token))
      .send({ sectionId, examId: paperId, ...(name ? { name } : {}) });
  }

  async function pinOk(token: string, courseId: string, sectionId: string, paperId: string, name?: string): Promise<QuizBody> {
    const res = await pin(token, courseId, sectionId, paperId, name);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as QuizBody;
  }

  it('TC1: soạn đề tự do → ready → deploy vào quiz → học sinh làm đúng bộ câu đã ghim', async () => {
    const owner = await mkStaffUser();
    const student = await mkUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB câu 1');
    const q2 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB câu 2');

    const paper = await createPaper(owner.token, eBank.id, 'Đề kiểm tra 15 phút', [
      { questionId: q1, maxMark: 2, section: 'Phần I' },
      { questionId: q2, maxMark: 3, section: 'Phần II' },
    ]);
    expect(paper.paper.status).toBe('draft');
    expect(paper.version.version).toBe(1);
    // Slot ghim cứng version ready mới nhất (v1) của từng câu.
    expect(paper.slots.map((s) => [s.questionId, s.pinnedVersionNumber, s.maxMark])).toEqual([[q1, 1, 2], [q2, 1, 3]]);
    expect(paper.capabilities).toMatchObject({ view: true, edit: true, copy: true, deploy: true });

    await setStatus(owner.token, paper.paper.id, 'ready');

    const { course, sectionId } = await mkCourse(owner, student);
    const deployed = await pin(owner.token, course.id, sectionId, paper.paper.id, 'KT 15 phút');
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(201);
    const quiz = deployed.body as QuizBody;
    const quizView = quiz;
    expect(quizView.examId).toBe(paper.paper.id);
    expect(quizView.examVersionId).toBe(paper.version.id);
    expect(quizView.slots.map((s) => s.questionId)).toEqual([q1, q2]);
    expect(quizView.slots.every((s) => s.versionMode === 'pinned' && s.pinnedVersion === 1)).toBe(true);
    // Phần I / Phần II thành hai trang.
    expect((deployed.body as { slots: { page: number }[] }).slots.map((x) => x.page)).toEqual([1, 2]);

    // Học sinh làm bài: thấy đúng bộ câu đã ghim của paper version.
    const start = await http(app).post(`/api/v1/exam-pins/${quiz.id}/attempts`).set(bearer(student.token)).send({});
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const attempt = start.body as AttemptBody;
    expect(attempt.questions.map((q) => q.questionId)).toEqual([q1, q2]);
    const submit = await http(app).post(`/api/v1/quiz-attempts/${attempt.attempt.id}/submit`).set(bearer(student.token)).send({});
    expect(submit.status).toBe(201);
  });

  it('TC2: sửa đề tạo paper version mới; attempt cũ giữ bộ câu cũ; quiz đã có lượt thật thì không deploy lại được', async () => {
    const owner = await mkStaffUser();
    const student = await mkUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB2 câu 1');
    const q2 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB2 câu 2');
    const q3 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB2 câu 3');

    const paper = await createPaper(owner.token, eBank.id, 'Đề giữa kỳ', [{ questionId: q1 }, { questionId: q2 }]);
    await setStatus(owner.token, paper.paper.id, 'ready');
    const { course, sectionId } = await mkCourse(owner, student);
    const quiz = await pinOk(owner.token, course.id, sectionId, paper.paper.id, 'Giữa kỳ');

    const start = await http(app).post(`/api/v1/exam-pins/${quiz.id}/attempts`).set(bearer(student.token)).send({});
    const attempt = start.body as AttemptBody;
    await http(app).post(`/api/v1/quiz-attempts/${attempt.attempt.id}/submit`).set(bearer(student.token)).send({});

    // Sửa đề: đổi câu 2 thành câu 3 → version 2.
    const updated = await http(app).put(`/api/v1/exams/${paper.paper.id}/slots`).set(bearer(owner.token))
      .send({ slots: [{ questionId: q1 }, { questionId: q3 }] });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const v2 = updated.body as PaperBody;
    expect(v2.paper.latestVersion).toBe(2);
    expect(v2.version.version).toBe(2);
    expect(v2.slots.map((s) => s.questionId)).toEqual([q1, q3]);

    // Attempt cũ vẫn giữ bộ câu của version 1.
    const oldAttempt = await http(app).get(`/api/v1/quiz-attempts/${attempt.attempt.id}`).set(bearer(student.token));
    expect(oldAttempt.status).toBe(200);
    expect((oldAttempt.body as AttemptBody).questions.map((q) => q.questionId)).toEqual([q1, q2]);

    // Pin đã có lượt thật: nâng pin lên version 2 bị khoá (đóng băng).
    const frozen = await http(app).patch(`/api/v1/exam-pins/${quiz.id}`).set(bearer(owner.token))
      .send({ examVersionId: v2.version.id });
    expect(frozen.status).toBe(400);
    expect((frozen.body as { code?: string }).code).toBe('exam.pin_locked');

    // Pin mới nhận đúng bộ câu của version 2.
    const deployed2 = await pin(owner.token, course.id, sectionId, paper.paper.id, 'Giữa kỳ (bản 2)');
    expect(deployed2.status).toBe(201);
    expect((deployed2.body as QuizBody).slots.map((s) => s.questionId)).toEqual([q1, q3]);
    expect((deployed2.body as QuizBody).examVersionId).toBe(v2.version.id);
  });

  it('TC3: copy từ ngân hàng hệ thống về bank của tôi — slots giữ question + pinned version, derived_from + ghi công; copy_count tăng', async () => {
    const owner = await mkStaffUser();
    // Ngân hàng đề trường (Ngân hàng hệ thống) do admin lập; admin soạn một đề ready trong đó.
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng đề trường EB', scope: 'school', bankKind: 'exam' });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBe(201);
    const schoolBank = bankRes.body as BankBody;
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB3 câu nguồn');
    const source = await createPaper(admin, schoolBank.id, 'Đề thi thử trường', [{ questionId: q1, maxMark: 4 }]);
    await setStatus(admin, source.paper.id, 'ready');

    // GV thấy đề trong bank trường và copy về ngân hàng đề cá nhân (đích mặc định).
    const list = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/papers`).set(bearer(owner.token));
    expect(list.status).toBe(200);
    expect((list.body as { id: string }[]).map((p) => p.id)).toContain(source.paper.id);

    const copyRes = await http(app).post(`/api/v1/exams/${source.paper.id}/copy`).set(bearer(owner.token)).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copy = copyRes.body as PaperBody;
    const myBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    expect(copy.paper.bankId).toBe(myBank.id);
    expect(copy.paper.id).not.toBe(source.paper.id);
    expect(copy.paper.derivedFromExamId).toBe(source.paper.id);
    expect(copy.paper.originalAuthorId).toBe(source.paper.createdBy);
    expect(copy.paper.status).toBe('draft');
    // Slots sao nguyên: cùng câu, cùng version đã ghim, cùng điểm.
    expect(copy.slots.map((s) => [s.questionId, s.pinnedVersionNumber, s.maxMark])).toEqual([[q1, 1, 4]]);

    // copy_count của đề nguồn tăng; bản copy độc lập — sửa bản copy không đụng bản gốc.
    const sourceAfter = await http(app).get(`/api/v1/exams/${source.paper.id}`).set(bearer(admin));
    expect((sourceAfter.body as PaperBody).paper.copyCount).toBe(1);
    const q2 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB3 câu thêm');
    const edited = await http(app).put(`/api/v1/exams/${copy.paper.id}/slots`).set(bearer(owner.token))
      .send({ slots: [{ questionId: q1 }, { questionId: q2 }] });
    expect(edited.status).toBe(200);
    const sourceFinal = await http(app).get(`/api/v1/exams/${source.paper.id}`).set(bearer(admin));
    expect((sourceFinal.body as PaperBody).slots).toHaveLength(1);
    expect((sourceFinal.body as PaperBody).paper.latestVersion).toBe(1);
  });

  it('TC4: GV khác chỉ xem/copy được đề ready — không sửa/xoá đề cá nhân của người khác; học sinh không vào được bề mặt ngân hàng đề', async () => {
    const owner = await mkStaffUser();
    const other = await mkStaffUser();
    const student = await mkUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB4 câu 1');
    const paper = await createPaper(owner.token, eBank.id, 'Đề riêng của chủ', [{ questionId: q1 }]);
    await setStatus(owner.token, paper.paper.id, 'ready');

    // GV khác: bank cá nhân của chủ không nằm trong danh sách bank của mình,
    // đọc thẳng đề ready của bank kín cũng bị chặn (không có exam:view tại bank đó).
    const otherView = await http(app).get(`/api/v1/exams/${paper.paper.id}`).set(bearer(other.token));
    expect(otherView.status).toBe(403);
    const otherPatch = await http(app).patch(`/api/v1/exams/${paper.paper.id}`).set(bearer(other.token)).send({ name: 'Chiếm đề' });
    expect(otherPatch.status).toBe(403);
    const otherDelete = await http(app).delete(`/api/v1/exams/${paper.paper.id}`).set(bearer(other.token));
    expect(otherDelete.status).toBe(403);

    // Học sinh: không list được đề của bank trường, không đọc/tạo được đề.
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng đề trường EB4', scope: 'school', bankKind: 'exam' });
    const schoolBank = bankRes.body as BankBody;
    const studentList = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/papers`).set(bearer(student.token));
    expect(studentList.status).toBe(403);
    const studentGet = await http(app).get(`/api/v1/exams/${paper.paper.id}`).set(bearer(student.token));
    expect(studentGet.status).toBe(403);
    const studentCreate = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/papers`).set(bearer(student.token))
      .send({ name: 'Đề của học sinh', slots: [] });
    expect(studentCreate.status).toBe(403);
  });

  it('TC5: đề hidden không vỡ pin đã ghim; xoá đề thì pin bị xoá theo (cascade)', async () => {
    const owner = await mkStaffUser();
    const student = await mkUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB5 câu 1');
    const { course, sectionId } = await mkCourse(owner, student);

    const paper = await createPaper(owner.token, eBank.id, 'Đề sẽ ẩn', [{ questionId: q1 }]);
    await setStatus(owner.token, paper.paper.id, 'ready');
    const quiz = await pinOk(owner.token, course.id, sectionId, paper.paper.id, 'Quiz đề ẩn');
    await setStatus(owner.token, paper.paper.id, 'hidden');

    // Pin vẫn thi được với bộ câu của version đã ghim.
    const start = await http(app).post(`/api/v1/exam-pins/${quiz.id}/attempts`).set(bearer(student.token)).send({});
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    expect((start.body as AttemptBody).questions.map((q) => q.questionId)).toEqual([q1]);

    // Đề draft không ghim được.
    const draft = await createPaper(owner.token, eBank.id, 'Đề nháp', [{ questionId: q1 }]);
    const draftDeploy = await pin(owner.token, course.id, sectionId, draft.paper.id, 'Quiz nháp');
    expect(draftDeploy.status).toBe(400);
    expect((draftDeploy.body as { code?: string }).code).toBe('exam.pin_requires_ready');

    // Xoá một đề đã ghim (chưa có lượt): pin bị xoá theo đề (FK
    // cascade exam_pins.exam_id) — hoạt động biến mất khỏi khoá.
    const paper3 = await createPaper(owner.token, eBank.id, 'Đề sẽ xoá', [{ questionId: q1 }]);
    await setStatus(owner.token, paper3.paper.id, 'ready');
    const quiz3 = await pinOk(owner.token, course.id, sectionId, paper3.paper.id, 'Quiz đề xoá');
    const del = await http(app).delete(`/api/v1/exams/${paper3.paper.id}`).set(bearer(owner.token));
    expect(del.status).toBe(200);
    const quizAfter = await http(app).get(`/api/v1/exam-pins/${quiz3.id}`).set(bearer(owner.token));
    expect(quizAfter.status).toBe(404);
  });

  it('TC6: ghim cùng một đề hai lần vào một khoá tạo hai hoạt động độc lập; cổng soạn đề chặn câu hidden và đề rỗng lên ready', async () => {
    const owner = await mkStaffUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB6 câu 1');
    const qHidden = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB6 câu rút');
    const { course, sectionId } = await mkCourse(owner, await mkUser());

    // Câu bị rút (hidden) không vào được đề.
    const withdraw = await http(app).post(`/api/v1/questions/${qHidden}/withdraw`).set(bearer(owner.token)).send({ reason: 'Sai đáp án' });
    expect(withdraw.status).toBe(201);
    const badPaper = await http(app).post(`/api/v1/exams/banks/${eBank.id}/papers`).set(bearer(owner.token))
      .send({ name: 'Đề chứa câu rút', slots: [{ questionId: qHidden }] });
    expect(badPaper.status).toBe(400);
    expect((badPaper.body as { code?: string }).code).toBe('exam.slot_question_not_ready');

    // Đề rỗng không lên ready được.
    const empty = await createPaper(owner.token, eBank.id, 'Đề rỗng', []);
    const emptyReady = await http(app).post(`/api/v1/exams/${empty.paper.id}/status`).set(bearer(owner.token)).send({ status: 'ready' });
    expect(emptyReady.status).toBe(400);
    expect((emptyReady.body as { code?: string }).code).toBe('exam.ready_requires_slots');

    // Ghim cùng một đề hai lần vào một khoá: hai pin độc lập (không
    // còn khái niệm deploy đè lên quiz dựng tay của mô hình cũ).
    const paper = await createPaper(owner.token, eBank.id, 'Đề ghim hai lần', [{ questionId: q1 }]);
    await setStatus(owner.token, paper.paper.id, 'ready');
    const pin1 = await pinOk(owner.token, course.id, sectionId, paper.paper.id, 'Lần ghim 1');
    const pin2 = await pinOk(owner.token, course.id, sectionId, paper.paper.id, 'Lần ghim 2');
    expect(pin1.id).not.toBe(pin2.id);
    expect(pin1.examId).toBe(paper.paper.id);
    expect(pin2.examId).toBe(paper.paper.id);
    expect(pin1.slots).toHaveLength(1);
    expect(pin2.slots).toHaveLength(1);
    const list = await http(app).get(`/api/v1/courses/${course.id}/exam-pins`).set(bearer(owner.token));
    expect((list.body as { id: string }[]).map((x) => x.id)).toEqual(expect.arrayContaining([pin1.id, pin2.id]));
  });

  it('TC7: đóng góp đề vào bank trường theo khuôn QB-4 — duyệt thì copy vào bank đích, trùng hoàn toàn bị 409, từ chối có lý do', async () => {
    const owner = await mkStaffUser();
    const qBank = await bankOfKind(owner.token, 'question', 'personal', owner.id);
    const eBank = await bankOfKind(owner.token, 'exam', 'personal', owner.id);
    const q1 = await createQuestion(owner.token, qBank.defaultCategoryId!, 'EB7 câu 1');
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng đề trường EB7', scope: 'school', bankKind: 'exam' });
    const schoolBank = bankRes.body as BankBody;

    const paper = await createPaper(owner.token, eBank.id, 'Đề đóng góp', [{ questionId: q1 }]);
    await setStatus(owner.token, paper.paper.id, 'ready');
    const propose = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: paper.paper.id, note: 'Đề dùng chung tổ Toán' });
    expect(propose.status, JSON.stringify(propose.body)).toBe(201);
    const contribution = propose.body as { id: string; status: string };

    // Người duyệt (admin = chủ bank trường) thấy hàng chờ và duyệt → đề được copy vào bank trường.
    const queue = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(admin));
    expect(queue.status).toBe(200);
    expect((queue.body as { id: string }[]).map((c) => c.id)).toContain(contribution.id);
    const approve = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${contribution.id}/approve`)
      .set(bearer(admin)).send({});
    expect(approve.status, JSON.stringify(approve.body)).toBe(201);
    const approved = approve.body as { status: string; resultExamId: string | null };
    expect(approved.status).toBe('approved');
    expect(approved.resultExamId).toBeTruthy();
    const inSchool = await http(app).get(`/api/v1/exams/banks/${schoolBank.id}/papers`).set(bearer(admin));
    const copied = (inSchool.body as { id: string; derivedFromExamId: string | null }[])
      .find((p) => p.id === approved.resultExamId);
    expect(copied?.derivedFromExamId).toBe(paper.paper.id);

    // Đề xuất lại cùng đề rồi duyệt tiếp → trùng hoàn toàn 409.
    const propose2 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: paper.paper.id });
    expect(propose2.status).toBe(201);
    const approve2 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${(propose2.body as { id: string }).id}/approve`)
      .set(bearer(admin)).send({});
    expect(approve2.status).toBe(409);
    expect((approve2.body as { code?: string }).code).toBe('exam.duplicate_in_bank');

    // Từ chối có lý do.
    const paper2 = await createPaper(owner.token, eBank.id, 'Đề bị từ chối', [{ questionId: q1 }]);
    await setStatus(owner.token, paper2.paper.id, 'ready');
    const propose3 = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions`).set(bearer(owner.token))
      .send({ examId: paper2.paper.id });
    const reject = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/contributions/${(propose3.body as { id: string }).id}/reject`)
      .set(bearer(admin)).send({ reason: 'Chưa đạt cấu trúc ma trận' });
    expect(reject.status).toBe(201);
    expect((reject.body as { status: string; rejectReason: string }).status).toBe('rejected');
    expect((reject.body as { rejectReason: string }).rejectReason).toContain('ma trận');
  });
});
