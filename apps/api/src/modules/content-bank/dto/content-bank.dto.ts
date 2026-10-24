import {
  createContentBankContentSchema,
  insertContentBankContentSchema,
  reviewContentBankContentSchema,
  updateContentBankContentSchema,
  uploadContentBankFileSchema,
  type CreateContentBankContent,
  type InsertContentBankContent,
  type ReviewContentBankContent,
  type UpdateContentBankContent,
  type UploadContentBankFile,
} from '@lms/contracts';

/** Validation Content Bank / Kho học liệu dùng Zod qua Standard Schema — schema nền ở `@lms/contracts`. */
export { createContentBankContentSchema, insertContentBankContentSchema, reviewContentBankContentSchema, updateContentBankContentSchema, uploadContentBankFileSchema };
export type CreateContentDto = CreateContentBankContent;
export type UpdateContentDto = UpdateContentBankContent;
export type UploadContentFileDto = UploadContentBankFile;
export type ReviewContentDto = ReviewContentBankContent;
export type InsertContentDto = InsertContentBankContent;
