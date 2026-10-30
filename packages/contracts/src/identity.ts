import { z } from 'zod';
import { uuidIdSchema } from './ids.js';

/** Contract Danh tính & Truy cập — nguồn shape duy nhất giữa api và web. */

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
  shortName: z.string(),
  name: z.string(),
  type: z.string(),
  value: z.string().nullable(),
});
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

/** View hồ sơ: `email` là trường danh tính — vắng mặt trừ khi người xem nắm giữ site:viewuseridentity (hoặc là chủ sở hữu/admin). */
export const userProfileSchema = z.object({
  id: uuidIdSchema,
  username: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string().optional(),
  suspended: z.boolean(),
  deleted: z.boolean(),
  isGuest: z.boolean(),
  forcePasswordChange: z.boolean(),
  lastLogin: z.string().nullable(),
  createdAt: z.string(),
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
  shortName: z.string(),
  description: z.string(),
  archetype: z.string().nullable(),
});
export type Role = z.infer<typeof roleSchema>;

export const capabilitySchema = z.object({
  id: uuidIdSchema,
  name: z.string(),
  capType: z.string(),
  contextLevel: z.number().int(),
  component: z.string(),
});
export type Capability = z.infer<typeof capabilitySchema>;

/** Các hằng số quyền của Moodle dùng chung cho UI quản trị role. */
export const CAP = { PROHIBIT: -1000, PREVENT: -1, INHERIT: 0, ALLOW: 1 } as const;

/* ---- Request payload schemas (Zod — nguồn sự thật duy nhất cho validation ở
 * API qua Standard Schema và cho form phía React) ---- */

/** Payload tạo context truy cập (cây context của hệ thống phân quyền). */
export const createContextSchema = z.strictObject({
  contextLevel: z.number().int(),
  instanceId: uuidIdSchema,
  parentId: uuidIdSchema.optional(),
});
export type CreateContext = z.infer<typeof createContextSchema>;

/** Payload tạo role. */
export const createRoleSchema = z.strictObject({
  name: z.string().min(1),
  shortName: z.string().min(1),
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
  userId: uuidIdSchema,
  roleId: uuidIdSchema,
  contextId: uuidIdSchema,
});
export type AssignRole = z.infer<typeof assignRoleSchema>;

/** Payload ghi đè quyền (capability override) của một role trong một context. */
export const overrideCapabilitySchema = z.strictObject({
  roleId: uuidIdSchema,
  capability: z.string(),
  contextId: uuidIdSchema,
  permission: z.number().int(),
});
export type OverrideCapability = z.infer<typeof overrideCapabilitySchema>;

/** Query kiểm tra quyền: người dùng có capability trong context hay không (dạng nền — phía server ép kiểu từ query string). */
export const hasCapabilityQuerySchema = z.strictObject({
  userId: uuidIdSchema,
  capability: z.string(),
  contextId: uuidIdSchema,
});
export type HasCapabilityQuery = z.infer<typeof hasCapabilityQuerySchema>;

/**
 * Một dòng vai trong danh sách vai kèm dữ kiện tổng hợp phía server: số
 * người dùng phân biệt đang giữ vai (một người giữ cùng vai ở nhiều
 * context sinh nhiều dòng gán — đếm theo người, không đếm dòng) và tổng
 * hợp năng lực tính từ tập ghi đè đã lưu của vai (tổng số ghi đè, số ghi
 * đè theo `capType` read/write của năng lực, số resource phân biệt mà
 * các ghi đè chạm tới — resource là tiền tố trước dấu `:` của tên năng
 * lực). Nhờ các trường này, thẻ vai dựng được từ đúng một lần gọi danh
 * sách, không gọi thêm theo từng vai.
 */
export const roleListItemSchema = roleSchema.extend({
  userCount: z.number().int().min(0),
  overrideCount: z.number().int().min(0),
  readOverrideCount: z.number().int().min(0),
  writeOverrideCount: z.number().int().min(0),
  resourceCount: z.number().int().min(0),
});
export type RoleListItem = z.infer<typeof roleListItemSchema>;

/**
 * Payload lưu ma trận quyền thay toàn bộ cho một vai tại đúng một
 * context: sau khi áp dụng thành công, tập ghi đè của vai tại context đó
 * bằng đúng tập gửi lên — phần tử vắng mặt trong tập trở về kế thừa, và
 * phần tử mang giá trị INHERIT (0) tường minh cũng tương đương không có
 * ghi đè. Giá trị quyền thuộc bốn trạng thái đã chốt (ALLOW = 1,
 * INHERIT = 0, PREVENT = −1, PROHIBIT = −1000); việc từ chối giá trị
 * ngoài bốn trạng thái và tên năng lực ngoài danh mục nằm ở tầng service
 * của API với mã lỗi riêng, cùng khuôn với thao tác đặt một ghi đè hiện
 * hành. Thao tác là nguyên tử: lỗi kiểm chứng thì không thay đổi gì.
 */
