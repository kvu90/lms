import {
  createQuestionCategorySchema,
  createQuestionSchema,
  createQuestionUsageSchema,
  submitQuestionResponseSchema,
  updateQuestionSchema,
  type CreateQuestion,
  type CreateQuestionCategory,
  type CreateQuestionUsage,
  type SubmitQuestionResponse,
  type UpdateQuestion,
} from '@lms/contracts';

/**
 * Validation của Questions dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  createQuestionCategorySchema,
  createQuestionSchema,
  createQuestionUsageSchema,
  submitQuestionResponseSchema,
  updateQuestionSchema,
};
export type CreateQuestionCategoryDto = CreateQuestionCategory;
export type CreateQuestionDto = CreateQuestion;
export type UpdateQuestionDto = UpdateQuestion;
export type CreateUsageDto = CreateQuestionUsage;
export type SubmitResponseDto = SubmitQuestionResponse;
