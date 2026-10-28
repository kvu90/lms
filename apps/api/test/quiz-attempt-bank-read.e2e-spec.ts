import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminToken, assignRole, createTestApp, createUserViaApi, http, login,
  roleIdByShortname, STRONG_PASSWORD, systemContextId, uniqueName,
} from './identity-access-helpers';
import { createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId } from './course-enrolment-helpers';
import { addExamSlot, createExamDraft, pinExam } from './exam-pin-helpers';

/**
 * Issue #141 — kiểm chứng yêu cầu nghiệp vụ: phân quyền đọc câu hỏi phải
 * theo cây CONTEXT của hoạt động (kiểu Moodle), KHÔNG theo nhãn scope
 * của bank. Nếu đường attempt lỡ gác theo bank/scope thì học sinh không
 * đọc được câu khi làm bài.
 *
 * Oracle: với TỪNG nguồn bank — bank trường (school), bank tổ (team),
 * bank cá nhân của giáo viên (personal) — giáo viên đưa câu (gồm câu kèm
 * ngữ liệu/stimulus) vào slot quiz của một khoá; học sinh đã ghi danh
 * bắt đầu attempt thì phải ĐỌC được trọn vẹn thân câu + đáp án + ngữ
 * liệu, trả lời và nộp được, điểm chốt đúng. Học sinh ngoài khoá bị
 * chặn ở cổng hoạt động. Và bề mặt duyệt ngân hàng (*ForViewer của #55,
 * siết thêm ở #123) VẪN 404 với học sinh đối với chính các câu đó —
 * đọc được trong attempt không được rò sang duyệt bank.
 */

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface BankBody {
  id: string; scope: string; ownerId: string | null; defaultCategoryId: string | null;
}
interface AttemptQuestionBody {
  slot: number; questionAttemptId: string; questionId: string; qtype: string;
  questionText: unknown; stimulus: { id: string; content: unknown } | null;
  answers: { id: string; text: unknown }[];
  fraction: number | null; mark: number | null; state: string;
}
interface AttemptViewBody {
  attempt: { id: string; state: string; sumGrades: number | null; grade: number | null; preview: boolean };
  questions: AttemptQuestionBody[];
}

const plain = (doc: unknown): string => JSON.stringify(doc ?? '');

