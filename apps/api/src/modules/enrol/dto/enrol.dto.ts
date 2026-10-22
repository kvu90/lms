import {
  createEnrolInstanceSchema,
  enrolUserSchema,
  selfEnrolSchema,
  updateEnrolInstanceSchema,
  type CreateEnrolInstance,
  type EnrolUser,
  type SelfEnrol,
  type UpdateEnrolInstance,
} from '@lms/contracts';

/**
 * Validation của Enrol dùng Zod qua Standard Schema — schema nền ở
 * `@lms/contracts` là nguồn sự thật duy nhất (kể cả các trường phí của fee
 * enrol: cost/currency/paymentAccountId, khoá ghi danh và cấu hình tin nhắn
 * chào mừng của instance).
 */
export { createEnrolInstanceSchema, enrolUserSchema, selfEnrolSchema, updateEnrolInstanceSchema };
export type CreateEnrolInstanceDto = CreateEnrolInstance;
export type UpdateEnrolInstanceDto = UpdateEnrolInstance;
export type EnrolUserDto = EnrolUser;
export type SelfEnrolDto = SelfEnrol;
