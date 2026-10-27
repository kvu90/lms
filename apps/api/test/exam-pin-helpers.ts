import type { INestApplication } from '@nestjs/common';
import { http } from './identity-access-helpers';

/**
 * Helper soạn đề + ghim dùng chung cho các spec hậu gộp Đề (#226):
 * hành trình người dùng thật — tạo ĐỀ trong bank đề cá nhân của giáo
 * viên → thêm slots (mỗi lần thêm tạo version mới của đề) → đề ready
 * → GHIM vào khoá qua exam-pins (pin mang vai trò của quiz cũ).
 */
export interface ExamDraft {
  examId: string;
  slots: { questionId: string; maxMark?: number }[];
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Bank đề cá nhân của chính người gọi (lọc theo owner = /users/me, tránh lấy nhầm bank của GV khác). */
export async function personalExamBankId(app: INestApplication, token: string): Promise<string> {
  const me = await http(app).get('/api/v1/users/me').set(bearer(token));
  const ownerId = me.body.id as string;
  const res = await http(app).get('/api/v1/question-banks?kind=exam').set(bearer(token));
  const bank = (res.body as { id: string; scope: string; bankKind: string; ownerId: string | null }[])
    .find((b) => b.scope === 'personal' && b.bankKind === 'exam' && b.ownerId === ownerId);
  if (!bank) throw new Error('personal exam bank not found');
  return bank.id;
}

/** Tạo đề nháp (chưa slot) trong bank cá nhân của giáo viên. */
export async function createExamDraft(
  app: INestApplication, token: string, name: string, totalScore = 10,
): Promise<ExamDraft> {
  const bankId = await personalExamBankId(app, token);
  const res = await http(app).post(`/api/v1/exams/banks/${bankId}/exams`).set(bearer(token))
    .send({ name, totalScore });
  if (res.status !== 201) throw new Error(`create exam failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { examId: res.body.paper.id as string, slots: [] };
}

/** Thêm một slot vào đề (PUT toàn bộ danh sách — tạo version mới). Trả {sumGrades, slots} tổng hợp. */
export async function addExamSlot(
  app: INestApplication, token: string, draft: ExamDraft, slot: { questionId: string; maxMark?: number },
): Promise<{ sumGrades: number; slots: { id: string; slot: number; questionId: string; maxMark: number }[] }> {
  draft.slots.push(slot);
  const res = await http(app).put(`/api/v1/exams/${draft.examId}/slots`).set(bearer(token)).send({ slots: draft.slots });
  if (res.status !== 201 && res.status !== 200) throw new Error(`add slot failed: ${res.status} ${JSON.stringify(res.body)}`);
  const viewSlots = (res.body.slots as { position: number; questionId: string; maxMark: number }[])
    .map((x) => ({ id: `${draft.examId}:${x.position}`, slot: x.position, questionId: x.questionId, maxMark: x.maxMark }));
  return { sumGrades: viewSlots.reduce((a, x) => a + x.maxMark, 0), slots: viewSlots };
}

/** Đưa đề về ready rồi ghim vào khoá. `pinBody` là cấu hình tổ chức (sectionId bắt buộc + các trường pin tuỳ chọn). Trả pin view đầy đủ. */
export async function pinExam(
  app: INestApplication, token: string, courseId: string, draft: ExamDraft,
  pinBody: Record<string, unknown>,
): Promise<Record<string, any>> {
  const statusRes = await http(app).post(`/api/v1/exams/${draft.examId}/status`).set(bearer(token)).send({ status: 'ready' });
  if (statusRes.status !== 201) throw new Error(`ready failed: ${statusRes.status} ${JSON.stringify(statusRes.body)}`);
  const res = await http(app).post(`/api/v1/courses/${courseId}/exam-pins`).set(bearer(token))
    .send({ ...pinBody, examId: draft.examId });
  if (res.status !== 201) throw new Error(`pin failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}

/** Tạo một câu hỏi trắc nghiệm sẵn sàng trong bank câu hỏi cá nhân của người dùng. */
export async function createReadyQuestion(app: INestApplication, token: string, name: string): Promise<string> {
  const me = await http(app).get('/api/v1/users/me').set(bearer(token));
  const ownerId = me.body.id as string;
  const banks = await http(app).get('/api/v1/question-banks?kind=question').set(bearer(token));
  const bank = (banks.body as { id: string; scope: string; bankKind: string; ownerId: string | null; defaultCategoryId: string | null }[])
    .find((b) => b.scope === 'personal' && b.bankKind === 'question' && b.ownerId === ownerId)!;
  const res = await http(app).post('/api/v1/questions').set(bearer(token)).send({
    categoryId: bank.defaultCategoryId, qtype: 'multichoice', questionText: `Thân câu ${name}?`,
    answers: [{ text: 'Đúng', correct: true }, { text: 'Sai', correct: false }, { text: 'Đáp án khác 1', correct: false }, { text: 'Đáp án khác 2', correct: false }],
  });
  if (res.status !== 201) throw new Error(`create question failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { question: { id: string } }).question.id;
}
