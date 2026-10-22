import {
  markManualCompletionSchema,
  setCompletionCriteriaSchema,
  type MarkManualCompletion,
  type SetCompletionCriteria,
} from '@lms/contracts';

/**
 * Validation của Completion dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { markManualCompletionSchema, setCompletionCriteriaSchema };
export type SetCriteriaDto = SetCompletionCriteria;
export type MarkManualDto = MarkManualCompletion;
