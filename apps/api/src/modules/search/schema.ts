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

/** Tài liệu tìm kiếm (Search): một hàng cho mỗi (area, item) — chứa contextid để re-check quyền tại thời điểm truy vấn. */
export const searchDocuments = pgTable('search_documents', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  area: text('area').notNull(),
  itemid: uuid('itemid').notNull(),
  contextid: uuid('contextid').notNull(),
  title: text('title').notNull().default(''),
  content: text('content').notNull().default(''),
  ownerid: uuid('ownerid'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
      index('search_documents_itemid_idx').on(t.itemid),
      index('search_documents_contextid_idx').on(t.contextid),
      index('search_documents_ownerid_idx').on(t.ownerid),unique('search_documents_area_item_unique').on(t.area, t.itemid)]);
