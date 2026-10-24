import { z } from 'zod';
import { uuidIdSchema } from './ids.js';
import { cognitiveLevelSchema } from './curriculum.js';

/**
 * Hợp đồng của lát số hoá đề từ file (issue #52): payload của một câu hỏi
 * đang nằm trong HÀNG ĐỢI DUYỆT của một đợt nhập (question import). Đây
 * KHÔNG phải câu hỏi ngân hàng: câu chỉ thành câu hỏi chính thức khi giáo
 * viên duyệt (approve) — lúc đó tầng nghiệp vụ mới gọi tạo câu hỏi của
 * ngân hàng và gắn các liên kết YCCĐ/mức khai ở đây.
 *
 * `questionText` và các trường văn bản ở payload này là CHUỖI THUẦN (kết
 * quả tách từ file Word/PDF); khi duyệt, tầng nghiệp vụ chuyển chúng
 * thành tài liệu rich text của version câu hỏi như luồng tạo câu thường.
 */

export const questionImportQtypeSchema = z.enum(['multichoice', 'truefalse', 'shortanswer', 'essay']);
export type QuestionImportQtype = z.infer<typeof questionImportQtypeSchema>;

/** Một đáp án/lựa chọn trong payload chờ duyệt; `fraction` là tỷ trọng trong nội bộ câu như question_answers. */
export const questionImportItemAnswerSchema = z.strictObject({
  text: z.string(),
  fraction: z.number().min(-1).max(1),
  feedback: z.string().nullable().optional(),
});
export type QuestionImportItemAnswer = z.infer<typeof questionImportItemAnswerSchema>;

/** Options mang theo khi duyệt: chỉ các trường mà luồng nhập có thể suy ra/sửa được. */
export const questionImportItemOptionsSchema = z.strictObject({
  single: z.boolean().optional(),
  shuffleAnswers: z.boolean().optional(),
  useCase: z.boolean().optional(),
});
export type QuestionImportItemOptions = z.infer<typeof questionImportItemOptionsSchema>;

/** Một liên kết YCCĐ + mức độ nhận thức sẽ gắn cho câu hỏi khi duyệt (cơ chế Curriculum Chặng 2). */
export const questionImportOutcomeLinkSchema = z.strictObject({
  outcomeId: uuidIdSchema,
  cognitiveLevel: cognitiveLevelSchema,
});
export type QuestionImportOutcomeLink = z.infer<typeof questionImportOutcomeLinkSchema>;

/** Payload đầy đủ của một mục chờ duyệt — cũng là dạng giáo viên sửa tại màn hình duyệt. */
export const questionImportItemPayloadSchema = z.strictObject({
  name: z.string().min(1).max(255),
  qtype: questionImportQtypeSchema,
  questionText: z.string(),
  generalFeedback: z.string().nullable().optional(),
  defaultMark: z.number().positive().max(1000),
  answers: z.array(questionImportItemAnswerSchema).max(26),
  options: questionImportItemOptionsSchema,
  truefalseCorrect: z.boolean().nullable().optional(),
  outcomeLinks: z.array(questionImportOutcomeLinkSchema).max(50),
});
export type QuestionImportItemPayload = z.infer<typeof questionImportItemPayloadSchema>;

/** PATCH một mục chờ duyệt: thay toàn bộ payload bằng bản giáo viên đã sửa; tầng nghiệp vụ tính lại danh sách vấn đề (issues). */
export const updateQuestionImportItemSchema = z.strictObject({
  payload: questionImportItemPayloadSchema,
});
export type UpdateQuestionImportItem = z.infer<typeof updateQuestionImportItemSchema>;
