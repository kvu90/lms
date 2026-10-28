import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken,
  assignRole,
  createTestApp,
  createUserViaApi,
  http,
  login,
  roleIdByShortname,
  STRONG_PASSWORD,
} from '../support/identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from '../support/course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from '../support/exam-pin-helpers';
import { createGradeItem, setGrade } from '../support/assessment-helpers';

/**
 * DASH1 — Dashboard việc cần làm (issue #121, Đợt 6): một endpoint tổng
 * hợp cho khối đầu dashboard. Oracle: issue #121 (việc sắp đến hạn 7
 * ngày; điểm mới CHỈ đã công bố theo cổng PH-0; hàng đợi chấm theo khoá;
 * thẻ khoá màu/biệt danh chỉ chủ nhân thấy) + hồ sơ lộ trình dòng DASH1.
 */
describe('DASH1: dashboard việc cần làm (issue #121)', () => {
  let app: INestApplication;
  let admin: string;
  let pg: Client;

  interface Overview {
    generatedAt: string;
    previousSeenAt: string | null;
    dueItems: { courseId: string; cmId: string; activityId: string; kind: string; name: string; dueAt: string; status: string }[];
    newResults: { courseId: string; kind: string; itemId: string | null; itemName: string | null; finalGrade: number | null; feedback: string | null; changedAt: string }[];
    gradingQueue: { courseId: string; pendingCount: number; assignmentPending: number; quizPending: number; paperPending: number; paperPinId: string | null; oldestPendingAt: string | null }[];
  }

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
  }, 120000);
  afterAll(async () => { await pg.end(); await app.close(); });

  interface Ctx {
    course: { id: string; fullName: string };
    sectionId: string;
    teacher: string;
    student: { id: string };
    studentToken: string;
    student2: { id: string };
    student2Token: string;
  }

  /** Khoá mới + giáo viên editingteacher tại context khoá + 2 học sinh ghi danh. */
  async function setup(): Promise<Ctx> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;
    const student = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const studentToken = (await login(app, student.username, STRONG_PASSWORD)).accessToken;
    const student2 = await createUserViaApi(app, admin);
    await enrolUser(app, admin, course.id, instance.id, student2.id);
    const student2Token = (await login(app, student2.username, STRONG_PASSWORD)).accessToken;
    return { course, sectionId, teacher, student, studentToken, student2, student2Token };
  }

  async function overview(token: string): Promise<Overview> {
    const res = await http(app).get('/api/v1/dashboard/overview').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body as Overview;
  }

  async function createQuizWithMc(ctx: Ctx, overrides: Record<string, unknown>): Promise<{ id: string; cmId: string }> {
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Dash bank', contextId: systemCtx.id });
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({
      categoryId: bankRes.body.id,
      qtype: 'multichoice', questionText: 'Capital of France?', defaultMark: 1,
      answers: [{ text: 'Paris', correct: true }, { text: 'London', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
    });
    const draft = await createExamDraft(app, ctx.teacher, 'Quiz dash');
    await addExamSlot(app, ctx.teacher, draft, { questionId: qRes.body.question.id });
    const pin = await pinExam(app, ctx.teacher, ctx.course.id, draft, { sectionId: ctx.sectionId, ...overrides });
    return pin as unknown as { id: string; cmId: string };
  }

  async function createAssignment(ctx: Ctx, overrides: Record<string, unknown>): Promise<{ id: string; cmId: string }> {
    const res = await http(app).post(`/api/v1/courses/${ctx.course.id}/assignments`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ sectionId: ctx.sectionId, name: 'Bài nộp dash', grade: 10, ...overrides });
    if (res.status !== 200 && res.status !== 201) throw new Error(`create assignment failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async function submitAssignmentFile(token: string, assignmentId: string): Promise<void> {
    const up = await http(app).post(`/api/v1/assignments/${assignmentId}/submission/files`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('anh-bai-lam'), 'bai-lam.jpg');
    expect(up.status).toBe(201);
    const sub = await http(app).post(`/api/v1/assignments/${assignmentId}/submission/submit`).set('Authorization', `Bearer ${token}`);
    expect(sub.status).toBe(201);
  }

  it('việc sắp đến hạn: quiz + assignment trong 7 ngày hiện đúng trạng thái; đã nộp thì biến mất; quá hạn tách lên đầu', async () => {
    const ctx = await setup();
    const inTwoDays = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const inTwentyDays = new Date(Date.now() + 20 * 86_400_000).toISOString();

    const quiz = await createQuizWithMc(ctx, { timeClose: inTwoDays });
    const overdueAssign = await createAssignment(ctx, { dueDate: anHourAgo });
    const farAssign = await createAssignment(ctx, { name: 'Bài xa', dueDate: inTwentyDays });

    let view = await overview(ctx.studentToken);
    let due = view.dueItems.filter((d) => d.courseId === ctx.course.id);
    // Quá hạn lên đầu; bài hạn 20 ngày nằm ngoài cửa sổ 7 ngày thì không hiện.
    expect(due.map((d) => d.kind)).toEqual(['assignment', 'quiz']);
    // ĐX-5 (issue #179): mỗi việc mang activityId = id của instance để web trỏ thẳng trang hoạt động.
    expect(due[0]).toMatchObject({ cmId: overdueAssign.cmId, activityId: overdueAssign.id, status: 'overdue' });
    expect(due[1]).toMatchObject({ cmId: quiz.cmId, activityId: quiz.id, status: 'not_started' });
    expect(due.some((d) => d.cmId === farAssign.cmId)).toBe(false);

    // Bắt đầu làm quiz → in_progress.
    const start = await http(app).post(`/api/v1/exam-pins/${quiz.id}/attempts`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(start.status).toBe(201);
    view = await overview(ctx.studentToken);
    due = view.dueItems.filter((d) => d.courseId === ctx.course.id);
    expect(due.find((d) => d.cmId === quiz.cmId)?.status).toBe('in_progress');

    // Trả lời + nộp xong → biến mất khỏi danh sách.
    const attemptView = start.body as { attempt: { id: string }; questions: { questionAttemptId: string; answers: { id: string; text: unknown }[] }[] };
    const q = attemptView.questions[0]!;
    const paris = q.answers.find((a) => JSON.stringify(a.text).includes('Paris'))!;
    const answered = await http(app).post(`/api/v1/quiz-attempts/${attemptView.attempt.id}/responses`)
      .set('Authorization', `Bearer ${ctx.studentToken}`)
      .send({ questionAttemptId: q.questionAttemptId, response: paris.id });
    expect([200, 201]).toContain(answered.status);
    const submit = await http(app).post(`/api/v1/quiz-attempts/${attemptView.attempt.id}/submit`).set('Authorization', `Bearer ${ctx.studentToken}`).send({});
    expect(submit.status).toBe(201);
    view = await overview(ctx.studentToken);
    due = view.dueItems.filter((d) => d.courseId === ctx.course.id);
    expect(due.some((d) => d.cmId === quiz.cmId)).toBe(false);
    expect(due.some((d) => d.cmId === overdueAssign.cmId)).toBe(true);

    // Người ngoài khoá không thấy việc của khoá này.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const outView = await overview(outsiderToken);
    expect(outView.dueItems.some((d) => d.courseId === ctx.course.id)).toBe(false);
  });

  it('điểm mới: chỉ hiện sau công bố ở item manual; auto hiện ngay khi chấm sau mốc; xem rồi thì không lặp lại', async () => {
    const ctx = await setup();
    const manualItem = await createGradeItem(app, admin, ctx.course.id, { itemName: 'Điểm manual dash', gradeMax: 10 });
    const autoItem = await createGradeItem(app, admin, ctx.course.id, { itemName: 'Điểm auto dash', gradeMax: 10 });
    await setGrade(app, admin, manualItem.id, ctx.student.id, 8, 'Chưa công bố');
    const policy = await http(app).put(`/api/v1/grade-items/${manualItem.id}/posting-policy`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ policy: 'manual' });
    expect(policy.status).toBe(200);

    // Lần xem đầu: tạo mốc, chưa có gì mới.
    const first = await overview(ctx.studentToken);
    expect(first.previousSeenAt).toBeNull();
    expect(first.newResults).toEqual([]);

    // GV chấm thêm điểm manual (sửa điểm + feedback) và chấm item auto SAU mốc.
    await setGrade(app, ctx.teacher, manualItem.id, ctx.student.id, 9, 'Vẫn chưa công bố');
    await setGrade(app, ctx.teacher, autoItem.id, ctx.student.id, 7, 'Tốt');

    const second = await overview(ctx.studentToken);
    // Item auto đã công bố (auto) → hiện; item manual chưa công bố → KHÔNG
    // lọt dưới bất kỳ hình thức nào (kiểm cả thân JSON thô).
    expect(second.newResults.map((r) => r.itemId)).toEqual([autoItem.id]);
    expect(JSON.stringify(second)).not.toContain(manualItem.id);
    expect(JSON.stringify(second)).not.toContain('Vẫn chưa công bố');

    // GV công bố item manual → điểm hiện tại lần xem sau, dù điểm chấm
    // TRƯỚC thời điểm công bố (thời điểm hiệu lực = lúc công bố).
    const publish = await http(app).post(`/api/v1/grade-items/${manualItem.id}/publish`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({});
    expect([200, 201]).toContain(publish.status);
    const third = await overview(ctx.studentToken);
    expect(third.newResults.map((r) => r.itemId)).toEqual([manualItem.id]);
    expect(third.newResults[0]).toMatchObject({ finalGrade: 9, feedback: 'Vẫn chưa công bố' });

    // Xem tiếp: không còn gì mới (mốc đã lăn).
    const fourth = await overview(ctx.studentToken);
    expect(fourth.newResults).toEqual([]);

    // Điểm của học sinh khác không lọt vào danh sách của học sinh này.
    await setGrade(app, ctx.teacher, autoItem.id, ctx.student2.id, 5);
    const fifth = await overview(ctx.studentToken);
    expect(fifth.newResults).toEqual([]);
  });

  it('hàng đợi chấm: GV thấy đúng số theo khoá; chấm + trả bài một bài thì số giảm tương ứng', async () => {
    const ctx = await setup();
    const assignment = await createAssignment(ctx, { dueDate: new Date(Date.now() + 86_400_000).toISOString() });
    await submitAssignmentFile(ctx.studentToken, assignment.id);
    await submitAssignmentFile(ctx.student2Token, assignment.id);

    let view = await overview(ctx.teacher);
    let queue = view.gradingQueue.find((q) => q.courseId === ctx.course.id);
    expect(queue).toMatchObject({ pendingCount: 2, assignmentPending: 2, quizPending: 0 });
    expect(queue?.oldestPendingAt).toBeTruthy();

    // Học sinh không thấy hàng đợi chấm.
    const studentView = await overview(ctx.studentToken);
    expect(studentView.gradingQueue).toEqual([]);

    // GV chấm nháp 1 bài nhưng CHƯA trả → vẫn còn chờ (chưa xong việc).
    const graded = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/grade`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({ grade: 9 });
    expect([200, 201]).toContain(graded.status);
    view = await overview(ctx.teacher);
    queue = view.gradingQueue.find((q) => q.courseId === ctx.course.id);
    expect(queue?.pendingCount).toBe(2);

    // Trả bài → số giảm còn 1.
    const released = await http(app).post(`/api/v1/assignments/${assignment.id}/submissions/${ctx.student.id}/release`)
      .set('Authorization', `Bearer ${ctx.teacher}`).send({});
    expect([200, 201]).toContain(released.status);
    view = await overview(ctx.teacher);
    queue = view.gradingQueue.find((q) => q.courseId === ctx.course.id);
    expect(queue).toMatchObject({ pendingCount: 1, assignmentPending: 1 });
  });

  it('hàng đợi chấm — phiếu giấy CAM-0 (#187): đếm tách bạch hai trạng thái chờ, deep-link về quiz có phiếu chờ lâu nhất, xử lý hết thì về 0, GV khác không thấy', async () => {
    const ctx = await setup();
    const quizA = await createQuizWithMc(ctx, { name: 'Quiz giấy A' });
    const quizB = await createQuizWithMc(ctx, { name: 'Quiz giấy B' });

    // Chèn thẳng phiếu quét vào DB (đường tắt fixture như các spec CAM-0
    // vẫn dùng pg Client): file_id/uploaded_by là uuid không FK.
    const uploader = ctx.student.id;
    const insertScan = async (quizId: string, status: string, createdAt: string) => {
      await pg.query(
        `INSERT INTO exam_scans (exam_pin_id, file_id, status, uploaded_by, created_at, updated_at)
         VALUES ($1, gen_random_uuid(), $2, $3, $4, $4)`,
        [quizId, status, uploader, createdAt],
      );
    };
    const threeHoursAgo = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    // Quiz A: 1 needs_review (lâu nhất toàn khoá) + 1 needs_identity.
    await insertScan(quizA.id, 'needs_review', threeHoursAgo);
    await insertScan(quizA.id, 'needs_identity', anHourAgo);
    // Quiz B: 1 needs_review mới hơn phiếu lâu nhất của A.
    await insertScan(quizB.id, 'needs_review', twoHoursAgo);
    // Hai trạng thái KHÔNG chờ: không được đếm.
    await insertScan(quizA.id, 'ready', anHourAgo);
    await insertScan(quizB.id, 'recorded', anHourAgo);

    let view = await overview(ctx.teacher);
    let queue = view.gradingQueue.find((q) => q.courseId === ctx.course.id);
    // 3 phiếu chờ, tách bạch khỏi bài nộp/lượt quiz; đích deep-link là
    // quiz A (phiếu chờ lâu nhất); mốc chờ lâu nhất lấy từ phiếu giấy.
    expect(queue).toMatchObject({
      pendingCount: 3, assignmentPending: 0, quizPending: 0,
      paperPending: 3, paperPinId: quizA.id,
    });
    expect(new Date(queue!.oldestPendingAt!).getTime()).toBe(new Date(threeHoursAgo).getTime());

    // Học sinh không thấy hàng đợi; GV của khoá khác không thấy đếm này.
    const studentView = await overview(ctx.studentToken);
    expect(studentView.gradingQueue).toEqual([]);
    const otherCtx = await setup();
    const otherView = await overview(otherCtx.teacher);
    expect(otherView.gradingQueue.some((q) => q.courseId === ctx.course.id)).toBe(false);

    // Xử lý hết phiếu chờ (chuyển sang recorded) → đếm về 0, khoá biến
    // mất khỏi hàng đợi vì không còn việc chờ nào khác.
    await pg.query(
      `UPDATE exam_scans SET status = 'recorded'
       WHERE exam_pin_id = ANY($1) AND status IN ('needs_review', 'needs_identity')`,
      [[quizA.id, quizB.id]],
    );
    view = await overview(ctx.teacher);
    expect(view.gradingQueue.some((q) => q.courseId === ctx.course.id)).toBe(false);
  });

  it('thẻ khoá: đặt màu/biệt danh lưu được, chỉ chủ nhân thấy; người ngoài khoá không đặt được cho khoá', async () => {
    const ctx = await setup();
    const put = await http(app).put(`/api/v1/dashboard/course-cards/${ctx.course.id}`)
      .set('Authorization', `Bearer ${ctx.studentToken}`).send({ color: 'teal', nickname: 'Toán của tui' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ courseId: ctx.course.id, color: 'teal', nickname: 'Toán của tui' });

    const mine = await http(app).get('/api/v1/dashboard/course-cards').set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.prefs).toEqual([
      { courseId: ctx.course.id, color: 'teal', nickname: 'Toán của tui' },
    ]);

    // Học sinh khác trong cùng khoá không thấy biệt danh của người này.
    const other = await http(app).get('/api/v1/dashboard/course-cards').set('Authorization', `Bearer ${ctx.student2Token}`);
    expect(other.body.prefs).toEqual([]);

    // Người ngoài khoá không đặt được pref cho khoá.
    const outsider = await createUserViaApi(app, admin);
    const outsiderToken = (await login(app, outsider.username, STRONG_PASSWORD)).accessToken;
    const denied = await http(app).put(`/api/v1/dashboard/course-cards/${ctx.course.id}`)
      .set('Authorization', `Bearer ${outsiderToken}`).send({ color: 'red' });
    expect(denied.status).toBe(403);

    // Màu ngoài bảng cho phép bị từ chối ở tầng schema.
    const badColor = await http(app).put(`/api/v1/dashboard/course-cards/${ctx.course.id}`)
      .set('Authorization', `Bearer ${ctx.studentToken}`).send({ color: 'chartreuse' });
    expect(badColor.status).toBe(400);

    // Xoá pref: cả hai giá trị null → danh sách trống lại.
    const cleared = await http(app).put(`/api/v1/dashboard/course-cards/${ctx.course.id}`)
      .set('Authorization', `Bearer ${ctx.studentToken}`).send({ color: null, nickname: null });
    expect(cleared.status).toBe(200);
    const after = await http(app).get('/api/v1/dashboard/course-cards').set('Authorization', `Bearer ${ctx.studentToken}`);
    expect(after.body.prefs).toEqual([]);
  });
});
