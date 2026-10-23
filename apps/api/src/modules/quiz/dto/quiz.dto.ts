import {
  addQuizSlotSchema,
  createQuizSchema,
  manualGradeQuizSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  updateQuizSchema,
  updateQuizSlotSchema,
  type AddQuizSlot,
  type CreateQuiz,
  type ManualGradeQuiz,
  type StartQuizAttempt,
  type SubmitQuizResponse,
  type UpdateQuiz,
  type UpdateQuizSlot,
} from '@lms/contracts';

/**
 * Validation của Quiz dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (giống các module khác).
 */
export {
  addQuizSlotSchema,
  createQuizSchema,
  manualGradeQuizSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
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
