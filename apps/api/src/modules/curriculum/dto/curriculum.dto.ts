import {
  createCurriculumNodeSchema,
  createCurriculumSchema,
  createLearningOutcomeSchema,
  createSubjectSchema,
  updateCurriculumNodeSchema,
  updateCurriculumSchema,
  updateLearningOutcomeSchema,
  updateSubjectSchema,
  type CreateCurriculum,
  type CreateCurriculumNode,
  type CreateLearningOutcome,
  type CreateSubject,
  type UpdateCurriculum,
  type UpdateCurriculumNode,
  type UpdateLearningOutcome,
  type UpdateSubject,
} from '@lms/contracts';

/**
 * Validation của Curriculum dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  createCurriculumNodeSchema,
  createCurriculumSchema,
  createLearningOutcomeSchema,
  createSubjectSchema,
  updateCurriculumNodeSchema,
  updateCurriculumSchema,
  updateLearningOutcomeSchema,
  updateSubjectSchema,
};
export type CreateSubjectDto = CreateSubject;
export type UpdateSubjectDto = UpdateSubject;
export type CreateCurriculumDto = CreateCurriculum;
export type UpdateCurriculumDto = UpdateCurriculum;
export type CreateCurriculumNodeDto = CreateCurriculumNode;
export type UpdateCurriculumNodeDto = UpdateCurriculumNode;
export type CreateLearningOutcomeDto = CreateLearningOutcome;
export type UpdateLearningOutcomeDto = UpdateLearningOutcome;
