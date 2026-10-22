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
  passwordHash: text('password_hash'),
  firstname: text('firstname').notNull().default(''),
  lastname: text('lastname').notNull().default(''),
  suspended: boolean('suspended').notNull().default(false),
  deleted: boolean('deleted').notNull().default(false),
  forcePasswordChange: boolean('force_password_change').notNull().default(false),
  isGuest: boolean('is_guest').notNull().default(false),
  lastlogin: timestamp('lastlogin', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Free-form per-user preferences (Moodle `user_preferences`). */
export const userPreferences = pgTable(
  'user_preferences',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userid: uuid('userid').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('user_preferences_unique').on(table.userid, table.name)],
);
