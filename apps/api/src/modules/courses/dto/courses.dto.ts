import {
  applyCurriculumFrameSchema,
  copyCourseContentSchema,
  createCourseCategorySchema,
  createCourseModuleSchema,
  createCourseSchema,
  createCourseSectionSchema,
  duplicateCourseSchema,
  reorderCourseModulesSchema,
  reorderCourseSectionsSchema,
  updateCourseCategorySchema,
  updateCourseModuleSchema,
  updateCourseSchema,
  updateCourseSectionSchema,
  type ApplyCurriculumFrame,
  type CopyCourseContent,
  type CreateCourse,
  type CreateCourseCategory,
  type CreateCourseModule,
  type CreateCourseSection,
  type DuplicateCourse,
  type ReorderCourseModules,
  type ReorderCourseSections,
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
  copyCourseContentSchema,
  createCourseCategorySchema,
  createCourseModuleSchema,
  createCourseSchema,
  createCourseSectionSchema,
  duplicateCourseSchema,
  reorderCourseModulesSchema,
  reorderCourseSectionsSchema,
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
export type DuplicateCourseDto = DuplicateCourse;
export type ReorderSectionsDto = ReorderCourseSections;
export type ReorderModulesDto = ReorderCourseModules;
export type CopyContentDto = CopyCourseContent;
