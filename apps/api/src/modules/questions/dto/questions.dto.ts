import {
  attachQuestionOutcomeSchema,
  attachQuestionSubjectSchema,
  createQuestionCategorySchema,
  createQuestionSchema,
  createQuestionUsageSchema,
  createStimulusSchema,
  submitQuestionResponseSchema,
  updateQuestionOutcomeLinkSchema,
  updateQuestionSchema,
  updateStimulusSchema,
  type AttachQuestionOutcome,
  type AttachQuestionSubject,
  type CreateQuestion,
  type CreateQuestionCategory,
  type CreateQuestionUsage,
  type CreateStimulus,
  type SubmitQuestionResponse,
  type UpdateQuestion,
  type UpdateQuestionOutcomeLink,
  type UpdateStimulus,
} from '@lms/contracts';

/**
 * Validation của Questions dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  attachQuestionOutcomeSchema,
  attachQuestionSubjectSchema,
  createQuestionCategorySchema,
  createQuestionSchema,
  createQuestionUsageSchema,
  createStimulusSchema,
  submitQuestionResponseSchema,
  updateQuestionOutcomeLinkSchema,
  updateQuestionSchema,
  updateStimulusSchema,
};
export type CreateQuestionCategoryDto = CreateQuestionCategory;
export type CreateQuestionDto = CreateQuestion;
export type UpdateQuestionDto = UpdateQuestion;
export type CreateUsageDto = CreateQuestionUsage;
export type SubmitResponseDto = SubmitQuestionResponse;
export type CreateStimulusDto = CreateStimulus;
export type UpdateStimulusDto = UpdateStimulus;
export type AttachQuestionSubjectDto = AttachQuestionSubject;
export type AttachQuestionOutcomeDto = AttachQuestionOutcome;
export type UpdateQuestionOutcomeLinkDto = UpdateQuestionOutcomeLink;
