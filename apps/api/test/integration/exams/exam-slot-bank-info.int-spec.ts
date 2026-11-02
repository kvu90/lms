import { INestApplication } from '@nestjs/common';
import { type RichTextDocument } from '@lms/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExamsRepository } from '@lms/db/repositories/exams';
import { ExamsService } from '../../../src/modules/exams/exams.service';
import { QuestionBanksService } from '../../../src/modules/questions/question-banks.service';
import { QuestionsService } from '../../../src/modules/questions/questions.service';
import {
  STRONG_PASSWORD, adminToken, assignRole, createTestApp, createUserViaApi, http, login, roleIdByShortname,
} from '../../support/identity-access-helpers';
import { addExamSlot, createExamDraft, createReadyQuestion } from '../../support/exam-pin-helpers';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Đặc trưng hoá DL-05 (issue #489): view của slot đề gắn kèm thông tin
 * bank của câu hỏi (bank tường minh qua bank_id của category và số
 * version ready mới nhất) — khẳng định trên hành vi HIỆN TẠI để giữ
 * nguyên khi phép tra bank theo từng câu chuyển sang nạp theo lô.
 */
describe('Exams: đặc trưng hoá thông tin bank trong view slot đề (DL-05, issue #489)', () => {
  let app: INestApplication;
  let exams: ExamsService;
  let examRepo: ExamsRepository;
  let banks: QuestionBanksService;
  let teacherId = '';
  let teacherToken = '';
  let examId = '';
  let q1 = '';
  let q2 = '';
  let personalBankId = '';

  beforeAll(async () => {
    app = await createTestApp();
    exams = app.get(ExamsService, { strict: false });
    examRepo = app.get(ExamsRepository, { strict: false });
    banks = app.get(QuestionBanksService, { strict: false });
    const admin = await adminToken(app);
    const teacherUser = await createUserViaApi(app, admin);
    teacherId = teacherUser.id;
    const contextsRes = await http(app).get('/api/v1/access/contexts').set(bearer(admin));
    const systemCtx = (contextsRes.body as { id: string; contextLevel: number }[]).find((c) => c.contextLevel === 10)!;
    await assignRole(app, admin, teacherUser.id, await roleIdByShortname(app, admin, 'teacher'), systemCtx.id);
    teacherToken = (await login(app, teacherUser.username, STRONG_PASSWORD)).accessToken;

    const questions = app.get(QuestionsService, { strict: false });
    await banks.ensurePersonalBank(teacherId);
    q1 = await createReadyQuestion(app, teacherToken, 'DL05 một');
    q2 = await createReadyQuestion(app, teacherToken, 'DL05 hai');
    const bankList = (await http(app).get('/api/v1/question-banks').set(bearer(teacherToken))).body as { id: string; scope: string }[];
    personalBankId = bankList.find((b) => b.scope === 'personal')!.id;

    const draft = await createExamDraft(app, teacherToken, 'Đề đặc trưng DL-05', 10);
    examId = draft.examId;
    await addExamSlot(app, teacherToken, draft, { questionId: q1, maxMark: 3 });
    await addExamSlot(app, teacherToken, draft, { questionId: q2, maxMark: 4 });

    // Câu 1 có thêm một version ready mới sau khi đã ghim vào đề: slot
    // phải báo latestReadyVersionNumber = 2 và hasNewerVersion = true.
    const view = await questions.getQuestion(q1);
    await questions.updateQuestion(teacherId, q1, {
      questionText: view.latestVersion.questionText as RichTextDocument,
      answers: view.answers.map((a) => ({
        text: a.answer as RichTextDocument, correct: a.isCorrect,
        feedback: (a.feedback as RichTextDocument | null) ?? undefined,
      })),
      generalFeedback: (view.latestVersion.generalFeedback as RichTextDocument | null) ?? undefined,
    });
  });
  afterAll(async () => { await app.close(); });

  it('thông tin bank của một câu: bank cá nhân tường minh, version mới nhất và version ready mới nhất', async () => {
    const info1 = await banks.getQuestionBankInfo(q1);
    expect(info1).not.toBeNull();
    expect(info1!.bank?.id).toBe(personalBankId);
    expect(info1!.bankExplicit).toBe(true);
    expect(info1!.latestVersion).toBe(2);
    expect(info1!.latestReadyVersionNumber).toBe(2);
    expect(info1!.entryStatus).toBe('ready');
    const info2 = await banks.getQuestionBankInfo(q2);
    expect(info2!.latestVersion).toBe(1);
    expect(info2!.latestReadyVersionNumber).toBe(1);
  });

  it('view đề gắn đúng thông tin bank theo từng slot và giữ nguyên các trường nghiệp vụ của slot', async () => {
    const paper = await examRepo.getPaper(examId);
    const view = await exams.paperView(teacherId, paper!);
    expect(view.slots).toHaveLength(2);
    const slot1 = view.slots.find((s) => s.questionId === q1)!;
    expect(slot1.latestReadyVersionNumber).toBe(2);
    expect(slot1.hasNewerVersion).toBe(true);
    expect(slot1.pinnedVersionNumber).toBe(1);
    expect(slot1.maxMark).toBe(3);
    expect(slot1.entryStatus).toBe('ready');
    const slot2 = view.slots.find((s) => s.questionId === q2)!;
    expect(slot2.latestReadyVersionNumber).toBe(1);
    expect(slot2.hasNewerVersion).toBe(false);
    expect(slot2.pinnedVersionNumber).toBe(1);
    expect(slot2.maxMark).toBe(4);
    expect(view.slots.map((s) => s.position)).toEqual([1, 2]);
  });
});
