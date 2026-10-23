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
export const contentBankContent = pgTable('content_bank_content', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  contentType: text('content_type').notNull().default('file-based'),
  contextId: uuid('context_id').notNull(),
  creatorId: uuid('creator_id').notNull(),
  visibility: text('visibility').notNull().default('draft'), // draft | public
  fileId: uuid('file_id'),
  configData: jsonb('config_data'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('content_bank_content_context_id_idx').on(table.contextId),
      index('content_bank_content_creator_id_idx').on(table.creatorId),
      index('content_bank_content_file_id_idx').on(table.fileId),
  ]);

