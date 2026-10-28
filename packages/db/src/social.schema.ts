/** Các bảng của bounded context Social (Tags, Comments, Ratings, Notes) — định nghĩa Drizzle do module social sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Bộ sưu tập thẻ (Moodle `tag_coll`): các area thuộc về một bộ sưu tập; bộ sưu tập mặc định được seed sẵn. */
export const tagCollection = pgTable('tag_collection', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  isStandard: boolean('is_standard').notNull().default(false),
  component: text('component'),
  searchable: boolean('searchable').notNull().default(true),
  customUrl: text('custom_url'),
});

/** Thẻ (Moodle `tag`). name là dạng đã chuẩn hoá (viết thường); raw_name giữ dạng hiển thị. */
export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id'),
    tagCollId: uuid('tag_coll_id'),
    name: text('name').notNull(),
    rawName: text('raw_name').notNull(),
    isStandard: boolean('is_standard').notNull().default(false),
    flag: integer('flag').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('tag_user_id_idx').on(table.userId),unique('tag_coll_name_unique').on(table.tagCollId, table.name)],
);

/** Instance của thẻ (Moodle `tag_instance`): liên kết đa hình — không có FK tới mục được gắn thẻ, theo thiết kế. */
export const tagInstance = pgTable(
  'tag_instance',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tagId: uuid('tag_id').notNull().references(() => tag.id, { onDelete: 'cascade' }),
    component: text('component').notNull(),
    itemType: text('item_type').notNull(),
    itemId: uuid('item_id').notNull(),
    contextId: uuid('context_id').notNull(),
    tiUserId: uuid('ti_user_id'),
    ordering: integer('ordering').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('tag_instance_item_id_idx').on(table.itemId),
      index('tag_instance_context_id_idx').on(table.contextId),
      index('tag_instance_ti_user_id_idx').on(table.tiUserId),unique('tag_instance_unique').on(table.tagId, table.component, table.itemType, table.itemId, table.contextId, table.tiUserId)],
);

/** Thẻ tương quan (Moodle `tag_correlation`): các thẻ cùng xuất hiện trên cùng các mục, dưới dạng danh sách id thẻ cách nhau bằng dấu phẩy. */
export const tagCorrelation = pgTable('tag_correlation', {
  tagId: uuid('tag_id').primaryKey().references(() => tag.id, { onDelete: 'cascade' }),
  correlatedTags: text('correlated_tags').notNull().default(''),
});

/** Bình luận (Moodle `comments`): đa hình theo (component, comment_area, item_id, context_id). */
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contextId: uuid('context_id').notNull(),
  component: text('component').notNull(),
  commentArea: text('comment_area').notNull(),
  itemId: uuid('item_id').notNull(),
  content: text('content').notNull(),
  format: integer('format').notNull().default(1),
  userId: uuid('user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  timeDeleted: timestamp('time_deleted', { withTimezone: true }),
},
  (table) => [
      index('comments_context_id_idx').on(table.contextId),
      index('comments_item_id_idx').on(table.itemId),
      index('comments_user_id_idx').on(table.userId),
  ]);


/** Đánh giá (Moodle `rating`): đa hình; phép tổng hợp (average/count/sum) chỉ được tính trên CHÍNH mục này. */
export const rating = pgTable(
  'rating',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextId: uuid('context_id').notNull(),
    component: text('component').notNull(),
    ratingArea: text('rating_area').notNull(),
    itemId: uuid('item_id').notNull(),
    scaleId: integer('scale_id').notNull(),
    rating: integer('rating').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('rating_item_id_idx').on(table.itemId),
      index('rating_user_id_idx').on(table.userId),unique('rating_unique').on(table.contextId, table.component, table.ratingArea, table.itemId, table.userId)],
);

/**
 * Ghi chú về một user (Moodle `note` → `notes`). publish_state quyết định ai có thể
 * đọc: 'draft' = cá nhân (chỉ người tạo), 'public' = ghi chú của khoá học (người đọc
 * cần notes:view tại context của KHOÁ HỌC — trong thực tế là giáo viên
 * của khoá học), 'site' = ghi chú của site (notes:view tại hệ thống).
 */
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id'),
  userId: uuid('user_id').notNull(),
  createdBy: uuid('created_by').notNull(),
  content: text('content').notNull().default(''),
  format: integer('format').notNull().default(1),
  publishState: text('publish_state').notNull().default('draft'),
  groupId: uuid('group_id'),
  userModified: uuid('user_modified'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastModified: timestamp('last_modified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('notes_course_id_idx').on(table.courseId),
      index('notes_user_id_idx').on(table.userId),
      index('notes_created_by_idx').on(table.createdBy),
      index('notes_group_id_idx').on(table.groupId),
  ]);

