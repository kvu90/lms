import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, createTestApp, createUserViaApi, http, login, STRONG_PASSWORD } from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from '../support/course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from '../support/exam-pin-helpers';

/**
 * Cổng công bố điểm cho điểm TỔNG của bài kiểm tra (issue #411).
 *
 * Quy tắc nghiệp vụ: học viên chỉ thấy điểm ĐÃ CÔNG BỐ. Điểm từng câu
 * vốn đã được gác bằng mặt nạ xem lại (reviewMarks theo cửa sổ), nhưng
 * điểm tổng (grade/sumGrades trong tóm tắt lượt và myGrade ở trang bài
 * kiểm tra) từng bị trả thẳng vô điều kiện ở mọi đường đọc phía chủ
 * lượt. Spec này khoá cả HAI điều kiện độc lập của cổng che điểm tổng:
 *
 *  - (a) mặt nạ điểm ĐÓNG + hạng mục điểm đã công bố (chính sách auto)
 *    → phía học viên vẫn null: điều kiện mặt nạ một mình đã đủ che.
 *  - (b) mặt nạ điểm MỞ + hạng mục điểm manual CHƯA công bố → phía học
 *    viên vẫn null; sau khi giáo viên công bố hạng mục, cùng dữ kiện
 *    đó hiện số thật: điều kiện công bố một mình đã đủ che.
 *  - (c) mặt nạ MỞ + đã công bố → học viên thấy đúng số thật ở mọi bề
 *    mặt (view lượt, danh sách lượt của mình, myGrade).
 *  - (d) lượt đang chờ chấm tay (needsgrading) + chưa công bố → tổng
 *    BÁN PHẦN cũng bị che (null), không lộ qua tóm tắt lượt.
 *  - (e) giáo viên/người có đặc quyền xem CÙNG dữ kiện của ca (b) khi
 *    chưa công bố vẫn thấy đủ số thật ở view lượt, danh sách lượt và
 *    trang kết quả lớp — cổng che chỉ áp phía chủ lượt.
 *
 * Mặt nạ mở trong spec này = reviewMarks 4368 (đủ bốn cửa sổ xem lại)
 * và reviewAttempt 4368 để nội dung lượt luôn xem được; các lượt đều
 * được đọc ngay sau khi nộp, tức trong cửa sổ "ngay sau nộp".
 */
