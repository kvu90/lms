import {
  addQuizSlotSchema,
  approveMatrixContributionSchema,
  clusterQuizSlotsSchema,
  copyExamMatrixSchema,
  createExamMatrixCellSchema,
  createExamMatrixSchema,
  createMatrixContributionSchema,
  createQuizFeedbackSchema,
  createQuizOverrideSchema,
  createQuizSchema,
  generateFromMatrixSchema,
  gradeQuizQuestionSchema,
  manualGradeQuizSchema,
  recordQuizAttemptEventSchema,
  rejectMatrixContributionSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  swapQuizSlotSchema,
  updateExamMatrixCellSchema,
  updateExamMatrixSchema,
  updateQuizOverrideSchema,
  updateQuizSchema,
  updateQuizSlotSchema,
  type AddQuizSlot,
  type ApproveMatrixContribution,
  type ClusterQuizSlots,
  type CopyExamMatrix,
  type CreateExamMatrix,
  type CreateExamMatrixCell,
  type CreateMatrixContribution,
  type CreateQuiz,
  type CreateQuizFeedback,
  type CreateQuizOverride,
  type GenerateFromMatrix,
  type GradeQuizQuestion,
  type ManualGradeQuiz,
  type RecordQuizAttemptEvent,
  type RejectMatrixContribution,
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
  approveMatrixContributionSchema,
  clusterQuizSlotsSchema,
  copyExamMatrixSchema,
  createExamMatrixCellSchema,
  createExamMatrixSchema,
  createMatrixContributionSchema,
  createQuizFeedbackSchema,
  createQuizOverrideSchema,
  createQuizSchema,
  generateFromMatrixSchema,
  gradeQuizQuestionSchema,
  manualGradeQuizSchema,
  recordQuizAttemptEventSchema,
  rejectMatrixContributionSchema,
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
export type CopyExamMatrixDto = CopyExamMatrix;
export type CreateMatrixContributionDto = CreateMatrixContribution;
export type ApproveMatrixContributionDto = ApproveMatrixContribution;
export type RejectMatrixContributionDto = RejectMatrixContribution;
export type UpdateExamMatrixDto = UpdateExamMatrix;
export type CreateExamMatrixCellDto = CreateExamMatrixCell;
export type UpdateExamMatrixCellDto = UpdateExamMatrixCell;
export type GenerateFromMatrixDto = GenerateFromMatrix;
export type SwapQuizSlotDto = SwapQuizSlot;
export type ClusterQuizSlotsDto = ClusterQuizSlots;
export type CreateQuizFeedbackDto = CreateQuizFeedback;
export type GradeQuizQuestionDto = GradeQuizQuestion;
export type RecordQuizAttemptEventDto = RecordQuizAttemptEvent;