export const replaceRoleCapabilitiesSchema = z.strictObject({
  contextId: uuidIdSchema,
  overrides: z.array(z.strictObject({
    capability: z.string().min(1),
    permission: z.number().int(),
  })),
});
export type ReplaceRoleCapabilities = z.infer<typeof replaceRoleCapabilitiesSchema>;

/**
 * Query liệt kê gán vai (dạng nền — phía server ép kiểu `page`/`pageSize`
 * từ query string): lọc tuỳ chọn theo người dùng, context và vai; tìm
 * kiếm theo người dùng khớp trên tên và email; phân trang phía server.
 */
export const listAssignmentsQuerySchema = z.strictObject({
  userId: uuidIdSchema.optional(),
  contextId: uuidIdSchema.optional(),
  roleId: uuidIdSchema.optional(),
  search: z.string().optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).optional(),
});
export type ListAssignmentsQuery = z.infer<typeof listAssignmentsQuerySchema>;

/**
 * Một dòng gán vai trong bảng gán vai: giữ nguyên các trường của dòng
 * gán đã lưu (gồm `component` — nguồn gán, phân biệt dòng do ghi danh
 * quản lý — và `updatedAt`), kèm tên đầy đủ và email của người dùng được
 * gán do server ghép sẵn. Tên/email là `null` khi dòng gán trỏ tới người
 * dùng không còn tồn tại (dòng gán không có khoá ngoại tới bảng người
 * dùng nên vẫn phải liệt kê được).
 */
export const assignmentListItemSchema = z.object({
  id: uuidIdSchema,
  roleId: uuidIdSchema,
  userId: uuidIdSchema,
  contextId: uuidIdSchema,
  component: z.string(),
  itemId: uuidIdSchema.nullable(),
  modifierId: uuidIdSchema.nullable(),
  updatedAt: z.iso.datetime(),
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});
export type AssignmentListItem = z.infer<typeof assignmentListItemSchema>;

