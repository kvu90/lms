import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của LỚP HỌC HẠNG NHẤT (issue #184, CLASS-0): lớp được tạo
 * TRƯỚC, khoá học nằm bên trong lớp; danh sách học sinh thuộc về lớp
 * (roster ≡ thành viên backing cohort) và tự vật chất hoá xuống mọi
 * khoá của lớp qua enrol instance cohort. Tạo lớp chỉ bắt buộc TÊN
 * (khuôn Azota); học phí theo lớp thuộc lát CLASS-3, không có ở đây.
 */
export const CLASS_ON_LEAVE_MODES = ['suspend', 'unenrol'] as const;
export const CLASS_STATUSES = ['active', 'archived'] as const;

/** Hình dạng một lớp ở bề mặt API. `joinCode` là bí mật: chỉ chủ lớp / người có quyền quản roster mới nhận giá trị thật, còn lại nhận `null`. */
export const classSchema = z.object({
  id: uuidIdSchema,
  tenantId: uuidIdSchema,
  name: z.string(),
  code: z.string().nullable(),
  schoolYear: z.string().nullable(),
  ownerId: uuidIdSchema,
  cohortId: uuidIdSchema,
  allowSelfReport: z.boolean(),
  joinCode: z.string().nullable(),
  onLeave: z.enum(CLASS_ON_LEAVE_MODES),
  status: z.enum(CLASS_STATUSES),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ClassView = z.infer<typeof classSchema>;

/**
 * Tạo lớp — chỉ `name` bắt buộc. `ownerId` chỉ dùng khi người tạo có
 * `tenant:manage` tại tenant (admin trung tâm/platform tạo lớp hộ giáo
 * viên); mặc định chủ lớp là chính người tạo.
 */
export const createClassSchema = z.strictObject({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(80).optional(),
  schoolYear: z.string().min(1).max(40).optional(),
  description: z.string().max(2000).optional(),
  ownerId: uuidIdSchema.optional(),
});
export type CreateClass = z.infer<typeof createClassSchema>;

/** Sửa lớp: thông tin hiển thị + công tắc tự báo danh + chế độ khi rời lớp; `rotateJoinCode: true` sinh mã tham gia mới (mã cũ mất hiệu lực ngay). */
export const updateClassSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(80).nullable().optional(),
  schoolYear: z.string().min(1).max(40).nullable().optional(),
  description: z.string().max(2000).optional(),
  allowSelfReport: z.boolean().optional(),
  onLeave: z.enum(CLASS_ON_LEAVE_MODES).optional(),
  rotateJoinCode: z.boolean().optional(),
});
export type UpdateClass = z.infer<typeof updateClassSchema>;

/** Một dòng roster của lớp (≡ một dòng cohort_members của backing cohort). */
export const classRosterMemberSchema = z.object({
  userId: uuidIdSchema,
  timeAdded: z.string(),
});
export type ClassRosterMember = z.infer<typeof classRosterMemberSchema>;

/** Thêm một học sinh vào roster của lớp — ghi danh cấp lớp, tự đồng bộ xuống mọi khoá trong lớp. */
export const addClassRosterMemberSchema = z.strictObject({
  userId: uuidIdSchema,
});
export type AddClassRosterMember = z.infer<typeof addClassRosterMemberSchema>;
