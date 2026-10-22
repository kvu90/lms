import { z } from 'zod';
import {
  assignRoleSchema,
  createContextSchema,
  createRoleSchema,
  hasCapabilityQuerySchema,
  overrideCapabilitySchema,
  updateRoleSchema,
  type AssignRole,
  type CreateContext,
  type CreateRole,
  type OverrideCapability,
  type UpdateRole,
  uuidIdSchema,
} from '@lms/contracts';

/**
 * Validation của Access (contexts/roles/assignments) dùng Zod qua Standard
 * Schema — schema nền ở `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { assignRoleSchema, createContextSchema, createRoleSchema, overrideCapabilitySchema, updateRoleSchema };
export type CreateContextDto = CreateContext;
export type CreateRoleDto = CreateRole;
export type UpdateRoleDto = UpdateRole;
export type AssignRoleDto = AssignRole;
export type OverrideCapabilityDto = OverrideCapability;

/**
 * Schema phía server cho query kiểm tra quyền — EXTEND từ schema nền ở
 * contracts: query string luôn là chuỗi nên `userid`/`contextid` ép kiểu bằng
 * `z.coerce` ở tầng server, schema nền vẫn giữ kiểu số cho bề mặt dùng chung.
 */
export const hasCapabilityQueryServerSchema = hasCapabilityQuerySchema.extend({
  userid: uuidIdSchema,
  contextid: uuidIdSchema,
});
export type HasCapabilityQueryDto = z.infer<typeof hasCapabilityQueryServerSchema>;
