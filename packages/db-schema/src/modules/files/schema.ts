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

/** Logical file records (Moodle `files`). Physical bytes live once per content_hash (SHA-256) in content-addressed storage. */
export const files = pgTable('files', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contentHash: text('content_hash').notNull(),
  contextId: uuid('context_id').notNull(),
  component: text('component').notNull(),
  fileArea: text('file_area').notNull(),
  itemId: uuid('item_id'),
  filePath: text('file_path').notNull().default('/'),
  fileName: text('file_name').notNull(),
  userId: uuid('user_id'),
  fileSize: integer('file_size').notNull(),
  mimeType: text('mime_type'),
  status: integer('status').notNull().default(0),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('files_context_id_idx').on(table.contextId),
      index('files_item_id_idx').on(table.itemId),
      index('files_user_id_idx').on(table.userId),
  ]);

