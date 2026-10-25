import {
  addTenantMemberSchema,
  createTenantSchema,
  createUserSchema,
  updateTenantMemberSchema,
  updateTenantSchema,
  type AddTenantMember,
  type CreateTenant,
  type CreateUser,
  type UpdateTenant,
  type UpdateTenantMember,
} from '@lms/contracts';

/**
 * Validation của module Tenants dùng Zod qua Standard Schema — schema nền
 * ở `@lms/contracts` là nguồn sự thật duy nhất. Tạo người dùng trong tenant
 * dùng lại đúng `createUserSchema` của bề mặt users (user là thực thể
 * TOÀN CỤC; tenant chỉ thêm membership).
 */
export { addTenantMemberSchema, createTenantSchema, createUserSchema, updateTenantMemberSchema, updateTenantSchema };
export type CreateTenantDto = CreateTenant;
export type UpdateTenantDto = UpdateTenant;
export type AddTenantMemberDto = AddTenantMember;
export type UpdateTenantMemberDto = UpdateTenantMember;
export type CreateTenantUserDto = CreateUser;
