/** Các bảng của bounded context Auth — định nghĩa Drizzle do module auth sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '../users/schema';

/** Refresh token families for rotation + reuse detection (self-built per report §3.7). Only hashes are stored. */
export const refreshTokenFamily = pgTable('refresh_token_family', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  familyId: text('family_id').notNull().unique(),
  userid: uuid('userid').notNull().references(() => users.id, { onDelete: 'cascade' }),
  currentTokenHash: text('current_token_hash').notNull(),
  previousTokenHash: text('previous_token_hash'),
  revoked: boolean('revoked').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp('rotated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('refresh_token_family_userid_idx').on(table.userid),
  ]);


/** Failed-login bookkeeping for lockout (Moodle authlib lockout semantics). */
export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').references(() => users.id, { onDelete: 'cascade' }),
  username: text('username').notNull(),
  success: boolean('success').notNull(),
  ip: text('ip'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('login_attempts_userid_idx').on(table.userid),
  ]);

