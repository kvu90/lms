import { z } from 'zod';
import { uploadFileMetaSchema, type UploadFileMeta } from '@lms/contracts';

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
  contextid: z.coerce.number().int(),
  itemid: z.coerce.number().int().optional(),
});
export type UploadMetaDto = z.infer<typeof uploadMetaServerSchema>;