describe('Attempt question reading across bank sources (issue #141)', () => {
  let app: INestApplication;
  let admin: string;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await adminToken(app);
  }, 180_000);
  afterAll(async () => { await app.close(); });

  async function mkUser(): Promise<{ id: string; username: string; token: string }> {
    const u = await createUserViaApi(app, admin);
    const session = await login(app, u.username, STRONG_PASSWORD);
    return { id: u.id, username: u.username, token: session.accessToken };
  }

  /** Giáo viên: archetype staff tại hệ thống (điều kiện có bank cá nhân). */
  async function mkStaffUser() {
    const u = await mkUser();
    await assignRole(app, admin, u.id, await roleIdByShortname(app, admin, 'teacher'), await systemContextId(app, admin));
    return u;
  }

  async function createStimulus(token: string, categoryId: string, marker: string): Promise<string> {
    const res = await http(app).post('/api/v1/stimuli').set(bearer(token))
      .send({ categoryId, content: `NGU-LIEU-${marker}: đoạn văn dùng cho câu hỏi kèm ngữ liệu.` });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    return res.body.id as string;
  }

  async function createMc(token: string, categoryId: string, marker: string): Promise<string> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'multichoice', questionText: `THAN-CAU-${marker}: chọn đáp án đúng?`,
      defaultMark: 1,
      answers: [{ text: `DUNG-${marker}`, correct: true }, { text: `SAI-${marker}`, correct: false }, { text: `SAI2-${marker}`, correct: false }, { text: `SAI3-${marker}`, correct: false }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.question.id as string;
  }

  async function createTfWithStimulus(token: string, categoryId: string, marker: string, stimulusId: string): Promise<string> {
    const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
      categoryId, qtype: 'truefalse',
      questionText: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: `THAN-CAU-TF-${marker}: đoạn văn nói đúng nội dung?` }] },
          {
            type: 'statementList',
            content: [1, 2, 3, 4].map((i) => ({
              type: 'statement',
              attrs: { id: `s${i}` },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: `Mệnh đề ${i} của ${marker}` }] }],
            })),
          },
        ],
      },
      defaultMark: 1, stimulusId,
      solution: { answers: [1, 2, 3, 4].map((i) => ({ statementId: `s${i}`, value: true })) },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.question.id as string;
  }

  interface SourceCtx {
    teacher: { id: string; token: string };
    student: { id: string; token: string };
    outsider: { id: string; token: string };
    courseId: string;
    sectionId: string;
    schoolCatId: string;
    teamCatId: string;
    personalCatId: string;
    personalStimulusId: string;
    schoolStimulusId: string;
    teamStimulusId: string;
    q: Record<'school' | 'team' | 'personal', { mc: string; tf: string }>;
  }

  let ctxPromise: Promise<SourceCtx> | null = null;
  function setup(): Promise<SourceCtx> {
    if (!ctxPromise) ctxPromise = buildSetup();
    return ctxPromise;
  }

  async function buildSetup(): Promise<SourceCtx> {
    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;

    const teacher = await mkStaffUser();
    await assignRole(app, admin, teacher.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const student = await mkUser();
    await enrolUser(app, admin, course.id, instance.id, student.id);
    const outsider = await mkUser();

    // Bank trường: singleton scope school; admin là người có quyền thêm câu.
    const adminBanks = await http(app).get('/api/v1/question-banks').set(bearer(admin));
    expect(adminBanks.status).toBe(200);
    const school = (adminBanks.body as BankBody[]).find((b) => b.scope === 'school')!;
    expect(school?.defaultCategoryId).toBeTruthy();
    const schoolCatId = school.defaultCategoryId!;

    // Bank tổ: cohort do giáo viên làm tổ trưởng.
    const cohortRes = await http(app).post('/api/v1/cohorts').set(bearer(admin)).send({ name: uniqueName('To kiem chung 141') });
    expect(cohortRes.status, JSON.stringify(cohortRes.body)).toBe(201);
    const cohortId = (cohortRes.body as { id: string }).id;
    const addMember = await http(app).post(`/api/v1/cohorts/${cohortId}/members`).set(bearer(admin)).send({ userId: teacher.id });
    expect(addMember.status).toBe(201);
    const teamRes = await http(app).post('/api/v1/question-banks').set(bearer(admin))
      .send({ name: 'Ngân hàng tổ kiểm chứng 141', scope: 'team', scopeRefId: cohortId, leaderId: teacher.id });
    expect(teamRes.status, JSON.stringify(teamRes.body)).toBe(201);
    const teamCatId = (teamRes.body as BankBody).defaultCategoryId!;

    // Bank cá nhân của giáo viên.
    const teacherBanks = await http(app).get('/api/v1/question-banks').set(bearer(teacher.token));
    const personal = (teacherBanks.body as BankBody[]).find((b) => b.scope === 'personal' && b.ownerId === teacher.id)!;
    expect(personal?.defaultCategoryId).toBeTruthy();
    const personalCatId = personal.defaultCategoryId!;

    // Câu cho từng nguồn: 1 trắc nghiệm thường + 1 đúng/sai kèm ngữ liệu.
    const schoolStimulusId = await createStimulus(admin, schoolCatId, 'TRUONG-141');
    const teamStimulusId = await createStimulus(teacher.token, teamCatId, 'TO-141');
    const personalStimulusId = await createStimulus(teacher.token, personalCatId, 'CANHAN-141');
    const q = {
      school: {
        mc: await createMc(admin, schoolCatId, 'TRUONG-141'),
        tf: await createTfWithStimulus(admin, schoolCatId, 'TRUONG-141', schoolStimulusId),
      },
      team: {
        mc: await createMc(teacher.token, teamCatId, 'TO-141'),
        tf: await createTfWithStimulus(teacher.token, teamCatId, 'TO-141', teamStimulusId),
      },
      personal: {
        mc: await createMc(teacher.token, personalCatId, 'CANHAN-141'),
        tf: await createTfWithStimulus(teacher.token, personalCatId, 'CANHAN-141', personalStimulusId),
      },
    };
    return {
      teacher, student, outsider, courseId: course.id, sectionId,
      schoolCatId, teamCatId, personalCatId, personalStimulusId, schoolStimulusId, teamStimulusId, q,
    };
  }

  async function createQuizWithSlots(teacherToken: string, courseId: string, sectionId: string, name: string, questionIds: string[]): Promise<string> {
    // Hành trình gộp Đề (#226): soạn đề trong bank của giáo viên →
    // ready → ghim vào khoá; trả id của lần ghim.
    const draft = await createExamDraft(app, teacherToken, name, 10);
    for (const questionId of questionIds) {
      await addExamSlot(app, teacherToken, draft, { questionId });
    }
    const pin = await pinExam(app, teacherToken, courseId, draft, { sectionId });
    return pin.id as string;
  }

  /** Chạy trọn một lượt của học sinh ghi danh cho một nguồn bank và khẳng định đọc được trọn vẹn. */
  async function playAndAssertReadable(
    ctx: SourceCtx, quizId: string, marker: string, mcId: string, tfId: string,
  ): Promise<AttemptViewBody> {
    const info = await http(app).get(`/api/v1/exam-pins/${quizId}`).set(bearer(ctx.student.token));
    expect(info.status).toBe(200);
    expect(info.body.canAttempt).toBe(true);

    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set(bearer(ctx.student.token)).send({});
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    let view = start.body as AttemptViewBody;
    expect(view.questions).toHaveLength(2);

    const mc = view.questions.find((x) => x.questionId === mcId)!;
    expect(mc).toBeTruthy();
    expect(plain(mc.questionText)).toContain(`THAN-CAU-${marker}`);
    expect(mc.answers).toHaveLength(4); // MC theo mô hình mới: đúng 4 lựa chọn
    expect(mc.answers.some((a) => plain(a.text).includes(`DUNG-${marker}`))).toBe(true);
    expect(mc.answers.some((a) => plain(a.text).includes(`SAI-${marker}`))).toBe(true);
    // Bề mặt học sinh không lộ fraction của đáp án khi đang làm.
    for (const q of view.questions) {
      for (const a of q.answers) expect(a).not.toHaveProperty('fraction');
    }

    const tf = view.questions.find((x) => x.questionId === tfId)!;
    expect(tf).toBeTruthy();
    expect(plain(tf.questionText)).toContain(`THAN-CAU-TF-${marker}`);
    expect(tf.stimulus).not.toBeNull();
    expect(plain(tf.stimulus!.content)).toContain(`NGU-LIEU-${marker}`);

    // Nạp lại view (mô phỏng tải lại trang) — vẫn đọc được.
    const reload = await http(app).get(`/api/v1/quiz-attempts/${view.attempt.id}`).set(bearer(ctx.student.token));
    expect(reload.status).toBe(200);
    expect((reload.body as AttemptViewBody).questions).toHaveLength(2);

    // Trả lời đúng cả hai câu rồi nộp.
    const correct = mc.answers.find((a) => plain(a.text).includes(`DUNG-${marker}`))!;
    const ansMc = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set(bearer(ctx.student.token))
      .send({ questionAttemptId: mc.questionAttemptId, response: correct.id });
    expect(ansMc.status, JSON.stringify(ansMc.body)).toBeLessThan(300);
    // Câu TF-A 4 mệnh đề, solution toàn Đúng: response phải là map
    // statementId→boolean khớp solution — 'true' là định dạng TF-B cũ,
    // chấm 0 ý đúng nên sumGrades chỉ còn điểm MC.
    const ansTf = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/responses`).set(bearer(ctx.student.token))
      .send({ questionAttemptId: tf.questionAttemptId, response: JSON.stringify({ s1: true, s2: true, s3: true, s4: true }) });
    expect(ansTf.status, JSON.stringify(ansTf.body)).toBeLessThan(300);

    const submit = await http(app).post(`/api/v1/quiz-attempts/${view.attempt.id}/submit`).set(bearer(ctx.student.token)).send({});
    expect(submit.status, JSON.stringify(submit.body)).toBeLessThan(300);
    view = submit.body as AttemptViewBody;
    expect(view.attempt.state).toBe('finished');
    expect(view.attempt.sumGrades).toBe(2);
    expect(view.attempt.grade).toBe(10);
    return view;
  }

  it('bank trường (school): học sinh đọc/trả lời/nộp được câu + câu kèm stimulus trong attempt', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlots(ctx.teacher.token, ctx.courseId, ctx.sectionId, 'Quiz bank truong 141', [ctx.q.school.mc, ctx.q.school.tf]);
    await playAndAssertReadable(ctx, quizId, 'TRUONG-141', ctx.q.school.mc, ctx.q.school.tf);
  }, 180_000);

  it('bank tổ (team): học sinh đọc/trả lời/nộp được câu + câu kèm stimulus trong attempt', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlots(ctx.teacher.token, ctx.courseId, ctx.sectionId, 'Quiz bank to 141', [ctx.q.team.mc, ctx.q.team.tf]);
    await playAndAssertReadable(ctx, quizId, 'TO-141', ctx.q.team.mc, ctx.q.team.tf);
  }, 180_000);

  it('bank cá nhân của giáo viên (personal): học sinh đọc/trả lời/nộp được câu + câu kèm stimulus trong attempt', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlots(ctx.teacher.token, ctx.courseId, ctx.sectionId, 'Quiz bank ca nhan 141', [ctx.q.personal.mc, ctx.q.personal.tf]);
    await playAndAssertReadable(ctx, quizId, 'CANHAN-141', ctx.q.personal.mc, ctx.q.personal.tf);
  }, 180_000);

  it('cổng hoạt động: học sinh ngoài khoá bị chặn ở trang quiz, bắt đầu attempt và đọc attempt của người khác', async () => {
    const ctx = await setup();
    const quizId = await createQuizWithSlots(ctx.teacher.token, ctx.courseId, ctx.sectionId, 'Quiz cong hoat dong 141', [ctx.q.school.mc]);
    // Học sinh ghi danh làm một lượt để có attempt thật.
    const start = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set(bearer(ctx.student.token)).send({});
    expect(start.status).toBe(201);
    const attemptId = (start.body as AttemptViewBody).attempt.id;

    const infoOut = await http(app).get(`/api/v1/exam-pins/${quizId}`).set(bearer(ctx.outsider.token));
    expect(infoOut.status).toBe(403);
    const startOut = await http(app).post(`/api/v1/exam-pins/${quizId}/attempts`).set(bearer(ctx.outsider.token)).send({});
    expect(startOut.status).toBe(403);
    const readOut = await http(app).get(`/api/v1/quiz-attempts/${attemptId}`).set(bearer(ctx.outsider.token));
    expect(readOut.status).toBe(403);
    expect(readOut.body.code).toBe('quiz.attempt_forbidden');
  }, 180_000);

  it('giữ nguyên cổng duyệt bank (#55/#123): chính các câu học sinh đọc được trong attempt vẫn 404 qua bề mặt ngân hàng', async () => {
    const ctx = await setup();
    const cases = [
      { catId: ctx.schoolCatId, qid: ctx.q.school.mc, stimulusId: ctx.schoolStimulusId },
      { catId: ctx.teamCatId, qid: ctx.q.team.mc, stimulusId: ctx.teamStimulusId },
      { catId: ctx.personalCatId, qid: ctx.q.personal.mc, stimulusId: ctx.personalStimulusId },
    ];
    for (const c of cases) {
      const readQ = await http(app).get(`/api/v1/questions/${c.qid}`).set(bearer(ctx.student.token));
      expect(readQ.status).toBe(404);
      const listQ = await http(app).get(`/api/v1/questions/categories/${c.catId}/questions`).set(bearer(ctx.student.token));
      expect(listQ.status).toBe(404);
      const readS = await http(app).get(`/api/v1/stimuli/${c.stimulusId}`).set(bearer(ctx.student.token));
      expect(readS.status).toBe(404);
    }
  }, 180_000);
});
