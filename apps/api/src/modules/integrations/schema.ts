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
  shortname: text('shortname').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  functions: jsonb('functions').notNull().default([]),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Token ngoài: chỉ lưu HASH của token, gắn user + service, có hạn và IP whitelist tuỳ chọn. */
export const externalTokens = pgTable('external_tokens', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  tokenhash: text('tokenhash').notNull().unique(),
  userid: uuid('userid').notNull(),
  serviceid: uuid('serviceid').notNull().references(() => externalServices.id, { onDelete: 'cascade' }),
  validuntil: timestamp('validuntil', { withTimezone: true }),
  iprestriction: text('iprestriction'),
  revoked: boolean('revoked').notNull().default(false),
  lastaccess: timestamp('lastaccess', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('external_tokens_userid_idx').on(table.userid),
      index('external_tokens_serviceid_idx').on(table.serviceid),
  ]);

