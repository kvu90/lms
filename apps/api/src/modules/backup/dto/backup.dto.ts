import {
  createBackupSchema,
  restoreCourseSchema,
  type CreateBackup,
  type RestoreCourse,
} from '@lms/contracts';

/** Validation Backup/Restore dùng Zod qua Standard Schema — schema nền ở `@lms/contracts`. */
export { createBackupSchema, restoreCourseSchema };
export type CreateBackupDto = CreateBackup;
export type RestoreDto = RestoreCourse;
