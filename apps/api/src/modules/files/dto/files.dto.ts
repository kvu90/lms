import { z } from 'zod';
import { uploadFileMetaSchema, type UploadFileMeta, uuidIdSchema } from '@lms/contracts';

/**
 * Validation của Files dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts`.
 */
export { uploadFileMetaSchema };
export type UploadMetaBaseDto = UploadFileMeta;

/**
 * Schema phía server cho metadata upload — EXTEND từ schema nền ở contracts:
 * thân multipart/form-data luôn là chuỗi nên các trường số ép kiểu bằng
 * `z.coerce` ở tầng server.
 */
export const uploadMetaServerSchema = uploadFileMetaSchema.extend({
  contextId: uuidIdSchema,
  itemId: uuidIdSchema.optional(),
});
export type UploadMetaDto = z.infer<typeof uploadMetaServerSchema>;

/**
 * Vùng file (fileArea) dành cho ảnh nhúng trong nội dung câu hỏi: thân câu,
 * phản hồi chung, từng đáp án, phản hồi riêng của đáp án, ngữ liệu và hướng
 * dẫn chấm. Ảnh câu hỏi luôn mang component 'question' ở tầng service.
 */
export const QUESTION_FILE_AREAS = ['questiontext', 'generalfeedback', 'answer', 'feedback', 'stimulus', 'guidance'] as const;
export type QuestionFileArea = (typeof QUESTION_FILE_AREAS)[number];

/**
 * Schema phía server cho metadata của endpoint tải ảnh câu hỏi
 * (POST /files/question-image): context đích là context của bank chứa câu.
 */
export const questionImageMetaServerSchema = z.strictObject({
  contextId: uuidIdSchema,
  fileArea: z.enum(QUESTION_FILE_AREAS),
  itemId: uuidIdSchema.optional(),
});
export type QuestionImageMetaDto = z.infer<typeof questionImageMetaServerSchema>;