/** Phản hồi liệt kê gán vai đã phân trang: các dòng của trang hiện tại kèm tổng số dòng khớp bộ lọc. */
export const assignmentListResponseSchema = z.object({
  assignments: z.array(assignmentListItemSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type AssignmentListResponse = z.infer<typeof assignmentListResponseSchema>;

/** Payload tạo người dùng. */
export const createUserSchema = z.strictObject({
  username: z.string().min(1),
  email: z.email(),
  password: z.string().min(1),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  forcePasswordChange: z.boolean().optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type CreateUser = z.infer<typeof createUserSchema>;

/** Payload sửa người dùng (mọi trường đều tuỳ chọn). */
export const updateUserSchema = z.strictObject({
  email: z.email().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  password: z.string().optional(),
  customFields: z.record(z.string(), z.string()).optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

/**
 * Nhóm trạng thái tài khoản mà danh sách người dùng lọc theo — suy ra từ hai
 * cờ `suspended`/`deleted` của tài khoản: `active` là chưa xoá và không bị
 * đình chỉ; `suspended` là chưa xoá và đang bị đình chỉ; `deleted` là đã xoá
 * mềm. Không truyền `status` thì danh sách ẩn tài khoản đã xoá như hành vi
 * vốn có — tài khoản đã xoá chỉ xuất hiện khi lọc đích danh `deleted`.
 */
export const userListStatusSchema = z.enum(['active', 'suspended', 'deleted']);
export type UserListStatus = z.infer<typeof userListStatusSchema>;

/**
 * Trường sắp xếp của danh sách người dùng — tập đóng: `name` sắp theo cột
 * `firstName` rồi `lastName`, `createdAt` theo thời điểm tạo tài khoản,
 * `lastLogin` theo lần đăng nhập gần nhất. Giá trị ngoài tập bị validation
 * chặn. Không truyền `sortBy` thì danh sách giữ thứ tự mặc định theo id như
 * hành vi vốn có.
 */
export const userListSortBySchema = z.enum(['name', 'createdAt', 'lastLogin']);
export type UserListSortBy = z.infer<typeof userListSortBySchema>;

/**
 * Query danh sách người dùng (dạng nền — phía server ép kiểu phân trang từ
 * query string). `sortDirection` chỉ có hiệu lực khi có `sortBy`, mặc định
 * `asc`. Trần `pageSize` là 100, khớp trần của danh sách gán vai quản trị —
 * mọi danh sách quản trị phân trang phía server đều có trần cứng để chặn
 * truy vấn quá lớn.
 */
export const listUsersQuerySchema = z.strictObject({
  search: z.string().optional(),
  status: userListStatusSchema.optional(),
  sortBy: userListSortBySchema.optional(),
  sortDirection: z.enum(['asc', 'desc']).optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * Truy vấn danh sách người dùng kèm gán vai (`GET /access/users-with-assignments`)
 * — nguồn dữ kiện cho bảng người dùng của trang vai trò, nơi mỗi người dùng
 * chiếm đúng MỘT dòng kèm toàn bộ dòng gán của họ.
 *
 * Đơn vị phân trang ở đây là NGƯỜI DÙNG, khác `GET /access/assignments` phân
 * trang theo từng dòng gán: một người giữ nhiều vai ở nhiều context vẫn chỉ
 * chiếm một dòng, nên `page`/`pageSize` cắt trên tập người dùng đã lọc và
 * `total` ở schema phản hồi đếm người dùng khớp lọc, không đếm dòng gán.
 * Ba bộ lọc áp đồng thời phía server:
 * - `search`: khớp một phần, không phân biệt hoa thường, trên firstName,
 *   lastName, email, username và họ tên đầy đủ — cùng tập trường với tìm
 *   kiếm của danh sách người dùng và của bảng gán vai hiện hành.
 * - `roleId`: chỉ giữ người dùng có ÍT NHẤT MỘT dòng gán với vai này ở bất
 *   kỳ context nào. Đây thuần là điều kiện lọc người; mảng `assignments`
 *   trong kết quả vẫn mang TOÀN BỘ dòng gán của người đó, không bị cắt theo
 *   vai đang lọc, để giao diện thấy đủ vai trò thật của từng người.
 * - `status`: dùng chung tập đóng và ngữ nghĩa với
 *   `listUsersQuerySchema.status` — không truyền thì chỉ lấy tài khoản chưa
 *   xoá (gồm cả tài khoản đang bị đình chỉ); `active` là chưa xoá và không
 *   bị đình chỉ; `suspended` là chưa xoá đang bị đình chỉ; `deleted` chỉ
 *   lấy tài khoản đã xoá mềm.
 * `pageSize` trần 100 như các danh sách quản trị khác của module. Thứ tự
 * kết quả ổn định theo id người dùng tăng dần (không có tham số sắp xếp
 * riêng) để các trang không chồng lấp hay bỏ sót người.
 * Khi client phá ràng buộc đóng ở đây (status ngoài tập, pageSize vượt
 * trần…), tầng api chặn bằng lỗi `http.validation_failed` — mã lỗi thật
 * của cơ chế validation ProblemDetails toàn cục, không có mã riêng cho
 * endpoint này.
 */
export const listUsersWithAssignmentsQuerySchema = z.strictObject({
  search: z.string().optional(),
  roleId: uuidIdSchema.optional(),
  status: userListStatusSchema.optional(),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
});
export type ListUsersWithAssignmentsQuery = z.infer<typeof listUsersWithAssignmentsQuerySchema>;

/**
 * Một dòng gán vai nằm trong danh sách người dùng kèm gán: đủ để giao diện
 * bày vai trò của người dùng theo từng context mà không cần gọi thêm.
 * `roleName` là tên hiển thị của vai (bảng gán vai hiện hành chỉ trả
 * `roleId`, giao diện phải tự tra tên). `contextLevel` là SỐ cấp của
 * context (10 hệ thống, 20 trung tâm, 50 khoá học…) — việc giải quyết TÊN
 * thực thể của context nằm ngoài hợp đồng này. `component` giữ nguyên cơ
 * chế truy vết nguồn gán của bảng gán vai: rỗng là gán tay qua quản trị,
 * `enrol` là gán do một ghi danh cấp — giao diện dựa vào đây để biết dòng
 * gán nào gỡ trực tiếp được, dòng nào phải gỡ qua ghi danh.
 */
export const userAssignmentEntrySchema = z.object({
  id: uuidIdSchema,
  roleId: uuidIdSchema,
  roleName: z.string(),
  contextId: uuidIdSchema,
  contextLevel: z.number().int(),
  component: z.string(),
});
export type UserAssignmentEntry = z.infer<typeof userAssignmentEntrySchema>;

/**
 * Một người dùng trong danh sách kèm gán vai: thông tin tài khoản tối thiểu
 * cho một dòng của bảng (định danh, họ tên, email, hai cờ trạng thái) kèm
 * `createdAt` — thời điểm tạo tài khoản cho cột ngày tham gia; hợp đồng
 * danh sách gán hiện hành không mang trường này nên bảng không dựng được
 * cột đó nếu thiếu. `assignments` chứa toàn bộ dòng gán của người dùng
 * (mảng rỗng khi người chưa giữ vai nào), thứ tự theo id dòng gán tăng dần.
 */
export const userWithAssignmentsListItemSchema = z.object({
  id: uuidIdSchema,
  username: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.string(),
  suspended: z.boolean(),
  deleted: z.boolean(),
  createdAt: z.iso.datetime(),
  assignments: z.array(userAssignmentEntrySchema),
});
export type UserWithAssignmentsListItem = z.infer<typeof userWithAssignmentsListItemSchema>;

/**
 * Phản hồi danh sách người dùng kèm gán vai: `users` là các người dùng của
 * trang hiện tại (mỗi người đúng một phần tử), `total` là tổng số NGƯỜI
 * DÙNG khớp bộ lọc trên toàn bộ kết quả — không phải tổng số dòng gán —
 * kèm `page`/`pageSize` đã áp để giao diện dựng phân trang.
 */
export const userWithAssignmentsListResponseSchema = z.object({
  users: z.array(userWithAssignmentsListItemSchema),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
});
export type UserWithAssignmentsListResponse = z.infer<typeof userWithAssignmentsListResponseSchema>;

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

/** Payload đăng nhập thay (login-as) — chỉ quản trị viên có quyền mới dùng được. Từ TENANT-1 (#196): `reason` là BẮT BUỘC — platform vào danh tính trong tenant phải có lý do và để lại vết audit đầy đủ. */
export const loginAsSchema = z.strictObject({
  userId: uuidIdSchema,
  reason: z.string().trim().min(1).max(500),
});
export type LoginAs = z.infer<typeof loginAsSchema>;

/** Mã TOTP 6 chữ số do ứng dụng authenticator sinh (RFC 6238, bước 30 giây). */
export const totpCodeSchema = z.string().regex(/^\d{6}$/);

/** Payload xác nhận/tắt MFA TOTP: chỉ gồm mã authenticator hiện tại. */
export const mfaTotpCodeSchema = z.strictObject({
  code: totpCodeSchema,
});
export type MfaTotpCode = z.infer<typeof mfaTotpCodeSchema>;

/**
 * Payload khởi tạo MFA TOTP. Toàn bộ thân là KHÔNG bắt buộc (client hiện
 * tại gọi setup không kèm thân vẫn hợp lệ). Trường `currentCode` — mã
 * authenticator hiện tại — chỉ bắt buộc về mặt nghiệp vụ ở phía server khi
 * tài khoản ĐÃ có một factor đang bật: setup lại lúc đó là thao tác thay
 * factor đang hoạt động nên phải tái xác thực trước khi ghi đè (cùng khuôn
 * với payload tắt MFA ở trên); chưa có factor đang bật thì không cần mã.
 */
export const mfaTotpSetupSchema = z
  .strictObject({
    currentCode: totpCodeSchema.optional(),
  })
  .optional();
export type MfaTotpSetup = z.infer<typeof mfaTotpSetupSchema>;

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

/** Đáp ứng trạng thái MFA TOTP của chính người dùng: chỉ lộ cờ đã bật hay chưa, không lộ secret. */
export const mfaStatusResponseSchema = z.object({
  enabled: z.boolean(),
});
export type MfaStatusResponse = z.infer<typeof mfaStatusResponseSchema>;

/** Nhà cung cấp danh tính ngoài được hỗ trợ (plugin lõi auth_oauth2 của Moodle: issuer dựng sẵn Google và Facebook). */
export const oauthIssuerSchema = z.enum(['google', 'facebook']);
export type OAuthIssuer = z.infer<typeof oauthIssuerSchema>;

/** Một issuer trong đáp ứng cấu hình công khai: `enabled=false` nghĩa là quản trị chưa cấu hình client id/secret nên giao diện không hiện nút đăng nhập (đúng hành vi Moodle — issuer chưa bật thì không xuất hiện ở trang login). */
export const oauthProviderSchema = z.object({
  issuer: oauthIssuerSchema,
  enabled: z.boolean(),
});
export type OAuthProvider = z.infer<typeof oauthProviderSchema>;

/** Đáp ứng GET /auth/oauth/providers — dữ liệu công khai tối thiểu để trang login quyết định hiện nút nào. */
export const oauthProvidersResponseSchema = z.object({
  providers: z.array(oauthProviderSchema),
});
export type OAuthProvidersResponse = z.infer<typeof oauthProvidersResponseSchema>;

/** Đáp ứng bước khởi tạo OAuth: URL authorize của nhà cung cấp để trình duyệt chuyển hướng tới (kèm state đã ký). */
export const oauthAuthorizeResponseSchema = z.object({
  authorizeUrl: z.string().min(1),
});
export type OAuthAuthorizeResponse = z.infer<typeof oauthAuthorizeResponseSchema>;

/** Payload đổi mã bàn giao một lần (handoff) sau callback OAuth lấy cặp token như đăng nhập thường. */
export const oauthHandoffSchema = z.strictObject({
  code: z.string().min(1),
});
export type OAuthHandoff = z.infer<typeof oauthHandoffSchema>;

/** Một liên kết đăng nhập ngoài của chính user (trang Linked logins của Moodle, auth_oauth2). */
export const oauthLinkSchema = z.object({
  id: uuidIdSchema,
  issuer: oauthIssuerSchema,
  email: z.string(),
  createdAt: z.string(),
});
export type OAuthLink = z.infer<typeof oauthLinkSchema>;

/** Đáp ứng GET /auth/oauth/links: danh sách liên kết + `hasPassword` để giao diện giải thích được ràng buộc không gỡ liên kết cuối cùng khi user chưa có mật khẩu. */
export const oauthLinksResponseSchema = z.object({
  links: z.array(oauthLinkSchema),
  hasPassword: z.boolean(),
});
export type OAuthLinksResponse = z.infer<typeof oauthLinksResponseSchema>;

/** Đáp ứng đăng nhập phiên cookie thành công (session id cũng được đặt qua cookie HttpOnly; body mang theo để client không phụ thuộc cookie đọc được). */
export const sessionLoginResponseSchema = z.object({
  user: z.object({
    id: uuidIdSchema,
    username: z.string().min(1),
    forcePasswordChange: z.boolean(),
  }),
  sessionId: uuidIdSchema,
});
export type SessionLoginResponse = z.infer<typeof sessionLoginResponseSchema>;

/** Một phiên đang hoạt động của chính user trong trang quản lý phiên (report_usersessions của Moodle): `web` là phiên cookie phía server, `api` là một họ refresh token. */
export const mySessionSchema = z.object({
  id: uuidIdSchema,
  kind: z.enum(['web', 'api']),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type MySession = z.infer<typeof mySessionSchema>;

/** Đáp ứng GET /auth/sessions — mọi phiên đang hoạt động của chính người gọi. */
export const mySessionsResponseSchema = z.object({
  sessions: z.array(mySessionSchema),
});
export type MySessionsResponse = z.infer<typeof mySessionsResponseSchema>;

/** Đáp ứng các thao tác thu hồi phiên: số phiên đã thu hồi. */
export const revokeSessionsResponseSchema = z.object({
  revoked: z.number().int().min(0),
});
export type RevokeSessionsResponse = z.infer<typeof revokeSessionsResponseSchema>;

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
  /**
   * Cờ hiện vật học tập (issue #176): true khi người gọi có ít nhất một
   * huy hiệu đã cấp chưa thu hồi hoặc một kế hoạch học tập của chính
   * mình — cùng với `learning` suy từ gán vai, cờ này quyết định nhóm
   * "Học tập" ở sidebar có hiện hay không (dấu chân học tập M+A).
   */
  hasLearnerArtifacts: z.boolean(),
});
export type MyAccessView = z.infer<typeof myAccessViewSchema>;

/** Payload tạo danh mục trường tuỳ chỉnh (custom field category). */
export const createCustomFieldCategorySchema = z.strictObject({
  name: z.string(),
  component: z.string(),
  area: z.string(),
});
export type CreateCustomFieldCategory = z.infer<typeof createCustomFieldCategorySchema>;

/** Payload tạo trường tuỳ chỉnh; `configData` là cấu hình riêng theo loại trường. */
export const createCustomFieldSchema = z.strictObject({
  categoryId: uuidIdSchema,
  shortName: z.string(),
  name: z.string(),
  type: z.string(),
  configData: z.record(z.string(), z.unknown()).optional(),
});
export type CreateCustomField = z.infer<typeof createCustomFieldSchema>;
