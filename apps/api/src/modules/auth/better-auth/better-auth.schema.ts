/**
 * Ánh xạ Drizzle cho adapter của Better Auth (issue #7, Giai đoạn 1).
 *
 * Đây là schema RIÊNG mà Drizzle adapter nhận qua tham số — nó mô tả các
 * model của Better Auth (user/session/account/verification) trên đúng các
 * bảng vật lý mà baseline định nghĩa ở `modules/users/schema.ts` (bảng
 * `users`) và `modules/auth/schema.ts` (bảng `session`/`account`/
 * `verification`). Tên thuộc tính ở đây là tên field của Better Auth; tên
 * cột là tên vật lý — hai phía phải khớp từng cột, và các flow test của
 * Giai đoạn 1 chạy trên chính baseline để chứng minh điều đó.
 *
 * Điểm nối đáng chú ý: model `user` của Better Auth có field `name` bắt
 * buộc trong khi nghiệp vụ giữ `first_name`/`last_name` là chuẩn — field
 * `name` ánh xạ lên cột `first_name` (tên hiển thị đầy đủ ghép
 * firstname + lastname là việc của tầng hiển thị/Giai đoạn 2, không đổi
 * mô hình dữ liệu nghiệp vụ).
 */
import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const betterAuthUsers = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('first_name').notNull().default(''),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  username: text('username').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthSession = pgTable('session', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: uuid('user_id')
    .notNull()
    .references(() => betterAuthUsers.id, { onDelete: 'cascade' }),
});

export const betterAuthAccount = pgTable('account', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => betterAuthUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const betterAuthVerification = pgTable('verification', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Schema object theo đúng hình adapter của Better Auth yêu cầu (khoá là tên model). */
export const betterAuthSchema = {
  user: betterAuthUsers,
  session: betterAuthSession,
  account: betterAuthAccount,
  verification: betterAuthVerification,
};
