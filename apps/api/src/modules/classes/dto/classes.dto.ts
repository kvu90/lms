import {
  addClassRosterMemberSchema,
  createClassSchema,
  updateClassSchema,
  type AddClassRosterMember,
  type CreateClass,
  type UpdateClass,
} from '@lms/contracts';

/**
 * Validation của module Classes dùng Zod qua Standard Schema — schema
 * nền ở `@lms/contracts` là nguồn sự thật duy nhất (khuôn Tenants).
 */
export { addClassRosterMemberSchema, createClassSchema, updateClassSchema };
export type CreateClassDto = CreateClass;
export type UpdateClassDto = UpdateClass;
export type AddClassRosterMemberDto = AddClassRosterMember;
