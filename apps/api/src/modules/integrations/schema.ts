/** Các bảng của bounded context Integrations (Web Services) — định nghĩa Drizzle do module integrations sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Dịch vụ ngoài (Web Services): tập function được phép gọi bằng token. */
export const externalServices = pgTable('external_services', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull().unique(),
  shortname: text('shortname').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  functions: jsonb('functions').notNull().default([]),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Token ngoài: chỉ lưu HASH của token, gắn user + service, có hạn và IP whitelist tuỳ chọn. */
export const externalTokens = pgTable('external_tokens', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tokenhash: text('tokenhash').notNull().unique(),
  userid: integer('userid').notNull(),
  serviceid: integer('serviceid').notNull().references(() => externalServices.id, { onDelete: 'cascade' }),
  validuntil: timestamp('validuntil', { withTimezone: true }),
  iprestriction: text('iprestriction'),
  revoked: boolean('revoked').notNull().default(false),
  lastaccess: timestamp('lastaccess', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});