describe('Cổng công bố điểm cho điểm tổng của quiz (#411)', () => {
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

  interface SummaryBody {
    id: string;
    state: string;
    grade: number | null;
    sumGrades: number | null;
  }
  interface AttemptViewBody {
    attempt: SummaryBody;
    questions: { questionId: string; questionAttemptId: string }[];
  }
  interface PinForUserBody {
    myAttempts: SummaryBody[];
    myGrade: number | null;
  }

  const MASK_OPEN = { reviewAttempt: 4368, reviewMarks: 4368 };
  const MASK_MARKS_CLOSED = { reviewAttempt: 4368, reviewMarks: 0 };

  async function setup() {
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: `Publication bank ${Date.now()}`, contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const mkQuestion = async (body: Record<string, unknown>): Promise<string> => {
      const r = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({ categoryId: bankCatId, ...body });
      if (r.status !== 201 && r.status !== 200) throw new Error(`question failed: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body.question.id as string;
    };
    const mcId = await mkQuestion({
      qtype: 'multichoice', questionText: '2 + 2 = ?', defaultMark: 1,
      answers: [
        { text: '4', correct: true },
        { text: '5', correct: false },
        { text: '6', correct: false },
        { text: '3', correct: false },
      ],
    });
    const essayId = await mkQuestion({
      qtype: 'essay', questionText: 'Viết đoạn văn ngắn.', defaultMark: 2,
    });

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const u = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, u.id);
    const student = (await login(app, u.username, STRONG_PASSWORD)).accessToken;

    const teacherView = await http(app).get(`/api/v1/questions/${mcId}`).set('Authorization', `Bearer ${admin}`);
    const correctAnswerId = (teacherView.body.answers as { id: string; isCorrect: boolean }[]).find((a) => a.isCorrect)!.id;

    return { courseId: course.id, sectionId, student, studentId: u.id, mcId, essayId, correctAnswerId };
  }

  type Ctx = Awaited<ReturnType<typeof setup>>;

  /** Ghim một đề chỉ gồm câu trắc nghiệm (tổng thang bài 10) với cấu hình mặt nạ cho trước. */
  async function mkMcQuiz(ctx: Ctx, name: string, extra: Record<string, unknown>): Promise<{ pinId: string; cmId: string }> {
    const draft = await createExamDraft(app, admin, name, 10);
    await addExamSlot(app, admin, draft, { questionId: ctx.mcId });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId, ...extra });
    return { pinId: pin.id as string, cmId: pin.cmId as string };
  }

  /** Ghim một đề trắc nghiệm + tự luận (tổng thang bài 3) để tạo lượt chờ chấm tay. */
  async function mkMixedQuiz(ctx: Ctx, name: string, extra: Record<string, unknown>): Promise<{ pinId: string; cmId: string }> {
    const draft = await createExamDraft(app, admin, name, 3);
    await addExamSlot(app, admin, draft, { questionId: ctx.mcId });
    await addExamSlot(app, admin, draft, { questionId: ctx.essayId });
    const pin = await pinExam(app, admin, ctx.courseId, draft, { sectionId: ctx.sectionId, ...extra });
    return { pinId: pin.id as string, cmId: pin.cmId as string };
  }

  /** Hạng mục điểm gắn với lần ghim (tạo tự động khi ghim đề). */
  async function gradeItemId(cmId: string): Promise<string> {
    const r = await pg.query('SELECT id FROM grade_items WHERE item_type = $1 AND item_instance = $2', ['mod', cmId]);
    if (!r.rows.length) throw new Error(`no grade item for cm ${cmId}`);
    return r.rows[0].id as string;
  }

  async function setManualPolicy(cmId: string): Promise<void> {
    const itemId = await gradeItemId(cmId);
    const r = await http(app).put(`/api/v1/grade-items/${itemId}/posting-policy`)
      .set('Authorization', `Bearer ${admin}`).send({ policy: 'manual' });
    expect(r.status).toBe(200);
    expect(r.body.policy).toBe('manual');
  }

  async function publishItem(cmId: string): Promise<void> {
    const itemId = await gradeItemId(cmId);
    const r = await http(app).post(`/api/v1/grade-items/${itemId}/publish`)
      .set('Authorization', `Bearer ${admin}`).send({});
    expect(r.status === 200 || r.status === 201).toBe(true);
    expect(r.body.published).toBe(true);
  }

  /** Học viên làm đề trắc nghiệm, chọn đáp án ĐÚNG (1/1 điểm) và nộp. */
  async function playMc(ctx: Ctx, pinId: string): Promise<{ attemptId: string; submitBody: AttemptViewBody }> {
    const start = await http(app).post(`/api/v1/exam-pins/${pinId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const view = start.body as AttemptViewBody;
    const mc = view.questions.find((q) => q.questionId === ctx.mcId)!;
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: mc.questionAttemptId, response: ctx.correctAnswerId });
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect((submit.body as AttemptViewBody).attempt.state).toBe('finished');
    return { attemptId: view.attempt.id, submitBody: submit.body as AttemptViewBody };
  }

  /** Học viên làm đề hỗn hợp: trắc nghiệm đúng (1 điểm) + tự luận chờ chấm → lượt needsgrading với tổng bán phần 1. */
  async function playMixed(ctx: Ctx, pinId: string): Promise<{ attemptId: string; submitBody: AttemptViewBody }> {
    const start = await http(app).post(`/api/v1/exam-pins/${pinId}/attempts`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect(start.status === 200 || start.status === 201).toBe(true);
    const view = start.body as AttemptViewBody;
    const mc = view.questions.find((q) => q.questionId === ctx.mcId)!;
    const essay = view.questions.find((q) => q.questionId === ctx.essayId)!;
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: mc.questionAttemptId, response: ctx.correctAnswerId });
    await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: essay.questionAttemptId, response: 'Bài viết của học sinh.' });
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.student}`).send({});
    expect((submit.body as AttemptViewBody).attempt.state).toBe('needsgrading');
    return { attemptId: view.attempt.id, submitBody: submit.body as AttemptViewBody };
  }

  /**
   * Đọc cả ba bề mặt phía học viên của một lượt và khẳng định điểm
   * tổng ở tất cả đều bằng giá trị kỳ vọng (số thật hoặc null).
   */
  async function expectStudentTotals(ctx: Ctx, pinId: string, attemptId: string, expected: { sumGrades: number | null; grade: number | null; myGrade: number | null }): Promise<void> {
    const view = await http(app).get(`/api/v1/quiz-attempts/${attemptId}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(view.status).toBe(200);
    expect((view.body as AttemptViewBody).attempt.sumGrades).toBe(expected.sumGrades);
    expect((view.body as AttemptViewBody).attempt.grade).toBe(expected.grade);

    const pin = await http(app).get(`/api/v1/exam-pins/${pinId}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(pin.status).toBe(200);
    const mine = (pin.body as PinForUserBody).myAttempts.find((a) => a.id === attemptId)!;
    expect(mine.sumGrades).toBe(expected.sumGrades);
    expect(mine.grade).toBe(expected.grade);
    expect((pin.body as PinForUserBody).myGrade).toBe(expected.myGrade);

    const list = await http(app).get(`/api/v1/exam-pins/${pinId}/attempts`).set('Authorization', `Bearer ${ctx.student}`);
    expect(list.status).toBe(200);
    const listed = (list.body as SummaryBody[]).find((a) => a.id === attemptId)!;
    expect(listed.sumGrades).toBe(expected.sumGrades);
    expect(listed.grade).toBe(expected.grade);
  }

  it('(a) mặt nạ điểm đóng + hạng mục đã công bố (auto): điểm tổng phía học viên là null ở mọi bề mặt', async () => {
    const ctx = await setup();
    const { pinId } = await mkMcQuiz(ctx, 'Đề mặt nạ đóng', MASK_MARKS_CLOSED);
    const { attemptId, submitBody } = await playMc(ctx, pinId);

    // Ngay trong view vừa nộp, tổng đã bị che dù dữ kiện thật là 1/1.
    expect(submitBody.attempt.sumGrades).toBeNull();
    expect(submitBody.attempt.grade).toBeNull();
    await expectStudentTotals(ctx, pinId, attemptId, { sumGrades: null, grade: null, myGrade: null });
  });

  it('(b) mặt nạ mở + hạng mục manual chưa công bố: null; sau khi công bố hạng mục thì hiện số thật', async () => {
    const ctx = await setup();
    const { pinId, cmId } = await mkMcQuiz(ctx, 'Đề công bố thủ công', MASK_OPEN);
    await setManualPolicy(cmId);
    const { attemptId, submitBody } = await playMc(ctx, pinId);

    expect(submitBody.attempt.sumGrades).toBeNull();
    expect(submitBody.attempt.grade).toBeNull();
    await expectStudentTotals(ctx, pinId, attemptId, { sumGrades: null, grade: null, myGrade: null });

    // Cùng dữ kiện, chỉ đổi trạng thái công bố → số thật hiện ra:
    // chứng tỏ chính điều kiện công bố là thứ đang gác ở nửa trên.
    await publishItem(cmId);
    await expectStudentTotals(ctx, pinId, attemptId, { sumGrades: 1, grade: 10, myGrade: 10 });
  });

  it('(c) mặt nạ mở + hạng mục đã công bố (auto): học viên thấy đúng số thật ở mọi bề mặt', async () => {
    const ctx = await setup();
    const { pinId } = await mkMcQuiz(ctx, 'Đề công bố tự động', MASK_OPEN);
    const { attemptId, submitBody } = await playMc(ctx, pinId);

    expect(submitBody.attempt.sumGrades).toBe(1);
    expect(submitBody.attempt.grade).toBe(10);
    await expectStudentTotals(ctx, pinId, attemptId, { sumGrades: 1, grade: 10, myGrade: 10 });
  });

  it('(d) lượt needsgrading + hạng mục manual chưa công bố: tổng bán phần bị che (null)', async () => {
    const ctx = await setup();
    const { pinId, cmId } = await mkMixedQuiz(ctx, 'Đề chờ chấm chưa công bố', MASK_OPEN);
    await setManualPolicy(cmId);
    const { attemptId, submitBody } = await playMixed(ctx, pinId);

    // Tổng bán phần thật của lượt là 1 (câu trắc nghiệm đúng, tự luận
    // chưa chấm) — phía học viên không được thấy cả ở view vừa nộp.
    expect(submitBody.attempt.sumGrades).toBeNull();
    expect(submitBody.attempt.grade).toBeNull();
    await expectStudentTotals(ctx, pinId, attemptId, { sumGrades: null, grade: null, myGrade: null });
  });

  it('(e) giáo viên xem cùng dữ kiện chưa công bố vẫn thấy đủ điểm tổng', async () => {
    const ctx = await setup();
    const { pinId, cmId } = await mkMcQuiz(ctx, 'Đề phía giáo viên', MASK_OPEN);
    await setManualPolicy(cmId);
    const { attemptId } = await playMc(ctx, pinId);

    const view = await http(app).get(`/api/v1/quiz-attempts/${attemptId}`).set('Authorization', `Bearer ${admin}`);
    expect(view.status).toBe(200);
    expect((view.body as AttemptViewBody).attempt.sumGrades).toBe(1);
    expect((view.body as AttemptViewBody).attempt.grade).toBe(10);

    const list = await http(app).get(`/api/v1/exam-pins/${pinId}/attempts`).set('Authorization', `Bearer ${admin}`);
    expect(list.status).toBe(200);
    const listed = (list.body as SummaryBody[]).find((a) => a.id === attemptId)!;
    expect(listed.sumGrades).toBe(1);
    expect(listed.grade).toBe(10);

    const results = await http(app).get(`/api/v1/exam-pins/${pinId}/results`).set('Authorization', `Bearer ${admin}`);
    expect(results.status).toBe(200);
    const inResults = (results.body.attempts as SummaryBody[]).find((a) => a.id === attemptId)!;
    expect(inResults.sumGrades).toBe(1);
    expect(inResults.grade).toBe(10);
    const gradeRow = (results.body.gradesByUser as { userId: string; grade: number | null }[]).find((g) => g.userId === ctx.studentId)!;
    expect(gradeRow.grade).toBe(10);
  });
});
