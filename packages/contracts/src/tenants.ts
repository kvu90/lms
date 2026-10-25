import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của nền multi-tenant (TENANT-0, issue #168): tenant =
 * một trường (`school`) hoặc trung tâm (`center`) do PLATFORM ADMIN tạo
 * khi khách đăng ký gói tổ chức — người dùng KHÔNG tự tạo tenant, KHÔNG
 * tự đăng ký thành giáo viên. Học sinh ở Trang chính (tenant-zero) được
 * tự đăng ký; giáo viên ở platform chỉ qua admin nâng hoặc tự nâng khi
 * thanh toán gói giáo viên tự do (cưỡng chế gói thuộc TENANT-4).
 */
export const TENANT_KINDS = ['school', 'center', 'platform'] as const;
export const TENANT_STATUSES = ['active', 'suspended', 'archived'] as const;
export const TENANT_MEMBER_STATUSES = ['active', 'suspended', 'ended'] as const;

export const tenantSchema = z.object({
  id: uuidIdSchema,
  slug: z.string(),
  name: z.string(),
  kind: z.enum(TENANT_KINDS),
  status: z.enum(TENANT_STATUSES),
  plan: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Tenant = z.infer<typeof tenantSchema>;

/** Tạo tenant — chỉ platform admin (`tenant:manage` tại context hệ thống). */
export const createTenantSchema = z.strictObject({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(200),
  kind: z.enum(['school', 'center']),
  plan: z.string().max(80).optional(),
});
export type CreateTenant = z.infer<typeof createTenantSchema>;

/** Sửa tenant: đổi tên / trạng thái vòng đời / gói (plan chỉ lưu — hạn mức thuộc TENANT-4). */
export const updateTenantSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(TENANT_STATUSES).optional(),
  plan: z.string().max(80).nullable().optional(),
});
export type UpdateTenant = z.infer<typeof updateTenantSchema>;

export const tenantMembershipSchema = z.object({
  id: uuidIdSchema,
  tenantId: uuidIdSchema,
  userId: uuidIdSchema,
  status: z.enum(TENANT_MEMBER_STATUSES),
  joinedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type TenantMembership = z.infer<typeof tenantMembershipSchema>;

/** Thêm thành viên vào tenant (tenant admin của tenant đó, hoặc platform qua `tenant:manage`). */
export const addTenantMemberSchema = z.strictObject({
  userId: uuidIdSchema,
});
export type AddTenantMember = z.infer<typeof addTenantMemberSchema>;

/** Đổi trạng thái membership: suspended (tạm khoá vào tenant) | ended (rời tenant) | active (mở lại). */
export const updateTenantMemberSchema = z.strictObject({
  status: z.enum(TENANT_MEMBER_STATUSES),
});
export type UpdateTenantMember = z.infer<typeof updateTenantMemberSchema>;

/** Một tenant mà người dùng hiện tại là thành viên active — cho bộ chọn tenant và GET /auth/tenants. */
export const myTenantSchema = z.object({
  id: uuidIdSchema,
  slug: z.string(),
  name: z.string(),
  kind: z.enum(TENANT_KINDS),
  /** Tenant đang hiệu lực trong phiên hiện tại (theo claim `tid`). */
  active: z.boolean(),
});
export type MyTenant = z.infer<typeof myTenantSchema>;
