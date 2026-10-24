import {
  markCourseCriteriaCompletionSchema,
  markCourseSelfCompletionSchema,
  markManualCompletionSchema,
  setCompletionCriteriaSchema,
  type MarkCourseCriteriaCompletion,
  type MarkCourseSelfCompletion,
  type MarkManualCompletion,
  type SetCompletionCriteria,
} from '@lms/contracts';

/**
 * Validation của Completion dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { markCourseCriteriaCompletionSchema, markCourseSelfCompletionSchema, markManualCompletionSchema, setCompletionCriteriaSchema };
export type SetCriteriaDto = SetCompletionCriteria;
export type MarkManualDto = MarkManualCompletion;
export type MarkSelfDto = MarkCourseSelfCompletion;
export type MarkCriteriaDto = MarkCourseCriteriaCompletion;
