import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import {
  createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId,
} from './course-enrolment-helpers';

/**
 * Lát số hoá đề từ file (issue #52): tải docx/pdf → tách câu thuần quy
 * tắc vào HÀNG ĐỢI DUYỆT → giáo viên sửa + gắn YCCĐ/mức tại bước duyệt →
 * chỉ câu đã duyệt mới vào ngân hàng và dùng được trong quiz. Câu chưa
 * duyệt không được xuất hiện ở bất kỳ luồng dùng câu nào — các khẳng
 * định dưới đây kiểm chứng bất biến đó ở cả API lẫn SQL thô.
 *
 * File đề mẫu: test/fixtures/question-import/de-mau.{docx,pdf} — cùng
 * một đề 7 câu nguồn → 10 mục chờ duyệt (câu đúng–sai chùm nở thành 4).
 */

const FIXTURE_DIR = join(__dirname, 'fixtures', 'question-import');
const DOCX = readFileSync(join(FIXTURE_DIR, 'de-mau.docx'));
const PDF = readFileSync(join(FIXTURE_DIR, 'de-mau.pdf'));
const RANDOM_UUID = '018e0000-0000-7000-8000-000000000000';

interface ImportItem {
  id: string; ordinal: number; sourceNumber: number | null; qtype: string; status: string;
  payload: {
    name: string; qtype: string; questionText: string; defaultMark: number;
    answers: { text: string; fraction: number }[];
    options: { single?: boolean };
    truefalseCorrect: boolean | null;
    outcomeLinks: { outcomeId: string; cognitiveLevel: string }[];
  };
  issues: { severity: string; code: string }[];
  questionId: string | null;
  rawText: string;
}
interface BatchView {
  batch: { id: string; categoryId: string; fileName: string; fileKind: string; status: string; totalItems: number };
  counts: { total: number; pending: number; approved: number; rejected: number };
  items: ImportItem[];
}

