/** Các bảng của bounded context Files — định nghĩa Drizzle do module files sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Logical file records (Moodle `files`). Physical bytes live once per contenthash (SHA-256) in content-addressed storage. */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contenthash: text('contenthash').notNull(),
  contextid: uuid('contextid').notNull(),
  component: text('component').notNull(),
  filearea: text('filearea').notNull(),
  itemid: uuid('itemid'),
  filepath: text('filepath').notNull().default('/'),
  filename: text('filename').notNull(),
  userid: uuid('userid'),
  filesize: integer('filesize').notNull(),
  mimetype: text('mimetype'),
  status: integer('status').notNull().default(0),
  source: text('source'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('files_contextid_idx').on(table.contextid),
      index('files_itemid_idx').on(table.itemid),
      index('files_userid_idx').on(table.userid),
  ]);

