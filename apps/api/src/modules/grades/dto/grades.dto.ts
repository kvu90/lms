import {
  createGradeCategorySchema,
  createGradeItemSchema,
  createGradeOutcomeSchema,
  createGradeScaleSchema,
  createVnGradebookSchema,
  exportGradesVneduSchema,
  finalizeVnTermResultSchema,
  finalizeVnYearResultSchema,
  setGradeLettersSchema,
  setGradeSchema,
  setVnCommentResultSchema,
  updateGradeCategorySchema,
  updateGradeItemSchema,
  updateGradeOutcomeSchema,
  updateGradeSchema,
  type CreateGradeCategory,
  type CreateGradeItem,
  type CreateGradeOutcome,
  type CreateGradeScale,
  type CreateVnGradebook,
  type ExportGradesVnedu,
  type FinalizeVnTermResult,
  type FinalizeVnYearResult,
  type SetGrade,
  type SetGradeLetters,
  type SetVnCommentResult,
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
  createVnGradebookSchema,
  exportGradesVneduSchema,
  finalizeVnTermResultSchema,
  finalizeVnYearResultSchema,
  setGradeLettersSchema,
  setGradeSchema,
  setVnCommentResultSchema,
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
export type FinalizeVnTermResultDto = FinalizeVnTermResult;
export type SetVnCommentResultDto = SetVnCommentResult;
export type FinalizeVnYearResultDto = FinalizeVnYearResult;
export type CreateScaleDto = CreateGradeScale;
export type CreateGradeOutcomeDto = CreateGradeOutcome;
export type UpdateGradeOutcomeDto = UpdateGradeOutcome;
