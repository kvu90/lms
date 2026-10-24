import {
  createAssignAnnotationSchema,
  createAssignFeedbackMessageSchema,
  createAssignmentSchema,
  createTeacherCommentBankEntrySchema,
  gradeAssignmentSubmissionSchema,
  releaseAssignmentGradesSchema,
  updateAssignAnnotationSchema,
  updateAssignmentSchema,
  upsertAssignRubricSchema,
  type CreateAssignAnnotation,
  type CreateAssignFeedbackMessage,
  type CreateAssignment,
  type CreateTeacherCommentBankEntry,
  type GradeAssignmentSubmission,
  type ReleaseAssignmentGrades,
  type UpdateAssignAnnotation,
  type UpdateAssignment,
  type UpsertAssignRubric,
} from '@lms/contracts';

/**
 * Validation của Bài tập nộp tệp/ảnh dùng Zod qua Standard Schema —
 * schema nền ở `@lms/contracts` là nguồn sự thật duy nhất (giống các
 * module khác).
 */
export {
  createAssignAnnotationSchema,
  createAssignFeedbackMessageSchema,
  createAssignmentSchema,
  createTeacherCommentBankEntrySchema,
  gradeAssignmentSubmissionSchema,
  releaseAssignmentGradesSchema,
  updateAssignAnnotationSchema,
  updateAssignmentSchema,
  upsertAssignRubricSchema,
};
export type CreateAssignmentDto = CreateAssignment;
export type UpdateAssignmentDto = UpdateAssignment;
export type GradeAssignmentSubmissionDto = GradeAssignmentSubmission;
export type ReleaseAssignmentGradesDto = ReleaseAssignmentGrades;
export type CreateAssignAnnotationDto = CreateAssignAnnotation;
export type UpdateAssignAnnotationDto = UpdateAssignAnnotation;
export type UpsertAssignRubricDto = UpsertAssignRubric;
export type CreateAssignFeedbackMessageDto = CreateAssignFeedbackMessage;
export type CreateTeacherCommentBankEntryDto = CreateTeacherCommentBankEntry;
