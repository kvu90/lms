/** Các bảng của bounded context Integrations (Web Services) — định nghĩa Drizzle do module integrations sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Dịch vụ ngoài (Web Services): tập function được phép gọi bằng token. */
export const externalServices = pgTable('external_services', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull().unique(),
  shortName: text('short_name').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  functions: jsonb('functions').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Token ngoài: chỉ lưu HASH của token, gắn user + service, có hạn và IP whitelist tuỳ chọn. */
export const externalTokens = pgTable('external_tokens', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tokenHash: text('token_hash').notNull().unique(),
  userId: uuid('user_id').notNull(),
  serviceId: uuid('service_id').notNull().references(() => externalServices.id, { onDelete: 'cascade' }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  ipRestriction: text('ip_restriction'),
  revoked: boolean('revoked').notNull().default(false),
  lastAccess: timestamp('last_access', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('external_tokens_user_id_idx').on(table.userId),
      index('external_tokens_service_id_idx').on(table.serviceId),
  ]);

