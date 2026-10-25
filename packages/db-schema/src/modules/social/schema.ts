/** Các bảng của bounded context Social (Tags, Comments, Ratings, Blog, Notes) — định nghĩa Drizzle do module social sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
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

/** Tag collections (Moodle `tag_coll`): areas belong to a collection; the default collection is seeded. */
export const tagCollection = pgTable('tag_collection', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  isStandard: boolean('is_standard').notNull().default(false),
  component: text('component'),
  searchable: boolean('searchable').notNull().default(true),
  customUrl: text('custom_url'),
});

/** Tags (Moodle `tag`). name is the normalised (lowercase) form; raw_name keeps the display form. */
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

/** Tag instances (Moodle `tag_instance`): the polymorphic link — no FK to the tagged item, by design. */
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

/** Correlated tags (Moodle `tag_correlation`): tags that co-occur on the same items, as a comma list of tag ids. */
export const tagCorrelation = pgTable('tag_correlation', {
  tagId: uuid('tag_id').primaryKey().references(() => tag.id, { onDelete: 'cascade' }),
  correlatedTags: text('correlated_tags').notNull().default(''),
});

/** Comments (Moodle `comments`): polymorphic by (component, comment_area, item_id, context_id). */
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


/** Ratings (Moodle `rating`): polymorphic; aggregation (average/count/sum) is computed over THIS item only. */
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
 * Blog posts (Moodle `post` → `blog_posts`) — mô hình BL1 (issue #87):
 * mỗi bài có đúng MỘT không gian chính (`space_type`/`space_id`:
 * 'course' | 'school' | 'user'), một loại bài (`kind`:
 * 'article' | 'resource' | 'question') và vòng đời tách bạch:
 * `status` (draft | pending_review | published | hidden | archived |
 * deleted) tách khỏi `audience` (private | course | school — suy ra từ
 * space, xem blog-state.ts), kèm `moderation_state`, `comments_policy`,
 * `question_state` (chỉ kind='question'), các mốc xuất bản và xoá mềm.
 * `publish_state` là cột DEPRECATED của mô hình cũ (draft|site): giữ lại
 * chỉ làm dấu vết nguồn cho backfill di trú (blog-migration.ts), không
 * còn là nguồn sự thật — mọi đường đọc/ghi mới dùng `status`/`audience`.
 * Mọi default đều fail-closed (bài chưa di trú ở trạng thái thu hẹp nhất).
 */
export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  /** @deprecated Mô hình cũ hai mức; nguồn di trú cho backfill BL1. */
  publishState: text('publish_state').notNull().default('draft'),
  spaceType: text('space_type').notNull().default('user'),
  spaceId: uuid('space_id'),
  kind: text('kind').notNull().default('article'),
  status: text('status').notNull().default('draft'),
  audience: text('audience').notNull().default('private'),
  moderationState: text('moderation_state').notNull().default('clear'),
  commentsPolicy: text('comments_policy').notNull().default('open'),
  questionState: text('question_state'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  pinnedUntil: timestamp('pinned_until', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
  deleteReason: text('delete_reason'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastModified: timestamp('last_modified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('blog_posts_user_id_idx').on(table.userId),
      index('blog_posts_space_idx').on(table.spaceType, table.spaceId),
      index('blog_posts_status_published_idx').on(table.status, table.publishedAt),
  ]);

/**
 * Blog post placements (BL1): nơi một bài được hiển thị THÊM ngoài
 * không gian chính, sau duyệt. Placement KHÔNG mở rộng audience gốc của
 * bài ở BL1 (feed chỉ đọc theo không gian chính); cơ chế đề xuất/duyệt
 * đầy đủ thuộc BL4. Di trú ghi placement cho các khoá liên kết phụ của
 * bài cũ để không mất dấu vết liên kết.
 */
export const blogPostPlacements = pgTable(
  'blog_post_placements',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    postId: uuid('post_id').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
    spaceType: text('space_type').notNull(), // course | school | user
    spaceId: uuid('space_id'),
    contextId: uuid('context_id').notNull(),
    status: text('status').notNull().default('approved'), // pending | approved | rejected
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (table) => [
      index('blog_post_placements_post_id_idx').on(table.postId),
      index('blog_post_placements_space_idx').on(table.spaceType, table.spaceId),unique('blog_post_placements_unique').on(table.postId, table.spaceType, table.spaceId)],
);

/**
 * Blog post references (BL1 — khung; hành vi đầy đủ ở BL3): tham chiếu
 * có kiểu từ bài tới câu hỏi đã ghim phiên bản, quiz, khoá, module,
 * mục Kho học liệu, file hoặc URL ngoài. Quyền tại đích được kiểm lại
 * mỗi lần đọc (BL3); BL1 chỉ dựng bảng + khung ghi/đọc ở repository.
 */
export const blogPostReferences = pgTable(
  'blog_post_references',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    postId: uuid('post_id').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
    refType: text('ref_type').notNull(), // question_version | quiz | course | course_module | content_bank | file | external_url
    refId: text('ref_id'), // id của đích (dạng text) hoặc URL khi ref_type='external_url'
    questionId: uuid('question_id'),
    questionVersionId: uuid('question_version_id'),
    displayMode: text('display_mode'), // prompt_only | prompt_with_choices | teacher_solution (BL3)
    caption: text('caption'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('blog_post_references_post_id_idx').on(table.postId)],
);


/** Blog associations (Moodle `blog_association`): a post linked to a course or a course module. */
export const blogAssociation = pgTable(
  'blog_association',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    blogId: uuid('blog_id').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
    contextId: uuid('context_id').notNull(),
    assocType: text('assoc_type').notNull(), // course | coursemodule
    assocId: uuid('assoc_id').notNull(),
  },
  (table) => [
      index('blog_association_context_id_idx').on(table.contextId),
      index('blog_association_assoc_id_idx').on(table.assocId),unique('blog_association_unique').on(table.blogId, table.assocType, table.assocId)],
);

/**
 * Notes about a user (Moodle `note` → `notes`). publish_state decides who can
 * read: 'draft' = personal (creator only), 'public' = course note (readers
 * need notes:view at the COURSE context — in practice the course's
 * teachers), 'site' = site note (notes:view at system).
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

