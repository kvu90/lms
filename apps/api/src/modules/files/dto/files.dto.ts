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
