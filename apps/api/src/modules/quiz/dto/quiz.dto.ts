import {
  addQuizSlotSchema,
  clusterQuizSlotsSchema,
  createExamMatrixCellSchema,
  createExamMatrixSchema,
  createQuizOverrideSchema,
  createQuizSchema,
  generateFromMatrixSchema,
  manualGradeQuizSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  swapQuizSlotSchema,
  updateExamMatrixCellSchema,
  updateExamMatrixSchema,
  updateQuizOverrideSchema,
  updateQuizSchema,
  updateQuizSlotSchema,
  type AddQuizSlot,
  type ClusterQuizSlots,
  type CreateExamMatrix,
  type CreateExamMatrixCell,
  type CreateQuiz,
  type CreateQuizOverride,
  type GenerateFromMatrix,
  type ManualGradeQuiz,
  type StartQuizAttempt,
  type SubmitQuizResponse,
  type SwapQuizSlot,
  type UpdateExamMatrix,
  type UpdateExamMatrixCell,
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
  clusterQuizSlotsSchema,
  createExamMatrixCellSchema,
  createExamMatrixSchema,
  createQuizOverrideSchema,
  createQuizSchema,
  generateFromMatrixSchema,
  manualGradeQuizSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  swapQuizSlotSchema,
  updateExamMatrixCellSchema,
  updateExamMatrixSchema,
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
export type CreateExamMatrixDto = CreateExamMatrix;
export type UpdateExamMatrixDto = UpdateExamMatrix;
export type CreateExamMatrixCellDto = CreateExamMatrixCell;
export type UpdateExamMatrixCellDto = UpdateExamMatrixCell;
export type GenerateFromMatrixDto = GenerateFromMatrix;
export type SwapQuizSlotDto = SwapQuizSlot;
export type ClusterQuizSlotsDto = ClusterQuizSlots;
