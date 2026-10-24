import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QuestionsService } from '../src/modules/questions/questions.service';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory as createCourseCategory, createCourse } from './course-enrolment-helpers';

/**
 * Issue #55 — gác quyền ĐỌC ngân hàng câu hỏi theo capability.
 *
 * Oracle: chuẩn các cổng đã chốt ở #44/#48 — vai không có capability đọc
 * ngân hàng (`question:useall` tại context của category chứa dữ liệu)
 * nhận 404 mang mã của tài nguyên không tồn tại, và response TUYỆT ĐỐI
 * không chứa nội dung câu hỏi/đáp án (không oracle tồn tại). Giáo viên
 * có `editingteacher` tại context khoá đọc được ngân hàng của khoá đó
 * nhưng không đọc được ngân hàng ở context hệ thống — cùng quy tắc mà
 * các đường ghi (question:add/editall/managecategory) đã áp. Luồng làm
 * bài của học sinh qua question engine (hoạt động tạo usage, học sinh
 * start/submit/finish) không đổi.
 */
describe('Question bank read gate (issue #55)', () => {
  let app: INestApplication;
  let admin: string;
  let teacher: string;
  let student: string;
  let studentId: string;
  let systemCtxId: string;
  let courseCtxId: string;
  let courseCatId: string;
  let systemCatId: string;
  let questionId: string;
  let systemQuestionId: string;
  let stimulusId: string;
  let teacherUsageId: string;

  const SECRET_TEXT = 'QBANK-SECRET-QUESTION-TEXT';
  const SECRET_NAME = 'QBANK-SECRET-QUESTION-NAME';
  const SYSTEM_SECRET = 'QBANK-SYSTEM-SECRET-TEXT';

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    systemCtxId = await systemContextId(app, admin);

    // Khoá + context khoá; giáo viên được gán editingteacher tại context khoá.
    const courseCategory = await createCourseCategory(app, admin);
    const course = await createCourse(app, admin, courseCategory.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    courseCtxId = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!.id;

    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtxId);
    teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    const studentUser = await createUserViaApi(app, admin);
    studentId = studentUser.id;
    student = (await login(app, studentUser.username, STRONG_PASSWORD)).accessToken;

    // Ngân hàng ở context khoá (admin tạo) + ngân hàng ở context hệ thống.
    const courseCat = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: uniqueName('coursebank'), contextId: courseCtxId });
    expect(courseCat.status).toBeLessThan(300);
    courseCatId = courseCat.body.id as string;
    const systemCat = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: uniqueName('systembank'), contextId: systemCtxId });
    expect(systemCat.status).toBeLessThan(300);
    systemCatId = systemCat.body.id as string;

    const q = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: courseCatId, qtype: 'truefalse', name: SECRET_NAME, questionText: SECRET_TEXT, answer: { correct: true } });
    expect(q.status).toBeLessThan(300);
    questionId = q.body.question.id as string;
    // Version 2 để endpoint versions có dữ liệu thật.
    const edit = await http(app).patch(`/api/v1/questions/${questionId}`).set('Authorization', `Bearer ${admin}`)
      .send({ questionText: `${SECRET_TEXT} v2` });
    expect(edit.status).toBe(200);

    const sysQ = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: systemCatId, qtype: 'truefalse', name: 'System bank q', questionText: SYSTEM_SECRET, answer: { correct: false } });
    expect(sysQ.status).toBeLessThan(300);
    systemQuestionId = sysQ.body.question.id as string;

    const stim = await http(app).post('/api/v1/stimuli').set('Authorization', `Bearer ${admin}`)
      .send({ categoryId: courseCatId, content: 'QBANK-SECRET-STIMULUS' });
    expect(stim.status).toBeLessThan(300);
    stimulusId = stim.body.id as string;

    // Giáo viên tạo usage trên câu của khoá mình (đường làm thử của ngân hàng).
    const usage = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${teacher}`)
      .send({ component: 'mod_quiz', slots: [{ questionId }] });
    expect(usage.status).toBeLessThan(300);
    teacherUsageId = usage.body.usage.id as string;
  });
  afterAll(async () => { await app.close(); });

  function expectNoBankContent(res: { body: unknown }) {
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(SECRET_TEXT);
    expect(raw).not.toContain(SECRET_NAME);
    expect(raw).not.toContain(SYSTEM_SECRET);
    expect(raw).not.toContain('QBANK-SECRET-STIMULUS');
  }

  it('student reads no bank data through any read endpoint (404, no content, no existence oracle)', async () => {
    const attempts: [string, string][] = [
      ['categories of the course context', `/api/v1/questions/categories?contextId=${courseCtxId}`],
      ['questions in course category', `/api/v1/questions/categories/${courseCatId}/questions`],
      ['question detail', `/api/v1/questions/${questionId}`],
      ['question versions', `/api/v1/questions/${questionId}/versions`],
      ['question curriculum links', `/api/v1/questions/${questionId}/curriculum-links`],
      ['stimuli of course category', `/api/v1/stimuli?categoryId=${courseCatId}`],
      ['stimulus detail', `/api/v1/stimuli/${stimulusId}`],
      ['teacher usage detail', `/api/v1/question-usages/${teacherUsageId}`],
    ];
    for (const [label, url] of attempts) {
      const res = await http(app).get(url).set('Authorization', `Bearer ${student}`);
      expect(res.status, label).toBe(404);
      expectNoBankContent(res);
    }
    // Mã lỗi của câu hỏi bị cấm giống hệt câu hỏi không tồn tại.
    const forbidden = await http(app).get(`/api/v1/questions/${questionId}`).set('Authorization', `Bearer ${student}`);
    const missing = await http(app).get('/api/v1/questions/01900000-0000-7000-8000-000000000000').set('Authorization', `Bearer ${student}`);
    expect(forbidden.status).toBe(missing.status);
    expect((forbidden.body as { code: string }).code).toBe((missing.body as { code: string }).code);

    // Danh sách category không lọc theo context: category ngoài quyền không xuất hiện.
    const cats = await http(app).get('/api/v1/questions/categories').set('Authorization', `Bearer ${student}`);
    expect(cats.status).toBe(200);
    const catIds = (cats.body as { id: string }[]).map((c) => c.id);
    expect(catIds).not.toContain(courseCatId);
    expect(catIds).not.toContain(systemCatId);

    // Bộ lọc chương trình: học sinh không thấy câu nào của ngân hàng.
    const filtered = await http(app).get('/api/v1/questions').set('Authorization', `Bearer ${student}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body as unknown[]).toHaveLength(0);

    // Tạo usage thô trên câu ngân hàng: cửa vào của đường đọc đáp án — bị chặn.
    const create = await http(app).post('/api/v1/question-usages').set('Authorization', `Bearer ${student}`)
      .send({ component: 'mod_quiz', slots: [{ questionId }] });
    expect(create.status).toBe(404);
    expectNoBankContent(create);
  });

  it('teacher with editingteacher at the course context uses that course bank normally', async () => {
    const cats = await http(app).get('/api/v1/questions/categories').set('Authorization', `Bearer ${teacher}`);
    const catIds = (cats.body as { id: string }[]).map((c) => c.id);
    expect(catIds).toContain(courseCatId);
    // Ngân hàng hệ thống nằm ngoài context của giáo viên này — không hiện.
    expect(catIds).not.toContain(systemCatId);

    const list = await http(app).get(`/api/v1/questions/categories/${courseCatId}/questions`).set('Authorization', `Bearer ${teacher}`);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain(SECRET_TEXT);

    const detail = await http(app).get(`/api/v1/questions/${questionId}`).set('Authorization', `Bearer ${teacher}`);
    expect(detail.status).toBe(200);
    expect(detail.body.question.id).toBe(questionId);
    expect((detail.body.answers as unknown[]).length).toBeGreaterThan(0);

    const versions = await http(app).get(`/api/v1/questions/${questionId}/versions`).set('Authorization', `Bearer ${teacher}`);
    expect(versions.status).toBe(200);
    expect((versions.body as unknown[]).length).toBe(2);

    const links = await http(app).get(`/api/v1/questions/${questionId}/curriculum-links`).set('Authorization', `Bearer ${teacher}`);
    expect(links.status).toBe(200);
    expect(links.body.questionId).toBe(questionId);

    const stimuli = await http(app).get(`/api/v1/stimuli?categoryId=${courseCatId}`).set('Authorization', `Bearer ${teacher}`);
    expect(stimuli.status).toBe(200);
    expect((stimuli.body as { id: string }[]).map((s) => s.id)).toContain(stimulusId);
    const stimulus = await http(app).get(`/api/v1/stimuli/${stimulusId}`).set('Authorization', `Bearer ${teacher}`);
    expect(stimulus.status).toBe(200);

    // Bộ lọc chương trình: thấy câu của khoá mình, không thấy câu hệ thống.
    const filtered = await http(app).get('/api/v1/questions').set('Authorization', `Bearer ${teacher}`);
    const ids = (filtered.body as { question: { id: string } }[]).map((v) => v.question.id);
    expect(ids).toContain(questionId);
    expect(ids).not.toContain(systemQuestionId);

    // Usage tự tạo đọc lại được (chủ sở hữu).
    const own = await http(app).get(`/api/v1/question-usages/${teacherUsageId}`).set('Authorization', `Bearer ${teacher}`);
    expect(own.status).toBe(200);
    expect(own.body.usage.id).toBe(teacherUsageId);
  });

  it('teacher does NOT read the system-context bank (context scoping matches the write gate)', async () => {
    const detail = await http(app).get(`/api/v1/questions/${systemQuestionId}`).set('Authorization', `Bearer ${teacher}`);
    expect(detail.status).toBe(404);
    expectNoBankContent(detail);
    const list = await http(app).get(`/api/v1/questions/categories/${systemCatId}/questions`).set('Authorization', `Bearer ${teacher}`);
    expect(list.status).toBe(404);
  });

  it('admin reads everything; usage of others is visible to the bank team', async () => {
    const detail = await http(app).get(`/api/v1/questions/${systemQuestionId}`).set('Authorization', `Bearer ${admin}`);
    expect(detail.status).toBe(200);
    const usage = await http(app).get(`/api/v1/question-usages/${teacherUsageId}`).set('Authorization', `Bearer ${admin}`);
    expect(usage.status).toBe(200);
  });

  it('category creation reports the true cause: unknown context is a 400, not a capability error', async () => {
    const bogus = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: uniqueName('bogusctx'), contextId: '01900000-0000-7000-8000-000000000000' });
    expect(bogus.status).toBe(400);
    expect((bogus.body as { code: string }).code).toBe('question.category_context_not_found');

    // Giáo viên tạo danh mục lần đầu tại context khoá của mình: chạy trơn.
    const own = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${teacher}`)
      .send({ name: uniqueName('teachercat'), contextId: courseCtxId });
    expect(own.status).toBeLessThan(300);
    // ...nhưng tại context hệ thống thì lỗi capability là nguyên nhân thật và giữ nguyên.
    const sys = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${teacher}`)
      .send({ name: uniqueName('teachercat'), contextId: systemCtxId });
    expect(sys.status).toBe(403);
    expect((sys.body as { code: string }).code).toBe('access.capability_denied');
  });

  it('student attempt flow through the engine is untouched (activity-created usage)', async () => {
    // Mẫu dựng sau khi #60 + #55 cùng có mặt trên main: usage của lượt
    // làm thật do HOẠT ĐỘNG tạo ở tầng service với actor là chính học
    // sinh (mô hình mà assertCanCreateUsage của #55 ghi: cổng tạo chỉ áp
    // ở controller, quiz tạo usage ở tầng service bằng actor là học
    // sinh) — chủ sở hữu usage là học sinh nên các thao tác thô
    // start/submit/finish của chính chủ qua cổng #60 bình thường.
    // Trước đây spec cho admin tạo usage qua HTTP rồi học sinh thao
    // tác: lệch chủ sở hữu nên #60 chặn 404 — đó là đổi mẫu dựng dữ
    // liệu, mọi assertion hành vi bên dưới giữ nguyên.
    const created = await app.get(QuestionsService).createUsage(studentId, {
      component: 'mod_quiz', slots: [{ questionId }],
    });
    const usageId = created.usage.id as string;
    const attemptId = created.attempts[0].id as string;

    const start = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/start`)
      .set('Authorization', `Bearer ${student}`);
    expect(start.status).toBeLessThan(300);
    const submit = await http(app).post(`/api/v1/question-usages/${usageId}/attempts/${attemptId}/submit`)
      .set('Authorization', `Bearer ${student}`).send({ response: 'true' });
    expect(submit.status).toBeLessThan(300);
    const finished = await http(app).post(`/api/v1/question-usages/${usageId}/finish`)
      .set('Authorization', `Bearer ${student}`);
    expect(finished.status).toBeLessThan(300);
    expect(finished.body.state).toBe('finished');
    expect(finished.body.attempts[0].state).toBe('gradedright');
  });
});
