/** Các bảng của bounded context Files — định nghĩa Drizzle do module files sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Logical file records (Moodle `files`). Physical bytes live once per contenthash (SHA-256) in content-addressed storage. */
export const files = pgTable('files', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  contenthash: text('contenthash').notNull(),
  contextid: integer('contextid').notNull(),
  component: text('component').notNull(),
  filearea: text('filearea').notNull(),
  itemid: integer('itemid').notNull().default(0),
  filepath: text('filepath').notNull().default('/'),
  filename: text('filename').notNull(),
  userid: integer('userid'),
  filesize: integer('filesize').notNull(),
  mimetype: text('mimetype'),
  status: integer('status').notNull().default(0),
  source: text('source'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});
