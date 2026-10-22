import {
  createGradeCategorySchema,
  createGradeItemSchema,
  createGradeScaleSchema,
  setGradeLettersSchema,
  setGradeSchema,
  updateGradeCategorySchema,
  updateGradeItemSchema,
  updateGradeSchema,
  type CreateGradeCategory,
  type CreateGradeItem,
  type CreateGradeScale,
  type SetGrade,
  type SetGradeLetters,
  type UpdateGrade,
  type UpdateGradeCategory,
  type UpdateGradeItem,
} from '@lms/contracts';

/**
 * Validation của Grades dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  createGradeCategorySchema,
  createGradeItemSchema,
  createGradeScaleSchema,
  setGradeLettersSchema,
  setGradeSchema,
  updateGradeCategorySchema,
  updateGradeItemSchema,
  updateGradeSchema,
};
export type CreateGradeCategoryDto = CreateGradeCategory;
export type UpdateGradeCategoryDto = UpdateGradeCategory;
export type CreateGradeItemDto = CreateGradeItem;
export type UpdateGradeItemDto = UpdateGradeItem;
export type SetGradeDto = SetGrade;
export type UpdateGradeDto = UpdateGrade;
export type SetLettersDto = SetGradeLetters;
export type CreateScaleDto = CreateGradeScale;
