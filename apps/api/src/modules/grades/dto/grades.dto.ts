import {
  createGradeItemSchema,
  exportGradesSchema,
  exportGradesVneduSchema,
  gradePublicationActionSchema,
  setGradePostingPolicySchema,
  setGradeSchema,
  updateGradeItemSchema,
  updateGradeSchema,
  type CreateGradeItem,
  type ExportGrades,
  type ExportGradesVnedu,
  type GradePublicationAction,
  type SetGrade,
  type SetGradePostingPolicy,
  type UpdateGrade,
  type UpdateGradeItem,
} from '@lms/contracts';

/**
 * Validation của Grades dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  createGradeItemSchema,
  exportGradesSchema,
  exportGradesVneduSchema,
  gradePublicationActionSchema,
  setGradePostingPolicySchema,
  setGradeSchema,
  updateGradeItemSchema,
  updateGradeSchema,
};
export type CreateGradeItemDto = CreateGradeItem;
export type UpdateGradeItemDto = UpdateGradeItem;
export type SetGradeDto = SetGrade;
export type UpdateGradeDto = UpdateGrade;
export type ExportGradesVneduDto = ExportGradesVnedu;
export type ExportGradesDto = ExportGrades;
export type SetGradePostingPolicyDto = SetGradePostingPolicy;
export type GradePublicationActionDto = GradePublicationAction;
