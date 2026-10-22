import {
  createContentBankContentSchema,
  updateContentBankContentSchema,
  uploadContentBankFileSchema,
  type CreateContentBankContent,
  type UpdateContentBankContent,
  type UploadContentBankFile,
} from '@lms/contracts';

/** Validation Content Bank dùng Zod qua Standard Schema — schema nền ở `@lms/contracts`. */
export { createContentBankContentSchema, updateContentBankContentSchema, uploadContentBankFileSchema };
export type CreateContentDto = CreateContentBankContent;
export type UpdateContentDto = UpdateContentBankContent;
export type UploadContentFileDto = UploadContentBankFile;
