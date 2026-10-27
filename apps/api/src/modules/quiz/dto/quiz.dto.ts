import {
  applyPinVersionUpdateSchema,
  approveMatrixContributionSchema,
  copyExamMatrixSchema,
  createExamMatrixCellSchema,
  createExamMatrixSchema,
  createExamPinFeedbackSchema,
  createExamPinOverrideSchema,
  createExamPinSchema,
  createMatrixContributionSchema,
  generateFromMatrixSchema,
  gradeQuizQuestionSchema,
  manualGradeQuizSchema,
  recordQuizAttemptEventSchema,
  regradePinQuestionSchema,
  rejectMatrixContributionSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  updateExamMatrixCellSchema,
  updateExamMatrixSchema,
  updateExamPinOverrideSchema,
  updateExamPinSchema,
  withdrawExamMatrixSchema,
  type ApplyPinVersionUpdate,
  type ApproveMatrixContribution,
  type CopyExamMatrix,
  type CreateExamMatrix,
  type CreateExamMatrixCell,
  type CreateExamPin,
  type CreateExamPinFeedback,
  type CreateExamPinOverride,
  type CreateMatrixContribution,
  type GenerateFromMatrix,
  type GradeQuizQuestion,
  type ManualGradeQuiz,
  type RecordQuizAttemptEvent,
  type RegradePinQuestion,
  type RejectMatrixContribution,
  type StartQuizAttempt,
  type SubmitQuizResponse,
  type UpdateExamMatrix,
  type UpdateExamMatrixCell,
  type UpdateExamPin,
  type UpdateExamPinOverride,
  type WithdrawExamMatrix,
} from '@lms/contracts';

/**
 * Validation của Quiz/Pin dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (giống các module khác).
 */
export {
  applyPinVersionUpdateSchema,
  approveMatrixContributionSchema,
  copyExamMatrixSchema,
  createExamMatrixCellSchema,
  createExamMatrixSchema,
  createExamPinFeedbackSchema,
  createExamPinOverrideSchema,
  createExamPinSchema,
  createMatrixContributionSchema,
  generateFromMatrixSchema,
  gradeQuizQuestionSchema,
  manualGradeQuizSchema,
  recordQuizAttemptEventSchema,
  regradePinQuestionSchema,
  rejectMatrixContributionSchema,
  startQuizAttemptSchema,
  submitQuizResponseSchema,
  updateExamMatrixCellSchema,
  updateExamMatrixSchema,
  updateExamPinOverrideSchema,
  updateExamPinSchema,
  withdrawExamMatrixSchema,
};
export type CreateExamPinDto = CreateExamPin;
export type UpdateExamPinDto = UpdateExamPin;
export type ApplyPinVersionUpdateDto = ApplyPinVersionUpdate;
export type RegradePinQuestionDto = RegradePinQuestion;
export type StartQuizAttemptDto = StartQuizAttempt;
export type SubmitQuizResponseDto = SubmitQuizResponse;
export type ManualGradeQuizDto = ManualGradeQuiz;
export type CreateExamPinOverrideDto = CreateExamPinOverride;
export type UpdateExamPinOverrideDto = UpdateExamPinOverride;
export type CreateExamMatrixDto = CreateExamMatrix;
export type CopyExamMatrixDto = CopyExamMatrix;
export type CreateMatrixContributionDto = CreateMatrixContribution;
export type ApproveMatrixContributionDto = ApproveMatrixContribution;
export type RejectMatrixContributionDto = RejectMatrixContribution;
export type UpdateExamMatrixDto = UpdateExamMatrix;
export type CreateExamMatrixCellDto = CreateExamMatrixCell;
export type UpdateExamMatrixCellDto = UpdateExamMatrixCell;
export type GenerateFromMatrixDto = GenerateFromMatrix;
export type WithdrawExamMatrixDto = WithdrawExamMatrix;
export type CreateExamPinFeedbackDto = CreateExamPinFeedback;
export type GradeQuizQuestionDto = GradeQuizQuestion;
export type RecordQuizAttemptEventDto = RecordQuizAttemptEvent;
