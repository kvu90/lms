import {
  updateQuestionImportItemSchema,
  type UpdateQuestionImportItem,
} from '@lms/contracts';

/**
 * Validation của Question Import dùng Zod qua Standard Schema — schema
 * nền ở `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { updateQuestionImportItemSchema };
export type UpdateQuestionImportItemDto = UpdateQuestionImportItem;
