/** Các bảng của bounded context Search — định nghĩa Drizzle do module search sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Tài liệu tìm kiếm (Search): một hàng cho mỗi (area, item) — chứa contextid để re-check quyền tại thời điểm truy vấn. */
export const searchDocuments = pgTable('search_documents', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  area: text('area').notNull(),
  itemid: integer('itemid').notNull(),
  contextid: integer('contextid').notNull(),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  ownerid: integer('ownerid'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [unique('search_documents_area_item_unique').on(t.area, t.itemid)]);
