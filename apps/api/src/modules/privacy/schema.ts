/** Các bảng của bounded context Privacy — định nghĩa Drizzle do module privacy sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** Yêu cầu Privacy: export/delete có phê duyệt, chạy nền, có trạng thái. */
export const privacyRequests = pgTable('privacy_requests', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userid: integer('userid').notNull(),
  type: text('type').notNull(), // export | delete
  status: text('status').notNull().default('pending'), // pending | approved | rejected | completed | failed
  requestedby: integer('requestedby').notNull(),
  approvedby: integer('approvedby'),
  result: jsonb('result'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** File export của Privacy được lưu qua FilesModule. */
export const privacyExportFiles = pgTable('privacy_export_files', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  requestid: integer('requestid').notNull().references(() => privacyRequests.id, { onDelete: 'cascade' }),
  fileid: integer('fileid'),
  subsystem: text('subsystem').notNull().default(''),
  manifest: jsonb('manifest'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});
