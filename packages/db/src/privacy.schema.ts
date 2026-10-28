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
  userId: uuid('user_id').notNull(),
  type: text('type').notNull(), // export | delete
  status: text('status').notNull().default('pending'), // pending | approved | rejected | completed | failed
  requestedBy: uuid('requested_by').notNull(),
  approvedBy: uuid('approved_by'),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_requests_user_id_idx').on(table.userId),
      index('privacy_requests_requested_by_idx').on(table.requestedBy),
      index('privacy_requests_approved_by_idx').on(table.approvedBy),
  ]);


/** File export của Privacy được lưu qua FilesModule. */
export const privacyExportFiles = pgTable('privacy_export_files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  requestId: uuid('request_id').notNull().references(() => privacyRequests.id, { onDelete: 'cascade' }),
  fileId: uuid('file_id'),
  subsystem: text('subsystem').notNull().default(''),
  manifest: jsonb('manifest'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('privacy_export_files_request_id_idx').on(table.requestId),
      index('privacy_export_files_file_id_idx').on(table.fileId),
  ]);

