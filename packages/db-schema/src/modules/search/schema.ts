/** Các bảng của bounded context Search — định nghĩa Drizzle do module search sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Tài liệu tìm kiếm (Search): một hàng cho mỗi (area, item) — chứa context_id để re-check quyền tại thời điểm truy vấn. */
export const searchDocuments = pgTable('search_documents', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  area: text('area').notNull(),
  itemId: uuid('item_id').notNull(),
  contextId: uuid('context_id').notNull(),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  ownerId: uuid('owner_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('search_documents_item_id_idx').on(t.itemId),
      index('search_documents_context_id_idx').on(t.contextId),
      index('search_documents_owner_id_idx').on(t.ownerId),unique('search_documents_area_item_unique').on(t.area, t.itemId)]);
