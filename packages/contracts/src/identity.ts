import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Identity & Access contracts — the single shape source between api and web. */

export const tokenPairSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
});
export type TokenPair = z.infer<typeof tokenPairSchema>;

export const loginResponseSchema = tokenPairSchema.extend({
  user: z.object({
    id: uuidIdSchema,
    username: z.string().min(1),
    forcePasswordChange: z.boolean(),
  }),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const customFieldValueSchema = z.object({
  shortname: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.string().nullable(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

/** Profile view: `email` is an identity field — absent unless the viewer holds moodle/site:viewuseridentity (or is the owner/admin). */
export const userProfileSchema = z.object({
  id: uuidIdSchema,
  username: z.string(),
  firstname: z.string(),
  lastname: z.string(),
  email: z.string().optional(),
  suspended: z.boolean(),
  deleted: z.boolean(),
  isGuest: z.boolean(),
  forcePasswordChange: z.boolean(),
  lastlogin: z.string().nullable(),
  timecreated: z.string(),
  customFields: z.array(customFieldValueSchema),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const userListResponseSchema = z.object({
  users: z.array(userProfileSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type UserListResponse = z.infer<typeof userListResponseSchema>;

export const roleSchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  shortname: z.string(),
  description: z.string(),
  archetype: z.string().nullable(),
});
export type Role = z.infer<typeof roleSchema>;

export const capabilitySchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  captype: z.string(),
  contextlevel: z.number().int(),
  component: z.string(),
});
export type Capability = z.infer<typeof capabilitySchema>;

/** Moodle permission constants shared by the roles admin UI. */
export const CAP = { PROHIBIT: -1000, PREVENT: -1, INHERIT: 0, ALLOW: 1 } as const;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất cho validation ở
 * API qua Standard Schema và cho form phía React; xem ADR về Zod-only) ---- */

/** Payload tạo context truy cập (cây context của hệ thống phân quyền). */
export const createContextSchema = z.strictObject({
  contextlevel: z.number().int(),
  instanceid: uuidIdSchema,
  parentId: uuidIdSchema.optional(),
});
export type CreateContext = z.infer<typeof createContextSchema>;

/** Payload tạo role. */
export const createRoleSchema = z.strictObject({
  name: z.string().min(1),
  shortname: z.string().min(1),
  description: z.string().optional(),
  archetype: z.string().optional(),
});
export type CreateRole = z.infer<typeof createRoleSchema>;

/** Payload sửa role (mọi trường đều tuỳ chọn). */
export const updateRoleSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().optional(),
});
export type UpdateRole = z.infer<typeof updateRoleSchema>;

/** Payload gán role cho người dùng trong một context. */
export const assignRoleSchema = z.strictObject({
  userid: uuidIdSchema,
  roleid: uuidIdSchema,
  contextid: uuidIdSchema,
});
export type AssignRole = z.infer<typeof assignRoleSchema>;

/** Payload ghi đè quyền (capability override) của một role trong một context. */
export const overrideCapabilitySchema = z.strictObject({
  roleid: uuidIdSchema,
  capability: z.string(),
  contextid: uuidIdSchema,
  permission: z.number().int(),
});
export type OverrideCapability = z.infer<typeof overrideCapabilitySchema>;

/** Query kiểm tra quyền: người dùng có capability trong context hay không (dạng nền — phía server ép kiểu từ query string). */
export const hasCapabilityQuerySchema = z.strictObject({
  userid: uuidIdSchema,
  capability: z.string(),
  contextid: uuidIdSchema,
});
export type HasCapabilityQuery = z.infer<typeof hasCapabilityQuerySchema>;

/** Payload tạo người dùng. */
export const createUserSchema = z.strictObject({
  username: z.string().min(1),
  email: z.email(),
  password: z.string().min(1),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  forcePasswordChange: z.boolean().optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type CreateUser = z.infer<typeof createUserSchema>;

/** Payload sửa người dùng (mọi trường đều tuỳ chọn). */
export const updateUserSchema = z.strictObject({
  email: z.email().optional(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  password: z.string().optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

/** Query danh sách người dùng (dạng nền — phía server ép kiểu phân trang từ query string). */
export const listUsersQuerySchema = z.strictObject({
  search: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** Payload đặt một tuỳ chọn (preference) của người dùng. */
export const setUserPreferenceSchema = z.strictObject({
  name: z.string(),
  value: z.string().optional(),
});
export type SetUserPreference = z.infer<typeof setUserPreferenceSchema>;

/** Payload đăng nhập bằng username/password. */
export const loginSchema = z.strictObject({
  username: z.string(),
  password: z.string(),
});
export type Login = z.infer<typeof loginSchema>;

/** Payload làm mới / thu hồi phiên bằng refresh token. */
export const refreshTokenSchema = z.strictObject({
  refreshToken: z.string(),
});
export type RefreshToken = z.infer<typeof refreshTokenSchema>;

/** Payload đổi mật khẩu của chính người dùng. */
export const changePasswordSchema = z.strictObject({
  currentPassword: z.string(),
  newPassword: z.string().min(1),
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;

/** Payload đăng nhập thay (login-as) — chỉ quản trị viên có quyền mới dùng được. */
export const loginAsSchema = z.strictObject({
  userid: uuidIdSchema,
});
export type LoginAs = z.infer<typeof loginAsSchema>;

/** Mã TOTP 6 chữ số do ứng dụng authenticator sinh (RFC 6238, bước 30 giây). */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/** Payload xác nhận/tắt MFA TOTP: chỉ gồm mã authenticator hiện tại. */
export const mfaTotpCodeSchema = z.strictObject({
  code: totpCodeSchema,
});
export type MfaTotpCode = z.infer<typeof mfaTotpCodeSchema>;

/** Payload hoàn tất đăng nhập hai lớp: challenge token ngắn hạn + mã TOTP. */
export const mfaVerifySchema = z.strictObject({
  challengeToken: z.string().min(1),
  code: totpCodeSchema,
});
export type MfaVerify = z.infer<typeof mfaVerifySchema>;

/** Đáp ứng khởi tạo MFA TOTP: secret + otpauth URL chỉ lộ DUY NHẤT ở bước này. */
export const mfaTotpSetupResponseSchema = z.object({
  secret: z.string().min(1),
  otpauthUrl: z.string().startsWith('otpauth://totp/'),
});
export type MfaTotpSetupResponse = z.infer<typeof mfaTotpSetupResponseSchema>;

/** Đáp ứng đăng nhập khi user đã bật MFA: chưa có token phiên, phải verify tiếp. */
export const mfaChallengeResponseSchema = z.object({
  mfaRequired: z.literal(true),
  challengeToken: z.string().min(1),
  user: z.object({ id: uuidIdSchema, username: z.string().min(1) }),
});
export type MfaChallengeResponse = z.infer<typeof mfaChallengeResponseSchema>;

/** Một gán vai trò của chính người gọi, kèm thông tin context để giao diện dựng điều hướng theo quyền. */
export const myRoleAssignmentSchema = z.object({
  id: uuidIdSchema,
  roleId: uuidIdSchema,
  roleShortname: z.string(),
  roleName: z.string(),
  contextId: uuidIdSchema,
  contextLevel: z.number().int(),
  contextPath: z.string(),
  instanceId: uuidIdSchema.nullable(),
});
export type MyRoleAssignment = z.infer<typeof myRoleAssignmentSchema>;

/** Capability đã phân giải tại một context liên quan (context có gán vai trò hoặc tổ tiên của nó, luôn gồm context hệ thống). */
export const myContextCapabilitiesSchema = z.object({
  contextId: uuidIdSchema,
  contextLevel: z.number().int(),
  contextPath: z.string(),
  capabilities: z.array(z.string()),
});
export type MyContextCapabilities = z.infer<typeof myContextCapabilitiesSchema>;

/** Toàn cảnh quyền của chính người đang đăng nhập — dữ liệu tự phục vụ, không cần capability quản trị. */
export const myAccessViewSchema = z.object({
  userId: uuidIdSchema,
  isSiteAdmin: z.boolean(),
  assignments: z.array(myRoleAssignmentSchema),
  contexts: z.array(myContextCapabilitiesSchema),
});
export type MyAccessView = z.infer<typeof myAccessViewSchema>;

/** Payload tạo danh mục trường tuỳ chỉnh (custom field category). */
export const createCustomFieldCategorySchema = z.strictObject({
  name: z.string(),
  component: z.string(),
  area: z.string(),
});
export type CreateCustomFieldCategory = z.infer<typeof createCustomFieldCategorySchema>;

/** Payload tạo trường tuỳ chỉnh; `configdata` là cấu hình riêng theo loại trường. */
export const createCustomFieldSchema = z.strictObject({
  categoryid: uuidIdSchema,
  shortname: z.string(),
  name: z.string(),
  type: z.string(),
  configdata: z.record(z.string(), z.unknown()).optional(),
});
export type CreateCustomField = z.infer<typeof createCustomFieldSchema>;