describe('Question import from exam files (issue #52)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;
  let teacher: string;
  let teacherId: string;
  let plain: string;
  let categoryId: string;
  let pdfCategoryId: string;
  let outcomeId: string;
  let batchDocx: BatchView;
  let mcQuestionId = '';
  let saQuestionId = '';

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  function upload(token: string, catId: string, buffer: Buffer, filename: string) {
    return http(app).post('/api/v1/question-imports').set(bearer(token))
      .field('categoryId', catId)
      .attach('file', buffer, filename);
  }

  async function bankCount(catId: string): Promise<number> {
    const res = await pg.query('select count(*)::int as n from question where category = $1', [catId]);
    return (res.rows[0] as { n: number }).n;
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    const systemCtxId = await systemContextId(app, admin);

    // Giáo viên: editingteacher tại context hệ thống — có question:add
    // (tải lên/tạo câu) và question:editall (gắn YCCĐ) ở category đích.
    const teacherUser = await createUserViaApi(app, admin);
    teacherId = teacherUser.id;
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), systemCtxId);
    teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    const plainUser = await createUserViaApi(app, admin);
    plain = (await login(app, plainUser.username, STRONG_PASSWORD)).accessToken;

    const mkBankCategory = async (): Promise<string> => {
      const res = await http(app).post('/api/v1/questions/categories').set(bearer(admin))
        .send({ name: uniqueName('bank'), contextId: systemCtxId });
      expect(res.status).toBe(201);
      return (res.body as { id: string }).id;
    };
    categoryId = await mkBankCategory();
    pdfCategoryId = await mkBankCategory();

    // Cây chương trình tối thiểu cho gắn YCCĐ tại bước duyệt.
    const subjectRes = await http(app).post('/api/v1/curriculum/subjects').set(bearer(admin))
      .send({ contextId: systemCtxId, name: 'Môn nhập đề', slug: uniqueName('mon') });
    expect(subjectRes.status).toBe(201);
    const subjectId = (subjectRes.body as { id: string }).id;
    const currRes = await http(app).post('/api/v1/curriculum/curricula').set(bearer(admin))
      .send({ subjectId, grade: 10 });
    expect(currRes.status).toBe(201);
    const curriculumId = (currRes.body as { id: string }).id;
    const nodeRes = await http(app).post('/api/v1/curriculum/nodes').set(bearer(admin))
      .send({ curriculumId, parentId: null, title: 'Chủ đề kiểm chứng', kind: 'topic' });
    expect(nodeRes.status).toBe(201);
    const outcomeRes = await http(app).post('/api/v1/curriculum/outcomes').set(bearer(admin))
      .send({ nodeId: (nodeRes.body as { id: string }).id, content: 'Nhận biết được khái niệm cơ bản.' });
    expect(outcomeRes.status).toBe(201);
    outcomeId = (outcomeRes.body as { id: string }).id;
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  it('tải docx: tách thành 10 mục chờ duyệt, ngân hàng chưa có gì', async () => {
    const res = await upload(teacher, categoryId, DOCX, 'de-mau.docx');
    expect(res.status).toBe(201);
    batchDocx = res.body as BatchView;
    expect(batchDocx.batch.fileKind).toBe('docx');
    expect(batchDocx.batch.status).toBe('in_review');
    expect(batchDocx.counts).toEqual({ total: 10, pending: 10, approved: 0, rejected: 0 });
    expect(batchDocx.items.map((i) => i.qtype)).toEqual([
      'multichoice', 'multichoice', 'truefalse',
      'truefalse', 'truefalse', 'truefalse', 'truefalse',
      'shortanswer', 'essay', 'multichoice',
    ]);
    expect(batchDocx.items[0]!.payload.answers.map((a) => a.fraction)).toEqual([0, 1, 0, 0]);
    expect(batchDocx.items[1]!.payload.answers.map((a) => a.fraction)).toEqual([0.5, 0, 0.5, 0]);
    expect(batchDocx.items[7]!.payload.answers).toEqual([{ text: 'Hà Nội', fraction: 1 }]);
    expect(batchDocx.items.every((i) => i.status === 'pending' && i.questionId === null)).toBe(true);
    expect(batchDocx.items[3]!.payload.questionText).toContain('Cho hàm số y = x^2');

    // Bất biến: chưa duyệt thì ngân hàng không có câu nào của category.
    expect(await bankCount(categoryId)).toBe(0);
    const list = await http(app).get(`/api/v1/questions/categories/${categoryId}/questions`).set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
  });

  it('tải pdf: cùng một đề cho cùng kết quả tách', async () => {
    const res = await upload(teacher, pdfCategoryId, PDF, 'de-mau.pdf');
    expect(res.status).toBe(201);
    const batch = res.body as BatchView;
    expect(batch.batch.fileKind).toBe('pdf');
    expect(batch.items).toHaveLength(10);
    expect(batch.items.map((i) => i.qtype)).toEqual(batchDocx.items.map((i) => i.qtype));
    expect(batch.items[0]!.payload.answers.map((a) => a.fraction)).toEqual([0, 1, 0, 0]);
    expect(batch.items[9]!.payload.answers.map((a) => a.fraction)).toEqual([0, 0, 1, 0]);
    expect(await bankCount(pdfCategoryId)).toBe(0);
  });

  it('cổng quyền và định dạng: người không quyền bị chặn, file sai bị từ chối', async () => {
    // Người dùng thường không có question:add → 403 khi tải lên.
    const denied = await upload(plain, categoryId, DOCX, 'de-mau.docx');
    expect(denied.status).toBe(403);
    // Không phải người tải lên và không có quyền ở category → đợt bị giấu (404).
    const hidden = await http(app).get(`/api/v1/question-imports/${batchDocx.batch.id}`).set(bearer(plain));
    expect(hidden.status).toBe(404);
    const approvalByStranger = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/approve-all`).set(bearer(plain));
    expect(approvalByStranger.status).toBe(404);
    // Danh sách đợt của người ngoài: rỗng.
    const list = await http(app).get('/api/v1/question-imports').set(bearer(plain));
    expect(list.status).toBe(200);
    expect(list.body).toEqual([]);
    // Định dạng không hỗ trợ / file hỏng / category không tồn tại / thiếu file.
    const txt = await upload(teacher, categoryId, Buffer.from('Câu 1: abc'), 'de.txt');
    expect(txt.status).toBe(400);
    expect((txt.body as { code?: string }).code).toBe('question_import.unsupported_file');
    const garbage = await upload(teacher, categoryId, Buffer.from('this is not a docx'), 'de.docx');
    expect(garbage.status).toBe(400);
    expect((garbage.body as { code?: string }).code).toBe('question_import.unreadable_file');
    const noCategory = await upload(teacher, RANDOM_UUID, DOCX, 'de-mau.docx');
    expect(noCategory.status).toBe(404);
    const noFile = await http(app).post('/api/v1/question-imports').set(bearer(teacher)).field('categoryId', categoryId);
    expect(noFile.status).toBe(400);
  });

  it('sửa tại hàng đợi + gắn YCCĐ/mức rồi duyệt: câu vào ngân hàng kèm liên kết', async () => {
    const saItem = batchDocx.items[7]!;
    const patched = await http(app).patch(`/api/v1/question-imports/${batchDocx.batch.id}/items/${saItem.id}`)
      .set(bearer(teacher))
      .send({
        payload: {
          ...saItem.payload,
          answers: [{ text: 'Hà Nội (thủ đô)', fraction: 1 }],
          outcomeLinks: [{ outcomeId, cognitiveLevel: 'hieu' }],
        },
      });
    expect(patched.status).toBe(200);
    expect((patched.body as ImportItem).issues).toEqual([]);
    expect((patched.body as ImportItem).payload.outcomeLinks).toHaveLength(1);

    const approved = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/items/${saItem.id}/approve`).set(bearer(teacher));
    expect(approved.status).toBe(201);
    saQuestionId = (approved.body as { questionId: string }).questionId;
    expect(saQuestionId).toBeTruthy();
    expect((approved.body as { item: ImportItem }).item.status).toBe('approved');

    const view = await http(app).get(`/api/v1/questions/${saQuestionId}`).set(bearer(admin));
    expect(view.status).toBe(200);
    expect((view.body as { question: { qtype: string } }).question.qtype).toBe('shortanswer');
    const answers = (view.body as { answers: { answer: unknown; fraction: number }[] }).answers;
    expect(answers).toHaveLength(1);
    expect(answers[0]!.fraction).toBe(1);
    expect(JSON.stringify(answers[0]!.answer)).toContain('Hà Nội (thủ đô)');

    const links = await http(app).get(`/api/v1/questions/${saQuestionId}/curriculum-links`).set(bearer(admin));
    expect(links.status).toBe(200);
    expect((links.body as { outcomes: unknown[] }).outcomes).toEqual([{ outcomeId, cognitiveLevel: 'hieu' }]);

    // Lọc ngân hàng theo YCCĐ thấy đúng câu vừa duyệt — và chỉ câu đó.
    const filtered = await http(app).get(`/api/v1/questions?outcomeId=${outcomeId}`).set(bearer(admin));
    expect(filtered.status).toBe(200);
    expect((filtered.body as { question: { id: string } }[]).map((v) => v.question.id)).toEqual([saQuestionId]);
    expect(await bankCount(categoryId)).toBe(1);
  });

  it('duyệt câu trắc nghiệm: đáp án vào ngân hàng đúng tỷ trọng; duyệt lại bị 409', async () => {
    const mcItem = batchDocx.items[0]!;
    const approved = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/items/${mcItem.id}/approve`).set(bearer(teacher));
    expect(approved.status).toBe(201);
    mcQuestionId = (approved.body as { questionId: string }).questionId;

    const view = await http(app).get(`/api/v1/questions/${mcQuestionId}`).set(bearer(admin));
    const answers = (view.body as { answers: { fraction: number }[] }).answers;
    expect(answers.map((a) => a.fraction)).toEqual([0, 1, 0, 0]);
    expect((view.body as { options: { single: boolean } }).options.single).toBe(true);

    const again = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/items/${mcItem.id}/approve`).set(bearer(teacher));
    expect(again.status).toBe(409);
    const editApproved = await http(app).patch(`/api/v1/question-imports/${batchDocx.batch.id}/items/${mcItem.id}`)
      .set(bearer(teacher)).send({ payload: mcItem.payload });
    expect(editApproved.status).toBe(409);
  });

  it('mục còn lỗi bị chặn duyệt; từ chối thì ở ngoài ngân hàng vĩnh viễn', async () => {
    const clusterItem = batchDocx.items[3]!;
    const broken = await http(app).patch(`/api/v1/question-imports/${batchDocx.batch.id}/items/${clusterItem.id}`)
      .set(bearer(teacher))
      .send({ payload: { ...clusterItem.payload, truefalseCorrect: null } });
    expect(broken.status).toBe(200);
    expect((broken.body as ImportItem).issues.some((i) => i.code === 'tf_answer_unknown' && i.severity === 'error')).toBe(true);

    const approveBroken = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/items/${clusterItem.id}/approve`).set(bearer(teacher));
    expect(approveBroken.status).toBe(400);
    expect((approveBroken.body as { code?: string }).code).toBe('question_import.item_has_errors');
    expect(await bankCount(categoryId)).toBe(2);

    const rejected = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/items/${clusterItem.id}/reject`).set(bearer(teacher));
    expect(rejected.status).toBe(201);
    expect((rejected.body as ImportItem).status).toBe('rejected');
    const approveRejected = await http(app)
      .post(`/api/v1/question-imports/${batchDocx.batch.id}/items/${clusterItem.id}/approve`).set(bearer(teacher));
    expect(approveRejected.status).toBe(409);
  });

  it('duyệt hàng loạt phần còn lại: đợt hoàn tất, ngân hàng đủ 9 câu', async () => {
    const res = await http(app).post(`/api/v1/question-imports/${batchDocx.batch.id}/approve-all`).set(bearer(teacher));
    expect(res.status).toBe(201);
    const body = res.body as { approved: { itemId: string }[]; skipped: unknown[] };
    expect(body.approved).toHaveLength(7);
    expect(body.skipped).toEqual([]);

    const detail = await http(app).get(`/api/v1/question-imports/${batchDocx.batch.id}`).set(bearer(teacher));
    const view = detail.body as BatchView;
    expect(view.batch.status).toBe('completed');
    expect(view.counts).toEqual({ total: 10, pending: 0, approved: 9, rejected: 1 });
    expect(await bankCount(categoryId)).toBe(9);
    // Đợt pdf vẫn nguyên trạng chờ duyệt và không rò câu nào sang ngân hàng.
    expect(await bankCount(pdfCategoryId)).toBe(0);
  });

  it('câu đã duyệt dùng được trong quiz: học sinh làm bài và được chấm đúng', async () => {
    const courseCat = await createCategory(app, admin);
    const course = await createCourse(app, admin, courseCat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    await assignRole(app, admin, teacherId, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;

    const quizRes = await http(app).post(`/api/v1/courses/${course.id}/quizzes`).set(bearer(teacher))
      .send({ sectionId, name: 'Đề nhập từ file', grade: 10, gradeMethod: 'highest' });
    expect(quizRes.status).toBe(201);
    const quizId = (quizRes.body as { id: string }).id;
    const slotRes = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set(bearer(teacher))
      .send({ questionId: mcQuestionId });
    expect(slotRes.status).toBe(201);

    const start = await http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set(bearer(studentToken)).send({});
    expect(start.status).toBe(201);
    const attemptView = start.body as {
      attempt: { id: string };
      questions: { slot: number; questionAttemptId: string; questionId: string; answers: { id: string; text: unknown }[] }[];
    };
    const q = attemptView.questions.find((x) => x.slot === 1)!;
    expect(q.questionId).toBe(mcQuestionId);
    const paris = q.answers.find((a) => JSON.stringify(a.text).includes('Paris'))!;
    const answered = await http(app).post(`/api/v1/quiz-attempts/${attemptView.attempt.id}/responses`)
      .set(bearer(studentToken)).send({ questionAttemptId: q.questionAttemptId, response: paris.id });
    expect(answered.status).toBe(201);
    const submit = await http(app).post(`/api/v1/quiz-attempts/${attemptView.attempt.id}/submit`)
      .set(bearer(studentToken)).send({});
    expect(submit.status).toBe(201);
    const submitted = submit.body as { attempt: { state: string; sumGrades: number | null; grade: number | null } };
    expect(submitted.attempt.state).toBe('finished');
    expect(submitted.attempt.sumGrades).toBe(1);
    expect(submitted.attempt.grade).toBe(10);
  });
});
