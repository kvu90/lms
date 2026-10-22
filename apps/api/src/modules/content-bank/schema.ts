/** Các bảng của bounded context Content Bank — định nghĩa Drizzle do module content-bank sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Nội dung Content Bank: thuộc context, có tác giả, trạng thái draft/public, file qua FilesModule. */
export const contentbankContent = pgTable('contentbank_content', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contenttype: text('contenttype').notNull().default('file-based'),
  contextid: uuid('contextid').notNull(),
  creatorid: uuid('creatorid').notNull(),
  visibility: text('visibility').notNull().default('draft'), // draft | public
  fileid: uuid('fileid'),
  configdata: jsonb('configdata'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('contentbank_content_contextid_idx').on(table.contextid),
      index('contentbank_content_creatorid_idx').on(table.creatorid),
      index('contentbank_content_fileid_idx').on(table.fileid),
  ]);

