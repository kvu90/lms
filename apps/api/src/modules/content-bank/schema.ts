/** Các bảng của bounded context Content Bank — định nghĩa Drizzle do module content-bank sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Nội dung Content Bank: thuộc context, có tác giả, trạng thái draft/public, file qua FilesModule. */
export const contentbankContent = pgTable('contentbank_content', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  contenttype: text('contenttype').notNull().default('file-based'),
  contextid: integer('contextid').notNull(),
  creatorid: integer('creatorid').notNull(),
  visibility: text('visibility').notNull().default('draft'), // draft | public
  fileid: integer('fileid'),
  configdata: jsonb('configdata'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});
