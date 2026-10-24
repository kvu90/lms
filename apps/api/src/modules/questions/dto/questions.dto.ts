import {
  approveContributionSchema,
  attachQuestionOutcomeSchema,
  attachQuestionSubjectSchema,
  copyQuestionSchema,
  copyQuestionsBatchSchema,
  createContributionSchema,
  createQuestionBankSchema,
  createQuestionCategorySchema,
  createQuestionSchema,
  createQuestionUsageSchema,
  createStimulusSchema,
  rejectContributionSchema,
  submitQuestionResponseSchema,
  updateQuestionOutcomeLinkSchema,
  updateQuestionSchema,
  updateStimulusSchema,
  withdrawQuestionSchema,
  type ApproveContribution,
  type AttachQuestionOutcome,
  type AttachQuestionSubject,
  type CopyQuestion,
  type CopyQuestionsBatch,
  type CreateContribution,
  type CreateQuestion,
  type CreateQuestionBank,
  type CreateQuestionCategory,
  type CreateQuestionUsage,
  type CreateStimulus,
  type RejectContribution,
  type SubmitQuestionResponse,
  type UpdateQuestion,
  type UpdateQuestionOutcomeLink,
  type UpdateStimulus,
  type WithdrawQuestion,
} from '@lms/contracts';

/**
 * Validation của Questions dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  approveContributionSchema,
  attachQuestionOutcomeSchema,
  attachQuestionSubjectSchema,
  copyQuestionSchema,
  copyQuestionsBatchSchema,
  createContributionSchema,
  createQuestionBankSchema,
  createQuestionCategorySchema,
  createQuestionSchema,
  createQuestionUsageSchema,
  createStimulusSchema,
  rejectContributionSchema,
  submitQuestionResponseSchema,
  updateQuestionOutcomeLinkSchema,
  updateQuestionSchema,
  updateStimulusSchema,
  withdrawQuestionSchema,
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
export type CreateQuestionBankDto = CreateQuestionBank;
export type CopyQuestionDto = CopyQuestion;
export type CopyQuestionsBatchDto = CopyQuestionsBatch;
export type WithdrawQuestionDto = WithdrawQuestion;
export type CreateContributionDto = CreateContribution;
export type ApproveContributionDto = ApproveContribution;
export type RejectContributionDto = RejectContribution;
