import {
  addQuizSlotSchema,
  createQuizOverrideSchema,
  createQuizSchema,
  manualGradeQuizSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  updateQuizOverrideSchema,
  updateQuizSchema,
  updateQuizSlotSchema,
  type AddQuizSlot,
  type CreateQuiz,
  type CreateQuizOverride,
  type ManualGradeQuiz,
  type StartQuizAttempt,
  type SubmitQuizResponse,
  type UpdateQuiz,
  type UpdateQuizOverride,
  type UpdateQuizSlot,
} from '@lms/contracts';

/**
 * Validation của Quiz dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (giống các module khác).
 */
export {
  addQuizSlotSchema,
  createQuizOverrideSchema,
  createQuizSchema,
  manualGradeQuizSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  updateQuizOverrideSchema,
  updateQuizSchema,
  updateQuizSlotSchema,
};
export type CreateQuizDto = CreateQuiz;
export type UpdateQuizDto = UpdateQuiz;
export type AddQuizSlotDto = AddQuizSlot;
export type UpdateQuizSlotDto = UpdateQuizSlot;
export type StartQuizAttemptDto = StartQuizAttempt;
export type SubmitQuizResponseDto = SubmitQuizResponse;
export type ManualGradeQuizDto = ManualGradeQuiz;
export type CreateQuizOverrideDto = CreateQuizOverride;
export type UpdateQuizOverrideDto = UpdateQuizOverride;
