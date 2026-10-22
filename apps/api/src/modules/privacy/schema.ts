/** Các bảng của bounded context Privacy — định nghĩa Drizzle do module privacy sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Yêu cầu Privacy: export/delete có phê duyệt, chạy nền, có trạng thái. */
export const privacyRequests = pgTable('privacy_requests', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  type: text('type').notNull(), // export | delete
  status: text('status').notNull().default('pending'), // pending | approved | rejected | completed | failed
  requestedby: uuid('requestedby').notNull(),
  approvedby: uuid('approvedby'),
  result: jsonb('result'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_requests_userid_idx').on(table.userid),
      index('privacy_requests_requestedby_idx').on(table.requestedby),
      index('privacy_requests_approvedby_idx').on(table.approvedby),
  ]);


/** File export của Privacy được lưu qua FilesModule. */
export const privacyExportFiles = pgTable('privacy_export_files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  requestid: uuid('requestid').notNull().references(() => privacyRequests.id, { onDelete: 'cascade' }),
  fileid: uuid('fileid'),
  subsystem: text('subsystem').notNull().default(''),
  manifest: jsonb('manifest'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_export_files_requestid_idx').on(table.requestid),
      index('privacy_export_files_fileid_idx').on(table.fileid),
  ]);

