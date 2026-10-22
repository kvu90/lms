import { z } from 'zod';
import {
  createPrivacyRequestSchema,
  decidePrivacyRequestSchema,
  type DecidePrivacyRequest,
  uuidIdSchema,
} from '@lms/contracts';

/** Validation Privacy dùng Zod qua Standard Schema — schema nền ở `@lms/contracts`. */
export { decidePrivacyRequestSchema };
export type DecidePrivacyRequestDto = DecidePrivacyRequest;

/**
 * Schema phía server — EXTEND từ schema nền ở contracts: `userid` là field chỉ
 * admin mới được gửi (gửi hộ người khác); form tự phục vụ của người dùng dùng
 * schema nền không có field này.
 */
export const createPrivacyRequestServerSchema = createPrivacyRequestSchema.extend({
  userid: uuidIdSchema.optional(),
});
export type CreatePrivacyRequestDto = z.infer<typeof createPrivacyRequestServerSchema>;
