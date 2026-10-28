import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from '../../support/identity-access-helpers';
import { createCategory, createCourse, getFirstSectionId } from '../../support/course-enrolment-helpers';

/**
 * Truy vết copy + truy nguồn hai chiều cho cả ba thực thể ngân hàng
 * (issue #228, lát S2) — đối chiếu tiêu chí nghiệm thu của issue:
 * "ma trận và đề có đủ truy vết copy như câu hỏi; truy vấn được hai
 * chiều câu hỏi ↔ đề ↔ ma trận ↔ sách".
 *
 * Luật được khoá ở đây:
 *  - Copy ma trận ghi bank nguồn + tác giả gốc tại lúc copy và tăng
 *    copy_count của ma trận nguồn; endpoint attribution của ma trận
 *    trả đúng các giá trị đã ghi + use_count = số version đề đã sinh.
 *  - Copy đề ghi bank nguồn + SỐ VERSION của đề nguồn TẠI LÚC COPY:
 *    copy trước khi nguồn lên version 2 giữ derived_from_version=1,
 *    copy sau ghi 2 — truy vết không bị viết lại theo trạng thái
 *    nguồn về sau.
 *  - Truy nguồn chiều ngược: ma trận → các đề đã sinh
 *    (generated-exams), câu → các version đề đang chứa câu
 *    (containing-exams, cùng cổng đọc 404 với attribution), sách →
 *    các câu ghi nguồn từ sách (qua cặp source_kind/source_ref).
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; name: string; scope: string; bankKind: string; ownerId: string | null;
  defaultCategoryId: string | null;
}
interface MatrixBody {
  id: string; name: string; bankId: string | null; status: string; version: number;
  createdBy: string | null;
  derivedFromMatrixId: string | null; derivedFromBankId: string | null;
  originalAuthorId: string | null; copyCount: number;
  cells: { id: string; cognitiveLevel: string; questionCount: number }[];
}
interface MatrixAttributionBody {
  matrixId: string; isCopy: boolean; derivedFromMatrixId: string | null;
  originalAuthorId: string | null; originalAuthorName: string | null;
  sourceBankId: string | null; sourceBankName: string | null;
  copyCount: number; useCount: number;
}
interface PaperBody {
  paper: {
    id: string; bankId: string; status: string; latestVersion: number; copyCount: number;
    derivedFromExamId: string | null; originalAuthorId: string | null; createdBy: string;
  };
  version: { id: string; version: number; name: string };
  slots: { questionId: string; pinnedVersionNumber: number | null }[];
  attribution: {
    derivedFromExamId: string; originalAuthorId: string | null;
    sourceBankId: string; derivedFromVersionNumber: number | null;
  } | null;
}

describe('Bank traceability (issue #228 S2)', () => {
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

  /** Giáo viên thuộc nhóm vai staff tại hệ thống — được cấp ngân hàng cá nhân. */
  async function mkStaffUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  /** Môn → chương trình → chủ đề → bài → 2 YCCĐ (Biết/Hiểu). */
  async function setupCurriculum(): Promise<{ subjectId: string; curriculumId: string; lessonId: string; outcomeBiet: string; outcomeHieu: string }> {
    const systemCtxId = await systemContextId(app, admin);
    const subjRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: uniqueName('Toán S2'), slug: `toan-s2-${Date.now()}-${Math.floor(Math.random() * 1e6)}` });
    expect(subjRes.status, JSON.stringify(subjRes.body)).toBe(201);
    const subjectId = (subjRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin)).send({ subjectId, grade: 10 });
    expect(currRes.status, JSON.stringify(currRes.body)).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;
    const topicRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, title: 'Hàm số', kind: 'topic' });
    expect(topicRes.status, JSON.stringify(topicRes.body)).toBe(201);
    const lessonRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: (topicRes.body as { id: string }).id, title: 'Hàm số bậc hai', kind: 'lesson' });
    expect(lessonRes.status, JSON.stringify(lessonRes.body)).toBe(201);
    const lessonId = (lessonRes.body as { id: string }).id;
    const mkOutcome = async (content: string) => {
      const r = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin)).send({ nodeId: lessonId, content });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return (r.body as { id: string }).id;
    };
    return {
      subjectId, curriculumId, lessonId,
      outcomeBiet: await mkOutcome('Nhận biết được tính đồng biến của hàm số bậc hai.'),
      outcomeHieu: await mkOutcome('Giải thích được mối liên hệ giữa đồ thị và hệ số a.'),
    };
  }

  async function createQuestionCategory(): Promise<string> {
    const systemCtxId = await systemContextId(app, admin);
    const res = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
      .send({ name: uniqueName('Pool S2'), contextId: systemCtxId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { id: string }).id;
  }

  async function createQuestion(categoryId: string, name: string, extra?: Record<string, unknown>): Promise<string> {
    const res = await http(app).post('/api/v1/questions').set(bearer(admin)).send({
      categoryId, qtype: 'multichoice', questionText: `Thân câu ${name}?`,
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { question: { id: string } }).question.id;
  }

  async function tagOutcome(questionId: string, outcomeId: string, level: string) {
    const res = await http(app).post(`/api/v1/questions/${questionId}/outcomes`).set(bearer(admin))
      .send({ outcomeId, cognitiveLevel: level });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }

  it('copy ma trận ghi truy vết đầy đủ (bank nguồn + tác giả gốc) và attribution đọc lại đúng, copy_count nguồn tăng', async () => {
    const cur = await setupCurriculum();
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Ngân hàng ma trận trường S2'), scope: 'school', bankKind: 'matrix' });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBe(201);
    const schoolBank = bankRes.body as BankBody;

    const createRes = await http(app).post('/api/v1/exam-matrices').set(bearer(admin))
      .send({ name: 'Ma trận nguồn S2', subjectId: cur.subjectId, curriculumId: cur.curriculumId, totalScore: 10, bankId: schoolBank.id });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const source = createRes.body as MatrixBody;
    expect(source.bankId).toBe(schoolBank.id);
    const cellRes = await http(app).post(`/api/v1/exam-matrices/${source.id}/cells`).set(bearer(admin))
      .send({ curriculumNodeId: cur.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 2 });
    expect(cellRes.status, JSON.stringify(cellRes.body)).toBe(201);
    const readyRes = await http(app).patch(`/api/v1/exam-matrices/${source.id}`).set(bearer(admin)).send({ status: 'ready' });
    expect(readyRes.status, JSON.stringify(readyRes.body)).toBe(200);

    const copyRes = await http(app).post(`/api/v1/exam-matrices/${source.id}/copy`).set(bearer(admin)).send({});
    expect(copyRes.status, JSON.stringify(copyRes.body)).toBe(201);
    const copy = copyRes.body as MatrixBody;
    expect(copy.derivedFromMatrixId).toBe(source.id);
    expect(copy.derivedFromBankId).toBe(schoolBank.id);
    expect(copy.originalAuthorId).toBe(source.createdBy);
    expect(copy.copyCount).toBe(0);

    // Giá trị ghi tại tầng DB của bản copy.
    const copyRow = await pg.query<{ derived_from_bank_id: string; original_author_id: string; copy_count: number }>(
      'select derived_from_bank_id, original_author_id, copy_count from exam_matrices where id = $1', [copy.id],
    );
    expect(copyRow.rows[0]).toEqual({
      derived_from_bank_id: schoolBank.id, original_author_id: source.createdBy, copy_count: 0,
    });

    // Attribution của nguồn: không phải bản copy, copy_count đã tăng, chưa sinh đề nào.
    const srcAttrRes = await http(app).get(`/api/v1/exam-matrices/${source.id}/attribution`).set(bearer(admin));
    expect(srcAttrRes.status, JSON.stringify(srcAttrRes.body)).toBe(200);
    const srcAttr = srcAttrRes.body as MatrixAttributionBody;
    expect(srcAttr.isCopy).toBe(false);
    expect(srcAttr.copyCount).toBe(1);
    expect(srcAttr.useCount).toBe(0);
    expect(srcAttr.sourceBankId).toBeNull();

    // Attribution của bản copy: đủ nguồn + tên bank nguồn + tên tác giả gốc.
    const copyAttrRes = await http(app).get(`/api/v1/exam-matrices/${copy.id}/attribution`).set(bearer(admin));
    expect(copyAttrRes.status, JSON.stringify(copyAttrRes.body)).toBe(200);
    const copyAttr = copyAttrRes.body as MatrixAttributionBody;
    expect(copyAttr.isCopy).toBe(true);
    expect(copyAttr.derivedFromMatrixId).toBe(source.id);
    expect(copyAttr.sourceBankId).toBe(schoolBank.id);
    expect(copyAttr.sourceBankName).toBe(schoolBank.name);
    expect(copyAttr.originalAuthorId).toBe(source.createdBy);
    expect(copyAttr.originalAuthorName).toBeTruthy();

    // Ma trận không tồn tại → 404.
    const missing = await http(app).get('/api/v1/exam-matrices/01900000-0000-7000-8000-0000000000aa/attribution').set(bearer(admin));
    expect(missing.status).toBe(404);
  });

  it('truy nguồn hai chiều quanh đề sinh từ ma trận: ma trận → đề đã sinh, câu → đề đang chứa, use_count khớp', async () => {
    const cur = await setupCurriculum();
    const catId = await createQuestionCategory();
    const pool: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const q = await createQuestion(catId, `S2 pool B${i}`);
      await tagOutcome(q, cur.outcomeBiet, 'biet');
      pool.push(q);
    }
    const courseCat = await createCategory(app, admin);
    const course = await createCourse(app, admin, courseCat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);

    const createRes = await http(app).post('/api/v1/exam-matrices').set(bearer(admin))
      .send({ name: 'Ma trận sinh đề S2', subjectId: cur.subjectId, curriculumId: cur.curriculumId, totalScore: 4 });
    expect(createRes.status, JSON.stringify(createRes.body)).toBe(201);
    const matrix = createRes.body as MatrixBody;
    const cellRes = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/cells`).set(bearer(admin))
      .send({ curriculumNodeId: cur.lessonId, cognitiveLevel: 'biet', qtype: 'multichoice', questionCount: 2, cellScore: 2, minutes: 10 });
    expect(cellRes.status, JSON.stringify(cellRes.body)).toBe(201);

    const genRes = await http(app).post(`/api/v1/exam-matrices/${matrix.id}/generate`).set(bearer(admin))
      .send({ courseId: course.id, sectionId, name: 'Đề sinh từ ma trận S2' });
    expect(genRes.status, JSON.stringify(genRes.body)).toBe(201);
    const quiz = genRes.body as { examId: string; examVersionId: string };
    expect(quiz.examId).toBeTruthy();
    expect(quiz.examVersionId).toBeTruthy();

    // Ma trận → các đề đã sinh: đúng một version đề, neo matrix version 1.
    const genListRes = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/generated-exams`).set(bearer(admin));
    expect(genListRes.status, JSON.stringify(genListRes.body)).toBe(200);
    const generated = genListRes.body as { examId: string; examVersionId: string; version: number; name: string; matrixVersion: number | null }[];
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ examId: quiz.examId, examVersionId: quiz.examVersionId, version: 1, matrixVersion: 1 });

    // use_count của ma trận khớp số version đề đã sinh.
    const attrRes = await http(app).get(`/api/v1/exam-matrices/${matrix.id}/attribution`).set(bearer(admin));
    expect((attrRes.body as MatrixAttributionBody).useCount).toBe(1);

    // Câu → các version đề đang chứa câu: lấy một câu trong đề vừa sinh.
    const paperRes = await http(app).get(`/api/v1/exams/${quiz.examId}`).set(bearer(admin));
    expect(paperRes.status, JSON.stringify(paperRes.body)).toBe(200);
    const paper = paperRes.body as PaperBody;
    expect(paper.slots).toHaveLength(2);
    const usedQuestionId = paper.slots[0]!.questionId;
    expect(pool).toContain(usedQuestionId);
    const containingRes = await http(app).get(`/api/v1/questions/${usedQuestionId}/containing-exams`).set(bearer(admin));
    expect(containingRes.status, JSON.stringify(containingRes.body)).toBe(200);
    const containing = containingRes.body as { examId: string; examVersionId: string; version: number }[];
    expect(containing).toContainEqual(expect.objectContaining({ examId: quiz.examId, examVersionId: quiz.examVersionId, version: 1 }));

    // Câu không tồn tại → 404 đồng nhất như attribution.
    const missing = await http(app).get('/api/v1/questions/01900000-0000-7000-8000-0000000000bb/containing-exams').set(bearer(admin));
    expect(missing.status).toBe(404);
  });

  it('copy đề ghi bank nguồn và số version của đề nguồn tại lúc copy — bản copy cũ không bị viết lại khi nguồn lên version mới', async () => {
    const owner = await mkStaffUser();
    const bankRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: uniqueName('Ngân hàng đề trường S2'), scope: 'school', bankKind: 'exam' });
    expect(bankRes.status, JSON.stringify(bankRes.body)).toBe(201);
    const schoolBank = bankRes.body as BankBody;

    const qBanksRes = await http(app).get('/api/v1/question-banks?kind=question').set(bearer(owner.token));
    const qBank = (qBanksRes.body as BankBody[]).find((b) => b.scope === 'personal' && b.ownerId === owner.id)!;
    const qRes = await http(app).post('/api/v1/questions').set(bearer(owner.token)).send({
      categoryId: qBank.defaultCategoryId, qtype: 'multichoice', questionText: 'Câu cho đề nguồn S2?',
      answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    expect(qRes.status, JSON.stringify(qRes.body)).toBe(201);
    const q1 = (qRes.body as { question: { id: string } }).question.id;

    const paperRes = await http(app).post(`/api/v1/exams/banks/${schoolBank.id}/exams`).set(bearer(admin))
      .send({ name: 'Đề nguồn S2', examKind: 'regular', slots: [{ questionId: q1, maxMark: 4 }] });
    expect(paperRes.status, JSON.stringify(paperRes.body)).toBe(201);
    const source = paperRes.body as PaperBody;
    const statusRes = await http(app).post(`/api/v1/exams/${source.paper.id}/status`).set(bearer(admin)).send({ status: 'ready' });
    expect(statusRes.status, JSON.stringify(statusRes.body)).toBe(201);

    // Copy lần 1 khi nguồn ở version 1.
    const copy1Res = await http(app).post(`/api/v1/exams/${source.paper.id}/copy`).set(bearer(owner.token)).send({});
    expect(copy1Res.status, JSON.stringify(copy1Res.body)).toBe(201);
    const copy1 = copy1Res.body as PaperBody;
    expect(copy1.attribution).toEqual({
      derivedFromExamId: source.paper.id,
      originalAuthorId: source.paper.createdBy,
      sourceBankId: schoolBank.id,
      derivedFromVersionNumber: 1,
    });
    const copy1Row = await pg.query<{ derived_from_bank_id: string; derived_from_version_number: number }>(
      'select derived_from_bank_id, derived_from_version_number from exams where id = $1', [copy1.paper.id],
    );
    expect(copy1Row.rows[0]).toEqual({ derived_from_bank_id: schoolBank.id, derived_from_version_number: 1 });

    // Nguồn lên version 2 (sửa metadata), rồi copy lần 2.
    const patchRes = await http(app).patch(`/api/v1/exams/${source.paper.id}`).set(bearer(admin)).send({ name: 'Đề nguồn S2 (bản 2)' });
    expect(patchRes.status, JSON.stringify(patchRes.body)).toBe(200);
    expect((patchRes.body as PaperBody).paper.latestVersion).toBe(2);
    const copy2Res = await http(app).post(`/api/v1/exams/${source.paper.id}/copy`).set(bearer(owner.token)).send({});
    expect(copy2Res.status, JSON.stringify(copy2Res.body)).toBe(201);
    const copy2 = copy2Res.body as PaperBody;
    expect(copy2.attribution?.derivedFromVersionNumber).toBe(2);
    expect(copy2.attribution?.sourceBankId).toBe(schoolBank.id);

    // Bản copy lần 1 giữ nguyên truy vết version 1; nguồn có copy_count = 2.
    const copy1After = await http(app).get(`/api/v1/exams/${copy1.paper.id}`).set(bearer(owner.token));
    expect((copy1After.body as PaperBody).attribution?.derivedFromVersionNumber).toBe(1);
    const sourceAfter = await http(app).get(`/api/v1/exams/${source.paper.id}`).set(bearer(admin));
    expect((sourceAfter.body as PaperBody).paper.copyCount).toBe(2);
  });

  it('sách → các câu thuộc sách qua cặp truy vết nguồn; sách không tồn tại → 404', async () => {
    const cur = await setupCurriculum();
    const bookRows = await pg.query<{ id: string }>(
      'insert into books (title, subject_id, grade) values ($1, $2, 10) returning id',
      [uniqueName('Sách nguồn S2'), cur.subjectId],
    );
    const bookId = bookRows.rows[0]!.id;

    const catId = await createQuestionCategory();
    const fromBook = await createQuestion(catId, 'Câu từ sách S2', { sourceKind: 'book', sourceRef: bookId });
    await createQuestion(catId, 'Câu tự soạn S2');

    const res = await http(app).get(`/api/v1/books/${bookId}/questions`).set(bearer(admin));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const rows = res.body as { id: string; qtype: string; category: string }[];
    expect(rows.map((r) => r.id)).toEqual([fromBook]);
    expect(rows[0]).toMatchObject({ qtype: 'multichoice', category: catId });

    const missing = await http(app).get('/api/v1/books/01900000-0000-7000-8000-0000000000cc/questions').set(bearer(admin));
    expect(missing.status).toBe(404);
    expect((missing.body as { code?: string }).code).toBe('book.not_found');
  });
});
