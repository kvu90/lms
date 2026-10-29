import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { QuestionBanksService } from '../../../src/modules/questions/question-banks.service';
import { QuizService } from '../../../src/modules/quiz/quiz.service';
import {
  STRONG_PASSWORD, adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname,
} from '../../support/identity-access-helpers';
import {
  createCategory, createCourse, createEnrolInstance, enrolUser, getFirstSectionId,
} from '../../support/course-enrolment-helpers';
import { addExamSlot, createExamDraft, createReadyQuestion, pinExam } from '../../support/exam-pin-helpers';

/**
 * Đặc trưng hoá DL-03 (issue #489): đường đọc kết quả quiz — tóm tắt
 * lượt làm, điểm bài hiện tại theo grade_method và trang kết quả của
 * giáo viên — trên dữ kiện nhiều học sinh × nhiều lượt. Hình dạng đáp
 * ứng, thứ tự và các số điểm kỳ vọng dưới đây được tính độc lập từ dữ
 * kiện gieo (điểm lượt = sumGrades / tổng maxMark của usage × điểm
 * bài) và phải giữ nguyên khi đường đọc chuyển sang nạp theo lô.
 */
describe('Quiz: đặc trưng hoá đường đọc kết quả lượt làm (DL-03, issue #489)', () => {
  let app: INestApplication;
  let pg: Client;
  let attemptsService: QuizService;
  let pinId: string;
  let teacherId: string;
  const studentIds: string[] = [];
  let idleStudentId: string;

  interface SeedAttempt {
    id: string; userId: string; attemptNumber: number; state: string;
    sumGrades: number | null; preview?: boolean;
    questions: { slot: number; questionId: string; fraction: number | null; state: string; answer?: string }[];
  }
  const seeds: SeedAttempt[] = [];
  let q1 = '';
  let q2 = '';

  async function seedAttempt(seed: SeedAttempt): Promise<void> {
    const usageId = uuidv7();
    await pg.query(
      `insert into question_usages (id, component, user_id) values ($1, 'mod_quiz', $2)`,
      [usageId, seed.userId],
    );
    for (const qa of seed.questions) {
      const qaId = uuidv7();
      await pg.query(
        `insert into question_attempts (id, question_usage_id, slot, question_id, max_mark, state, fraction, user_id)
         values ($1, $2, $3, $4, 5, $5, $6, $7)`,
        [qaId, usageId, qa.slot, qa.questionId, qa.state, qa.fraction, seed.userId],
      );
      if (qa.answer !== undefined) {
        const stepId = uuidv7();
        await pg.query(
          `insert into question_attempt_steps (id, question_attempt_id, sequence_number, state, user_id)
           values ($1, $2, 0, $3, $4)`,
          [stepId, qaId, qa.state, seed.userId],
        );
        await pg.query(
          `insert into question_attempt_step_data (id, attempt_step_id, name, value) values ($1, $2, 'answer', $3)`,
          [uuidv7(), stepId, qa.answer],
        );
      }
    }
    await pg.query(
      `insert into exam_attempts (id, pin_id, user_id, attempt_number, usage_id, state, preview, sum_grades, time_start, time_finish)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now() - interval '2 hours', now() - interval '1 hour')`,
      [seed.id, pinId, seed.userId, seed.attemptNumber, usageId, seed.state, seed.preview ?? false, seed.sumGrades],
    );
  }

  beforeAll(async () => {
    app = await createTestApp();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    attemptsService = app.get(QuizService, { strict: false });
    const admin = await adminToken(app);

    const cat = await createCategory(app, admin);
    const course = await createCourse(app, admin, cat.id);
    const sectionId = await getFirstSectionId(app, admin, course.id);
    const instance = await createEnrolInstance(app, admin, course.id);
    const contexts = await http(app).get('/api/v1/access/contexts').set('Authorization', `Bearer ${admin}`);
    const courseCtx = (contexts.body as { id: string; contextLevel: number; instanceId: string }[])
      .find((c) => c.contextLevel === 50 && c.instanceId === course.id)!;
    const teacherUser = await createUserViaApi(app, admin);
    teacherId = teacherUser.id;
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'editingteacher'), courseCtx.id);
    const teacher = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    for (let i = 0; i < 4; i += 1) {
      const student = await createUserViaApi(app, admin);
      await enrolUser(app, admin, course.id, instance.id, student.id);
      if (i < 3) studentIds.push(student.id); else idleStudentId = student.id;
    }

    await app.get(QuestionBanksService, { strict: false }).ensurePersonalBank(teacherId);
    q1 = await createReadyQuestion(app, teacher, 'DL03 một');
    q2 = await createReadyQuestion(app, teacher, 'DL03 hai');
    const draft = await createExamDraft(app, teacher, 'Đề đặc trưng DL-03', 10);
    await addExamSlot(app, teacher, draft, { questionId: q1, maxMark: 5 });
    await addExamSlot(app, teacher, draft, { questionId: q2, maxMark: 5 });
    const pin = await pinExam(app, teacher, course.id, draft, { sectionId });
    pinId = pin.id as string;

    const [a, b, c] = studentIds as [string, string, string];
    seeds.push(
      {
        id: uuidv7(), userId: a, attemptNumber: 1, state: 'finished', sumGrades: 9,
        questions: [
          { slot: 1, questionId: q1, fraction: 1, state: 'graded' },
          { slot: 2, questionId: q2, fraction: 0.8, state: 'graded' },
        ],
      },
      {
        id: uuidv7(), userId: a, attemptNumber: 2, state: 'finished', sumGrades: 6,
        questions: [
          { slot: 1, questionId: q1, fraction: 0.6, state: 'graded' },
          { slot: 2, questionId: q2, fraction: 0.6, state: 'graded' },
        ],
      },
      {
        id: uuidv7(), userId: b, attemptNumber: 1, state: 'finished', sumGrades: 4,
        questions: [
          { slot: 1, questionId: q1, fraction: 0, state: 'graded' },
          { slot: 2, questionId: q2, fraction: 0.8, state: 'graded' },
        ],
      },
      {
        id: uuidv7(), userId: b, attemptNumber: 2, state: 'inprogress', sumGrades: null,
        questions: [
          { slot: 1, questionId: q1, fraction: null, state: 'inprogress' },
          { slot: 2, questionId: q2, fraction: null, state: 'notstarted' },
        ],
      },
      {
        id: uuidv7(), userId: c, attemptNumber: 1, state: 'finished', sumGrades: 5,
        questions: [
          { slot: 1, questionId: q1, fraction: 1, state: 'graded' },
          { slot: 2, questionId: q2, fraction: 0, state: 'graded' },
        ],
      },
      {
        id: uuidv7(), userId: c, attemptNumber: 2, state: 'needsgrading', sumGrades: 8,
        questions: [
          { slot: 1, questionId: q1, fraction: 0.8, state: 'graded' },
          { slot: 2, questionId: q2, fraction: null, state: 'needsgrading', answer: 'Bài làm tự luận của C' },
        ],
      },
      {
        id: uuidv7(), userId: teacherId, attemptNumber: 1, state: 'finished', sumGrades: 10, preview: true,
        questions: [
          { slot: 1, questionId: q1, fraction: 1, state: 'graded' },
          { slot: 2, questionId: q2, fraction: 1, state: 'graded' },
        ],
      },
    );
    for (const seed of seeds) await seedAttempt(seed);
  });
  afterAll(async () => { await pg.end(); await app.close(); });

  /** Thứ tự liệt kê lượt của repository: userId tăng dần rồi số lượt tăng dần, bỏ lượt preview. */
  function expectedOrder(): SeedAttempt[] {
    return seeds.filter((s) => !s.preview)
      .sort((x, y) => x.userId.localeCompare(y.userId) || x.attemptNumber - y.attemptNumber);
  }

  it('trang kết quả liệt kê đúng lượt (bỏ preview), đúng thứ tự và điểm lượt quy về thang bài', async () => {
    const results = await attemptsService.getResults(teacherId, pinId);
    const expected = expectedOrder();
    expect(results.attempts.map((s) => s.id)).toEqual(expected.map((s) => s.id));
    for (const summary of results.attempts) {
      const seed = expected.find((s) => s.id === summary.id)!;
      expect(summary.userId).toBe(seed.userId);
      expect(summary.attemptNumber).toBe(seed.attemptNumber);
      expect(summary.state).toBe(seed.state);
      expect(summary.sumGrades).toBe(seed.sumGrades);
      // Tổng maxMark mỗi usage là 10, điểm bài là 10 → điểm lượt bằng sumGrades.
      expect(summary.grade).toBe(seed.sumGrades === null ? null : seed.sumGrades);
    }
  });

  it('điểm bài theo từng học sinh chỉ tính lượt đã kết thúc và theo grade_method highest mặc định', async () => {
    const results = await attemptsService.getResults(teacherId, pinId);
    const byUser = new Map(results.gradesByUser.map((g) => [g.userId, g.grade]));
    expect(byUser.get(studentIds[0]!)).toBe(9);
    expect(byUser.get(studentIds[1]!)).toBe(4);
    expect(byUser.get(studentIds[2]!)).toBe(5);
    expect(byUser.has(idleStudentId)).toBe(false);
    // Thứ tự gradesByUser là thứ tự xuất hiện đầu tiên trong danh sách lượt đã sắp.
    const expectedUsers = [...new Set(expectedOrder().map((s) => s.userId))];
    expect(results.gradesByUser.map((g) => g.userId)).toEqual(expectedUsers);
  });

  it('tổng quan trang kết quả: số ghi danh, số đã nộp, học sinh chưa nộp và phổ điểm', async () => {
    const results = await attemptsService.getResults(teacherId, pinId);
    expect(results.summary.enrolledCount).toBe(4);
    expect(results.summary.submittedCount).toBe(3);
    expect(results.summary.notSubmittedStudents).toEqual([{ userId: idleStudentId, displayName: 'Test User' }]);
    expect(results.summary.averageGrade).toBe(6);
    expect(results.summary.gradeMax).toBe(10);
    const distribution = results.summary.distribution;
    expect(distribution[9]!.count).toBe(1);
    expect(distribution[4]!.count).toBe(1);
    expect(distribution[5]!.count).toBe(1);
    expect(distribution.reduce((sum, d) => sum + d.count, 0)).toBe(3);
  });

  it('hàng đợi chờ chấm tay chứa đúng câu tự luận chưa chấm kèm đáp án hiện tại', async () => {
    const results = await attemptsService.getResults(teacherId, pinId);
    expect(results.needsGrading).toHaveLength(1);
    const item = results.needsGrading[0]!;
    const seed = seeds.find((s) => s.state === 'needsgrading')!;
    expect(item.quizAttemptId).toBe(seed.id);
    expect(item.userId).toBe(studentIds[2]);
    expect(item.slot).toBe(2);
    expect(item.questionId).toBe(q2);
    expect(item.maxMark).toBe(5);
    expect(item.response).toBe('Bài làm tự luận của C');
  });

  it('thống kê câu sai gộp đúng theo slot và xếp slot sai nhiều hơn lên trước', async () => {
    const results = await attemptsService.getResults(teacherId, pinId);
    expect(results.questionStats.map((s) => s.slot)).toEqual([2, 1]);
    const slot1 = results.questionStats.find((s) => s.slot === 1)!;
    expect(slot1.attemptsCount).toBe(5);
    expect(slot1.gradedCount).toBe(5);
    expect(slot1.pendingCount).toBe(0);
    expect(slot1.wrongCount).toBe(3);
    expect(slot1.fullyWrongCount).toBe(1);
    expect(slot1.correctCount).toBe(2);
    const slot2 = results.questionStats.find((s) => s.slot === 2)!;
    expect(slot2.attemptsCount).toBe(5);
    expect(slot2.gradedCount).toBe(4);
    expect(slot2.pendingCount).toBe(1);
    expect(slot2.wrongCount).toBe(4);
    expect(slot2.fullyWrongCount).toBe(1);
    expect(slot2.correctCount).toBe(0);
  });

  it('điểm bài hiện tại đổi đúng theo từng grade_method trên cùng tập lượt đã kết thúc', async () => {
    const pin = await attemptsService.getPin(pinId);
    const a = studentIds[0]!;
    expect(await attemptsService.currentGradeForUser({ ...pin, gradeMethod: 'highest' }, a)).toBe(9);
    expect(await attemptsService.currentGradeForUser({ ...pin, gradeMethod: 'average' }, a)).toBe(7.5);
    expect(await attemptsService.currentGradeForUser({ ...pin, gradeMethod: 'first' }, a)).toBe(9);
    expect(await attemptsService.currentGradeForUser({ ...pin, gradeMethod: 'last' }, a)).toBe(6);
    expect(await attemptsService.currentGradeForUser(pin, idleStudentId)).toBeNull();
  });

  it('danh sách tóm tắt cho người có quyền báo cáo khớp hệt mảng lượt của trang kết quả', async () => {
    const results = await attemptsService.getResults(teacherId, pinId);
    const summaries = await attemptsService.listAttemptSummaries(teacherId, pinId);
    expect(summaries).toEqual(results.attempts);
  });
});
