import {
  createGradeCategorySchema,
  createGradeItemSchema,
  createGradeOutcomeSchema,
  createGradeScaleSchema,
  commitVnCandidateSchema,
  createGuardianLinkSchema,
  createVnActivityMappingSchema,
  createVnGradebookSchema,
  dismissVnCandidateSchema,
  exportGradesVneduSchema,
  finalizeVnTermResultSchema,
  finalizeVnYearResultSchema,
  gradePublicationActionSchema,
  setGradeLettersSchema,
  setGradePostingPolicySchema,
  setGradeSchema,
  setVnCommentResultSchema,
  setVnCommentResultsBatchSchema,
  setVnMakeupStatusSchema,
  updateGradeCategorySchema,
  updateGradeItemSchema,
  updateGradeOutcomeSchema,
  updateGradeSchema,
  type CreateGradeCategory,
  type CreateGradeItem,
  type CreateGradeOutcome,
  type CreateGradeScale,
  type CommitVnCandidate,
  type CreateGuardianLink,
  type CreateVnActivityMapping,
  type CreateVnGradebook,
  type DismissVnCandidate,
  type ExportGradesVnedu,
  type FinalizeVnTermResult,
  type FinalizeVnYearResult,
  type GradePublicationAction,
  type SetGrade,
  type SetGradeLetters,
  type SetGradePostingPolicy,
  type SetVnCommentResult,
  type SetVnCommentResultsBatch,
  type SetVnMakeupStatus,
  type UpdateGrade,
  type UpdateGradeCategory,
  type UpdateGradeItem,
  type UpdateGradeOutcome,
} from '@lms/contracts';

/**
 * Validation của Grades dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  createGradeCategorySchema,
  createGradeItemSchema,
  createGradeOutcomeSchema,
  createGradeScaleSchema,
  commitVnCandidateSchema,
  createGuardianLinkSchema,
  createVnActivityMappingSchema,
  createVnGradebookSchema,
  dismissVnCandidateSchema,
  exportGradesVneduSchema,
  finalizeVnTermResultSchema,
  finalizeVnYearResultSchema,
  gradePublicationActionSchema,
  setGradeLettersSchema,
  setGradePostingPolicySchema,
  setGradeSchema,
  setVnCommentResultSchema,
  setVnCommentResultsBatchSchema,
  setVnMakeupStatusSchema,
  updateGradeCategorySchema,
  updateGradeItemSchema,
  updateGradeOutcomeSchema,
  updateGradeSchema,
};
export type CreateGradeCategoryDto = CreateGradeCategory;
export type UpdateGradeCategoryDto = UpdateGradeCategory;
export type CreateGradeItemDto = CreateGradeItem;
export type UpdateGradeItemDto = UpdateGradeItem;
export type SetGradeDto = SetGrade;
export type UpdateGradeDto = UpdateGrade;
export type SetLettersDto = SetGradeLetters;
export type ExportGradesVneduDto = ExportGradesVnedu;
export type CreateVnGradebookDto = CreateVnGradebook;
export type CreateVnActivityMappingDto = CreateVnActivityMapping;
export type CommitVnCandidateDto = CommitVnCandidate;
export type DismissVnCandidateDto = DismissVnCandidate;
export type SetVnMakeupStatusDto = SetVnMakeupStatus;
export type FinalizeVnTermResultDto = FinalizeVnTermResult;
export type SetVnCommentResultDto = SetVnCommentResult;
export type SetVnCommentResultsBatchDto = SetVnCommentResultsBatch;
export type FinalizeVnYearResultDto = FinalizeVnYearResult;
export type SetGradePostingPolicyDto = SetGradePostingPolicy;
export type GradePublicationActionDto = GradePublicationAction;
export type CreateGuardianLinkDto = CreateGuardianLink;
export type CreateScaleDto = CreateGradeScale;
export type CreateGradeOutcomeDto = CreateGradeOutcome;
export type UpdateGradeOutcomeDto = UpdateGradeOutcome;
