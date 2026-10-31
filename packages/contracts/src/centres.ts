import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/**
 * Hợp đồng API của trung tâm đã cấp phát riêng (issue #583,
 * chương trình tenant #579): nhận diện riêng của trung tâm và
 * kích hoạt tài khoản quản trị đầu tiên bằng lời mời.
 *
 * Nhận diện sống trong database riêng của trung tâm (đọc từ kho
 * của trung tâm khi phục vụ địa chỉ của nó), không nằm ở sổ đăng
 * ký control plane — sổ chỉ giữ bản ghi định tuyến tối thiểu.
 * Kích hoạt là đường công khai duy nhất đặt mật khẩu cho tài khoản
 * chưa có mật khẩu: token lời mời dùng một lần, đốt trước rồi mới
 * đặt mật khẩu (fail-closed).
 */

/** Nhận diện riêng của một trung tâm, đọc từ kho của chính nó. */
export const centreIdentitySchema = z.object({
  tenantId: uuidIdSchema,
  displayName: z.string(),
  logoPath: z.string().nullable(),
  brandColor: z.string().nullable(),
});
export type CentreIdentity = z.infer<typeof centreIdentitySchema>;

/** Sửa nhận diện của trung tâm — chỉ quản trị của trung tâm đó. */
export const updateCentreIdentitySchema = z.strictObject({
  displayName: z.string().min(1).max(200).optional(),
  logoPath: z.string().max(500).nullable().optional(),
  brandColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
});
export type UpdateCentreIdentity = z.infer<typeof updateCentreIdentitySchema>;

/** Kích hoạt tài khoản quản trị đầu tiên bằng lời mời. */
export const activateCentreInviteSchema = z.strictObject({
  slug: z.string().min(1).max(63),
  token: z.string().min(1),
  password: z.string().min(1),
});
export type ActivateCentreInvite = z.infer<typeof activateCentreInviteSchema>;

/** Kết quả kích hoạt lời mời. */
export const centreInviteActivationSchema = z.object({
  activated: z.literal(true),
  userId: uuidIdSchema,
});
export type CentreInviteActivation = z.infer<typeof centreInviteActivationSchema>;
