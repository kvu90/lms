/** Các bảng của bounded context Users — định nghĩa Drizzle do module users sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Users (Moodle `user` → `users`, reserved-word rename per report §3.2). Soft delete keeps the row (deleted=1). */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  // Hai cột do Better Auth yêu cầu trên bảng user của nó (issue #7): trạng
  // thái đã xác thực email và ảnh đại diện. `users` chính là bảng user của
  // Better Auth qua Drizzle adapter — xem modules/auth/better-auth.
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  passwordHash: text('password_hash'),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  suspended: boolean('suspended').notNull().default(false),
  deleted: boolean('deleted').notNull().default(false),
  forcePasswordChange: boolean('force_password_change').notNull().default(false),
  isGuest: boolean('is_guest').notNull().default(false),
  lastLogin: timestamp('last_login', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Free-form per-user preferences (Moodle `user_preferences`). */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('user_preferences_unique').on(table.userId, table.name)],
);
