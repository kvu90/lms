import {
  createEnrolInstanceSchema,
  enrolUserSchema,
  updateEnrolInstanceSchema,
  type CreateEnrolInstance,
  type EnrolUser,
  type UpdateEnrolInstance,
} from '@lms/contracts';

/**
 * Validation của Enrol dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (kể cả các trường phí của fee
 * enrol: cost/currency/paymentAccountId).
 */
export { createEnrolInstanceSchema, enrolUserSchema, updateEnrolInstanceSchema };
export type CreateEnrolInstanceDto = CreateEnrolInstance;
export type UpdateEnrolInstanceDto = UpdateEnrolInstance;
export type EnrolUserDto = EnrolUser;
