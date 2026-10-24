import {
  createAssignmentSchema,
  gradeAssignmentSubmissionSchema,
  updateAssignmentSchema,
  type CreateAssignment,
  type GradeAssignmentSubmission,
  type UpdateAssignment,
} from '@lms/contracts';

/**
 * Validation của Bài tập nộp tệp/ảnh dùng Zod qua Standard Schema —
 * schema nền ở `@lms/contracts` là nguồn sự thật duy nhất (giống các
 * module khác).
 */
export {
  createAssignmentSchema,
  gradeAssignmentSubmissionSchema,
  updateAssignmentSchema,
};
export type CreateAssignmentDto = CreateAssignment;
export type UpdateAssignmentDto = UpdateAssignment;
export type GradeAssignmentSubmissionDto = GradeAssignmentSubmission;
