/** Các bảng của bounded context Auth — định nghĩa Drizzle do module auth sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
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

