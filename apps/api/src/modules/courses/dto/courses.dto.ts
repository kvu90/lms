import {
  applyCurriculumFrameSchema,
  createCourseCategorySchema,
  createCourseModuleSchema,
  createCourseSchema,
  createCourseSectionSchema,
  updateCourseCategorySchema,
  updateCourseModuleSchema,
  updateCourseSchema,
  updateCourseSectionSchema,
  type ApplyCurriculumFrame,
  type CreateCourse,
  type CreateCourseCategory,
  type CreateCourseModule,
  type CreateCourseSection,
  type UpdateCourse,
  type UpdateCourseCategory,
  type UpdateCourseModule,
  type UpdateCourseSection,
} from '@lms/contracts';

/**
 * Validation của Courses dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất.
 */
export {
  applyCurriculumFrameSchema,
  createCourseCategorySchema,
  createCourseModuleSchema,
  createCourseSchema,
  createCourseSectionSchema,
  updateCourseCategorySchema,
  updateCourseModuleSchema,
  updateCourseSchema,
  updateCourseSectionSchema,
};
export type ApplyFrameDto = ApplyCurriculumFrame;
export type CreateCategoryDto = CreateCourseCategory;
export type UpdateCategoryDto = UpdateCourseCategory;
export type CreateCourseDto = CreateCourse;
export type UpdateCourseDto = UpdateCourse;
export type CreateSectionDto = CreateCourseSection;
export type UpdateSectionDto = UpdateCourseSection;
export type CreateCmDto = CreateCourseModule;
export type UpdateCmDto = UpdateCourseModule;
