/** Các bảng của bounded context Auth — định nghĩa Drizzle do module auth sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../users/schema';

/**
 * Họ refresh token cho xoay vòng + phát hiện tái sử dụng. Chỉ hash của
 * token được lưu. `ip` + `user_agent` là thông tin máy khách của request
 * lúc cấp họ, ghi MỘT LẦN khi tạo họ và không cập nhật khi xoay vòng —
 * đối chiếu trường `ipAddress`/`userAgent` trên phiên của Better Auth và
 * cột `firstip`/`lastip` trên bảng `sessions` của Moodle — để danh sách
 * phiên của chính user hiển thị đúng thiết bị/địa chỉ của phiên API.
 */
export const refreshTokenFamily = pgTable('refresh_token_family', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  familyId: text('family_id').notNull().unique(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: text('ip'),
  userAgent: text('user_agent'),
  currentTokenHash: text('current_token_hash').notNull(),
  previousTokenHash: text('previous_token_hash'),
  revoked: boolean('revoked').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('refresh_token_family_user_id_idx').on(table.userId),
  ]);


/**
 * MFA TOTP theo user (Moodle tool_mfa factor_totp): mỗi user tối đa một
 * secret TOTP. Secret KHÔNG bao giờ lưu thô — cột `secret_encrypted` giữ
 * bản mã AES-256-GCM (xem TotpService). `confirmed=false` là trạng thái
 * chờ: secret đã cấp ở bước setup nhưng user chưa chứng minh sở hữu
 * authenticator bằng một mã đúng; chỉ `confirmed=true` mới chặn đăng
 * nhập ở bước MFA.
 */
export const userTotp = pgTable('user_totp', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: text('secret_encrypted').notNull(),
  confirmed: boolean('confirmed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
},
  (table) => [
      index('user_totp_user_id_idx').on(table.userId),
  ]);


/**
 * Liên kết đăng nhập ngoài theo user (bảng `auth_oauth2_linked_login` của
 * Moodle): mỗi dòng nối một tài khoản nhà cung cấp (issuer + định danh chủ
 * thể phía provider) với một user nội bộ. Một user có tối đa một liên kết
 * mỗi issuer và một tài khoản provider chỉ nối được với một user — hai
 * ràng buộc duy nhất đó là nền của việc khớp tài khoản ở callback OAuth.
 * `email` là ảnh chụp email của provider tại thời điểm liên kết (phục vụ
 * hiển thị ở trang Linked logins, không dùng để khớp lại sau này).
 */
export const userOauthLinks = pgTable('user_oauth_links', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull(),
  issuerUserId: text('issuer_user_id').notNull(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      unique('user_oauth_links_issuer_subject_unique').on(table.issuer, table.issuerUserId),
      unique('user_oauth_links_user_issuer_unique').on(table.userId, table.issuer),
      index('user_oauth_links_user_id_idx').on(table.userId),
  ]);


/**
 * Các bảng lõi của Better Auth (issue #7, Giai đoạn 1) — tên vật lý dùng
 * đúng tên chuẩn của Better Auth, không tiền tố: bảng `users` hiện hữu là
 * bảng user của nó (thêm cột `email_verified`, `image` ở schema users);
 * bốn bảng dưới đây do Drizzle adapter của Better Auth ghi qua ánh xạ ở
 * `better-auth/better-auth.schema.ts`. Auth tự viết vẫn là đường chính
 * cho tới cutover ở Giai đoạn 2 — các bảng này tồn tại song song.
 */

/** Phiên cookie phía server của Better Auth (model `session`). */
export const authSession = pgTable('session', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('session_user_id_idx').on(table.userId),
  ]);

/** Tài khoản đăng nhập của Better Auth (model `account`): dòng credential giữ hash mật khẩu, dòng OAuth giữ token của nhà cung cấp. */
export const authAccount = pgTable('account', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('account_user_id_idx').on(table.userId),
      // Một user chỉ có tối đa MỘT account cho mỗi nhà cung cấp (điểm
      // giữ lại từ review Giai đoạn 1 của issue #7): dòng credential là
      // duy nhất theo cặp này, và tầng cơ sở dữ liệu tự chặn việc tạo
      // account thứ hai cho cùng một provider — các luồng tạo cặp
      // user + account dựa vào ràng buộc này để phát hiện trùng lặp
      // thay vì kiểm tra rời rạc phía ứng dụng.
      unique('account_user_id_provider_id_unique').on(table.userId, table.providerId),
  ]);

/** Mã xác thực dùng một lần của Better Auth (model `verification`): reset mật khẩu, xác thực email. */
export const authVerification = pgTable('verification', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TOTP + backup codes của plugin twoFactor của Better Auth (bảng
 * `two_factor`): secret và backup codes do plugin quản; plugin bật ở
 * Giai đoạn 2 — bảng có mặt trong baseline từ Giai đoạn 1 theo issue.
 * Cột `two_factor_enabled` trên `users` thuộc plugin, đến cùng Giai đoạn 2.
 */
export const authTwoFactor = pgTable('two_factor', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('two_factor_user_id_idx').on(table.userId),
  ]);

/** Failed-login bookkeeping for lockout (Moodle authlib lockout semantics). */
export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  success: boolean('success').notNull(),
  ip: text('ip'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('login_attempts_user_id_idx').on(table.userId),
  ]);

