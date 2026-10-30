import { z } from 'zod';
import {
  assignRoleSchema,
  capabilityMatrixQuerySchema,
  createContextSchema,
  createRoleSchema,
  hasCapabilityQuerySchema,
  listAssignmentsQuerySchema,
  listUsersWithAssignmentsQuerySchema,
  overrideCapabilitySchema,
  replaceRoleCapabilitiesSchema,
  updateRoleSchema,
  type AssignRole,
  type CapabilityMatrixQuery,
  type CreateContext,
  type CreateRole,
  type ListAssignmentsQuery,
  type ListUsersWithAssignmentsQuery,
  type OverrideCapability,
  type ReplaceRoleCapabilities,
  type UpdateRole,
  uuidIdSchema,
} from '@lms/contracts';

/**
 * Validation của Access (contexts/roles/assignments) dùng Zod qua Standard
 * Schema — schema nền ở `@lms/contracts` là nguồn sự thật duy nhất.
 */
export { assignRoleSchema, capabilityMatrixQuerySchema, createContextSchema, createRoleSchema, overrideCapabilitySchema, replaceRoleCapabilitiesSchema, updateRoleSchema };
export type CreateContextDto = CreateContext;
export type CreateRoleDto = CreateRole;
export type UpdateRoleDto = UpdateRole;
export type AssignRoleDto = AssignRole;
export type OverrideCapabilityDto = OverrideCapability;
export type ReplaceRoleCapabilitiesDto = ReplaceRoleCapabilities;
export type CapabilityMatrixQueryDto = CapabilityMatrixQuery;

/**
 * Schema phía server cho query liệt kê gán vai — EXTEND từ schema nền ở
 * contracts: query string luôn là chuỗi nên `page`/`pageSize` ép kiểu
 * bằng `z.coerce` ở tầng server và nhận giá trị mặc định khi vắng mặt
 * (trang 1, 20 dòng mỗi trang, trần 100 dòng), còn `search` được cắt
 * khoảng trắng hai đầu và chuỗi rỗng sau khi cắt coi như không tìm kiếm.
 * Schema nền vẫn giữ kiểu số cho bề mặt dùng chung.
 */
export const listAssignmentsQueryServerSchema = listAssignmentsQuerySchema.extend({
  search: z.string().trim().transform((value) => (value === '' ? undefined : value)).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListAssignmentsQueryDto = z.infer<typeof listAssignmentsQueryServerSchema>;
export type ListAssignmentsFilter = Pick<ListAssignmentsQuery, 'userId' | 'contextId' | 'roleId' | 'search'>;

/**
 * Schema phía server cho query liệt kê người dùng kèm gán vai — EXTEND từ
 * schema nền ở contracts theo đúng khuôn của query liệt kê gán vai:
 * `page`/`pageSize` ép kiểu bằng `z.coerce` và nhận mặc định (trang 1, 20
 * người mỗi trang, trần 100), `search` cắt khoảng trắng hai đầu và chuỗi
 * rỗng sau khi cắt coi như không tìm kiếm. Các trường lọc còn lại
 * (`roleId`, `status`) giữ nguyên validation của schema nền — status
 * ngoài tập đóng bị chặn ở đây trước khi vào tầng service.
 */
export const listUsersWithAssignmentsQueryServerSchema = listUsersWithAssignmentsQuerySchema.extend({
  search: z.string().trim().transform((value) => (value === '' ? undefined : value)).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ListUsersWithAssignmentsQueryDto = z.infer<typeof listUsersWithAssignmentsQueryServerSchema>;
export type ListUsersWithAssignmentsFilter = Pick<ListUsersWithAssignmentsQuery, 'search' | 'roleId' | 'status'>;

/**
 * Schema phía server cho query kiểm tra quyền — EXTEND từ schema nền ở
 * contracts: query string luôn là chuỗi nên `userId`/`contextId` ép kiểu bằng
 * `z.coerce` ở tầng server, schema nền vẫn giữ kiểu số cho bề mặt dùng chung.
 */
export const hasCapabilityQueryServerSchema = hasCapabilityQuerySchema.extend({
  userId: uuidIdSchema,
  contextId: uuidIdSchema,
});
export type HasCapabilityQueryDto = z.infer<typeof hasCapabilityQueryServerSchema>;
