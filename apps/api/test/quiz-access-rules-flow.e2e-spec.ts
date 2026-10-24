import type { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname, STRONG_PASSWORD } from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';

/**
 * Quiz Chặng 2 (issue #30) — quy tắc thi + ghi đè, đối chiếu hồ sơ thiết
 * kế mục B và ngữ nghĩa mod_quiz của Moodle:
 *  - mật khẩu vào thi lưu BĂM (không lộ qua API), sai/thiếu mật khẩu bị
 *    chặn ở server với mã lỗi riêng; subnet kiểm theo IP khách thật cả
 *    khi bắt đầu lượt lẫn khi nộp từng đáp án;
 *  - delay1/delay2: độ trễ bắt buộc giữa các lượt chốt;
 *  - quiz_overrides: hợp nhất theo từng trường user > nhóm (rộng nhất)
 *    > quiz, áp cho cửa sổ mở–đóng, số lượt, giới hạn giờ và cả mốc quá
 *    hạn của lượt đang chạy;
 *  - review options: bitmask 4 cửa sổ của Moodle cổng ở tầng server —
 *    khía cạnh bị tắt thì dữ liệu không rời server cho chủ lượt.
 */
describe('Quiz access rules + overrides (stage 2)', () => {
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

  interface AttemptQuestionBody { slot: number; questionAttemptId: string; fraction: number | null; mark: number | null; rightAnswer: string | null }
  interface AttemptViewBody {
    attempt: { id: string; state: string; preview: boolean };
    questions: AttemptQuestionBody[];
    closedDueToTimeLimit: boolean;
  }

  interface Ctx {
    courseId: string;
    sectionId: string;
    teacher: string;
    studentId: string;
    student: string;
    student2Id: string;
    student2: string;
    qMc: string;
    correctAnswerId: string;
  }

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
    const mkStudent = async () => {
      const u = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, u.id);
      const token = (await login(app, u.username, STRONG_PASSWORD)).accessToken;
      return { id: u.id, token };
    };
    const s1 = await mkStudent();
    const s2 = await mkStudent();
    const systemCtx = (contexts.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    const bankRes = await http(app).post('/api/v1/questions/categories').set('Authorization', `Bearer ${admin}`)
      .send({ name: 'Stage2 bank', contextId: systemCtx.id });
    const bankCatId = bankRes.body.id as string;
    const qRes = await http(app).post('/api/v1/questions').set('Authorization', `Bearer ${admin}`).send({
      categoryId: bankCatId, qtype: 'multichoice', name: 'Capital', questionText: 'Capital of France?', defaultMark: 1,
      answers: [{ text: 'Paris', fraction: 1 }, { text: 'London', fraction: 0 }],
      options: { single: true },
    });
    if (qRes.status !== 201 && qRes.status !== 200) throw new Error(`create question failed: ${qRes.status} ${JSON.stringify(qRes.body)}`);
    const qMc = qRes.body.question.id as string;
    const correctAnswerId = (qRes.body.answers as { id: string; fraction: number }[]).find((a) => a.fraction === 1)!.id;
    return {
      courseId: course.id, sectionId, teacher,
      studentId: s1.id, student: s1.token, student2Id: s2.id, student2: s2.token,
      qMc, correctAnswerId,
    };
  }

  async function createQuizWithSlot(ctx: Ctx, body: Record<string, unknown>): Promise<string> {
    const res = await http(app).post(`/api/v1/courses/${ctx.courseId}/quizzes`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ sectionId: ctx.sectionId, name: 'Stage2 quiz', ...body });
    if (res.status !== 201 && res.status !== 200) throw new Error(`create quiz failed: ${res.status} ${JSON.stringify(res.body)}`);
    const quizId = res.body.id as string;
    const slotRes = await http(app).post(`/api/v1/quizzes/${quizId}/slots`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ questionId: ctx.qMc });
    if (slotRes.status !== 201 && slotRes.status !== 200) throw new Error(`add slot failed: ${slotRes.status} ${JSON.stringify(slotRes.body)}`);
    return quizId;
  }

  async function startAttempt(token: string, quizId: string, body: Record<string, unknown> = {}) {
    return http(app).post(`/api/v1/quizzes/${quizId}/attempts`).set('Authorization', `Bearer ${token}`).send(body);
  }

  async function finishAttemptCorrectly(ctx: Ctx, token: string, quizId: string): Promise<AttemptViewBody> {
    const start = await startAttempt(token, quizId);
    if (start.status !== 201 && start.status !== 200) throw new Error(`start failed: ${start.status} ${JSON.stringify(start.body)}`);
    const view = start.body as AttemptViewBody;
    const q = view.questions.find((x) => x.slot === 1)!;
    const ans = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${token}`)
      .send({ questionAttemptId: q.questionAttemptId, response: ctx.correctAnswerId });
    if (ans.status !== 200 && ans.status !== 201) throw new Error(`answer failed: ${ans.status} ${JSON.stringify(ans.body)}`);
    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set('Authorization', `Bearer ${token}`).send({});
    if (submit.status !== 200 && submit.status !== 201) throw new Error(`submit failed: ${submit.status} ${JSON.stringify(submit.body)}`);
    return submit.body as AttemptViewBody;
  }

  it('password gate: required/incorrect/correct, hash never exposed', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlot(ctx, { password: 'secret1' });
    const missing = await startAttempt(ctx.student, quizId);
    expect(missing.status).toBe(403);
    expect(missing.body.code).toBe('quiz.password_required');
    const wrong = await startAttempt(ctx.student, quizId, { password: 'nope' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('quiz.password_incorrect');
    const info = await http(app).get(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(info.body.quiz.hasPassword).toBe(true);
    expect(info.body.effective.passwordRequired).toBe(true);
    expect(JSON.stringify(info.body)).not.toContain('secret1');
    const ok = await startAttempt(ctx.student, quizId, { password: 'secret1' });
    expect(ok.status === 200 || ok.status === 201).toBe(true);
    // Mật khẩu lưu dạng băm argon2, không phải dạng rõ.
    const rows = await pg.query('SELECT password_hash FROM quizzes WHERE id = $1', [quizId]);
    expect(rows.rows[0].password_hash).toMatch(/^\$argon2/);
  });

  it('subnet gate: denied outside the list, allowed inside, invalid list rejected, re-checked on response', async () => {
    const ctx = await setup();
    const bad = await http(app).post(`/api/v1/courses/${ctx.courseId}/quizzes`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ sectionId: ctx.sectionId, name: 'Bad subnet', subnet: 'not-an-ip' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('quiz.subnet_invalid');

    const deniedQuiz = await createQuizWithSlot(ctx, { subnet: '10.99.0.0/16' });
    const denied = await startAttempt(ctx.student, deniedQuiz);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('quiz.subnet_denied');

    const allowedQuiz = await createQuizWithSlot(ctx, { subnet: '127.0.0.1, 10.0.0.0/8' });
    const start = await startAttempt(ctx.student, allowedQuiz);
    expect(start.status === 200 || start.status === 201).toBe(true);
    const view = start.body as AttemptViewBody;
    // Giáo viên thu hẹp subnet giữa chừng: nộp đáp án từ IP ngoài danh sách bị chặn.
    const patch = await http(app).patch(`/api/v1/quizzes/${allowedQuiz}`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ subnet: '10.99.0.0/16' });
    expect(patch.status).toBe(200);
    const q = view.questions.find((x) => x.slot === 1)!;
    const ans = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ questionAttemptId: q.questionAttemptId, response: ctx.correctAnswerId });
    expect(ans.status).toBe(403);
    expect(ans.body.code).toBe('quiz.subnet_denied');
  });

  it('delay1: next attempt blocked until the delay elapses, lifted when the setting is cleared', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlot(ctx, { delay1Seconds: 3600 });
    await finishAttemptCorrectly(ctx, ctx.student, quizId);
    const blocked = await startAttempt(ctx.student, quizId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('quiz.delay_not_elapsed');
    const info = await http(app).get(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(info.body.attemptBlockedReason).toBe('delay_not_elapsed');
    expect(typeof info.body.effective.nextAttemptAt).toBe('string');
    const patch = await http(app).patch(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ delay1Seconds: null });
    expect(patch.status).toBe(200);
    const ok = await startAttempt(ctx.student, quizId);
    expect(ok.status === 200 || ok.status === 201).toBe(true);
  });

  it('user override widens the open window for that student only; CRUD guards hold', async () => {
    const ctx = await setup();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const quizId = await createQuizWithSlot(ctx, { timeOpen: future });
    const blocked = await startAttempt(ctx.student, quizId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('quiz.not_yet_open');

    // Học sinh không có quyền tạo override.
    const forbidden = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.student}`)
      .send({ userId: ctx.studentId, timeOpen: null });
    expect(forbidden.status).toBe(403);
    // Hai đích cùng lúc bị từ chối.
    const ambiguous = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ userId: ctx.studentId, groupId: ctx.studentId, timeOpen: null });
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.code).toBe('quiz.override_target');

    const created = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ userId: ctx.studentId, timeOpen: new Date(Date.now() - 60_000).toISOString() });
    expect(created.status === 200 || created.status === 201).toBe(true);
    expect(created.body.userId).toBe(ctx.studentId);
    expect(created.body.hasPassword).toBe(false);
    // Trùng đích bị từ chối.
    const dup = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ userId: ctx.studentId, timeOpen: null });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe('quiz.override_exists');

    const ok = await startAttempt(ctx.student, quizId);
    expect(ok.status === 200 || ok.status === 201).toBe(true);
    const stillBlocked = await startAttempt(ctx.student2, quizId);
    expect(stillBlocked.status).toBe(403);
    expect(stillBlocked.body.code).toBe('quiz.not_yet_open');

    // Xoá override thì cửa sổ gốc quay lại hiệu lực.
    const del = await http(app).delete(`/api/v1/quizzes/${quizId}/overrides/${created.body.id}`).set('Authorization', `Bearer ${ctx.teacher}`);
    expect(del.status).toBe(200);
    const info = await http(app).get(`/api/v1/quizzes/${quizId}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(info.body.effective.timeOpen).toBe(future.slice(0, 19) + '.000Z' === future ? future : info.body.effective.timeOpen);
    expect(new Date(info.body.effective.timeOpen).getTime()).toBe(new Date(future).getTime());
  });

  it('group override limits attempts; a user override beats the group value per field', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlot(ctx, { attemptsAllowed: 5 });
    const groupRes = await http(app).post(`/api/v1/courses/${ctx.courseId}/groups`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ name: 'Lop A' });
    expect(groupRes.status === 200 || groupRes.status === 201).toBe(true);
    const groupId = groupRes.body.id as string;
    const member = await http(app).post(`/api/v1/courses/${ctx.courseId}/groups/${groupId}/members`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ userId: ctx.studentId });
    expect(member.status === 200 || member.status === 201).toBe(true);
    const ovr = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ groupId, attempts: 1 });
    expect(ovr.status === 200 || ovr.status === 201).toBe(true);
    expect(ovr.body.groupName).toBe('Lop A');

    await finishAttemptCorrectly(ctx, ctx.student, quizId);
    const blocked = await startAttempt(ctx.student, quizId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('quiz.no_more_attempts');
    // Học sinh không thuộc nhóm không bị giới hạn của nhóm.
    const other = await startAttempt(ctx.student2, quizId);
    expect(other.status === 200 || other.status === 201).toBe(true);

    const userOvr = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ userId: ctx.studentId, attempts: 3 });
    expect(userOvr.status === 200 || userOvr.status === 201).toBe(true);
    const ok = await startAttempt(ctx.student, quizId);
    expect(ok.status === 200 || ok.status === 201).toBe(true);
  });

  it('user override timeClose in the past finalizes an in-progress attempt (effective deadline)', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlot(ctx, {});
    const start = await startAttempt(ctx.student, quizId);
    expect(start.status === 200 || start.status === 201).toBe(true);
    const attemptId = (start.body as AttemptViewBody).attempt.id;
    const ovr = await http(app).post(`/api/v1/quizzes/${quizId}/overrides`).set('Authorization', `Bearer ${ctx.teacher}`)
      .send({ userId: ctx.studentId, timeClose: new Date(Date.now() - 60_000).toISOString() });
    expect(ovr.status === 200 || ovr.status === 201).toBe(true);
    const view = await http(app).get(`/api/v1/quiz-attempts/${attemptId}`).set('Authorization', `Bearer ${ctx.student}`);
    expect(view.body.attempt.state).toBe('finished');
    expect(view.body.closedDueToTimeLimit).toBe(true);
    const blocked = await startAttempt(ctx.student, quizId);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('quiz.closed');
  });

  it('review options gate aspects per window for the owner; teachers are not gated', async () => {
    const ctx = await setup();
    // Cửa sổ hiện tại ngay sau nộp = "ngay sau" (2 phút): correctness/marks
    // chỉ bật ở cửa sổ SAU ĐÓ → ẩn; rightAnswer bật mọi cửa sổ → hiện;
    // reviewAttempt = 0 → nội dung câu bị ẩn hẳn ở mọi cửa sổ sau nộp.
    const quizId = await createQuizWithSlot(ctx, {
      reviewCorrectness: 0x00100 | 0x00010,
      reviewMarks: 0x00100 | 0x00010,
      reviewRightAnswer: 0x10000 | 0x01000 | 0x00100 | 0x00010,
    });
    const submitted = await finishAttemptCorrectly(ctx, ctx.student, quizId);
    expect(submitted.attempt.state).toBe('finished');
    const q1 = submitted.questions.find((x) => x.slot === 1)!;
    expect(q1.fraction).toBeNull();
    expect(q1.mark).toBeNull();
    expect(typeof q1.rightAnswer).toBe('string');
    // Giáo viên xem cùng lượt: không bị cổng.
    const teacherView = await http(app).get(`/api/v1/quiz-attempts/${submitted.attempt.id}`).set('Authorization', `Bearer ${ctx.teacher}`);
    const tq = (teacherView.body as AttemptViewBody).questions.find((x) => x.slot === 1)!;
    expect(tq.fraction).toBe(1);
    expect(tq.mark).toBe(1);

    const hiddenQuiz = await createQuizWithSlot(ctx, { reviewAttempt: 0 });
    const submitted2 = await finishAttemptCorrectly(ctx, ctx.student, hiddenQuiz);
    expect(submitted2.questions).toHaveLength(0);
  });
});
