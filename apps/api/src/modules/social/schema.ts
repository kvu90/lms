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

/** Blog posts (Moodle `post` → `blog_posts`). publish_state: 'draft' (author only) | 'site' (public). The owning context is the author's user context. */
export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  publishState: text('publish_state').notNull().default('draft'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastModified: timestamp('last_modified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('blog_posts_user_id_idx').on(table.userId),
  ]);


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
 * need moodle/notes:view at the COURSE context — in practice the course's
 * teachers), 'site' = site note (moodle/notes:view at system).
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

