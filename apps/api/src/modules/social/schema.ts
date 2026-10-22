/** Các bảng của bounded context Social (Tags, Comments, Ratings, Blog, Notes) — định nghĩa Drizzle do module social sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Tag collections (Moodle `tag_coll`): areas belong to a collection; the default collection is seeded. */
export const tagCollection = pgTable('tag_collection', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  isstandard: boolean('isstandard').notNull().default(false),
  component: text('component'),
  searchable: boolean('searchable').notNull().default(true),
  customurl: text('customurl'),
});

/** Tags (Moodle `tag`). name is the normalised (lowercase) form; rawname keeps the display form. */
export const tag = pgTable(
  'tag',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull().default(0),
    tagcollid: integer('tagcollid').notNull().default(1),
    name: text('name').notNull(),
    rawname: text('rawname').notNull(),
    isstandard: boolean('isstandard').notNull().default(false),
    flag: integer('flag').notNull().default(0),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tag_coll_name_unique').on(table.tagcollid, table.name)],
);

/** Tag instances (Moodle `tag_instance`): the polymorphic link — no FK to the tagged item, by design. */
export const tagInstance = pgTable(
  'tag_instance',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    tagid: integer('tagid').notNull().references(() => tag.id, { onDelete: 'cascade' }),
    component: text('component').notNull(),
    itemtype: text('itemtype').notNull(),
    itemid: integer('itemid').notNull(),
    contextid: integer('contextid').notNull(),
    tiuserid: integer('tiuserid').notNull().default(0),
    ordering: integer('ordering').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tag_instance_unique').on(table.tagid, table.component, table.itemtype, table.itemid, table.contextid, table.tiuserid)],
);

/** Correlated tags (Moodle `tag_correlation`): tags that co-occur on the same items, as a comma list of tag ids. */
export const tagCorrelation = pgTable('tag_correlation', {
  tagid: integer('tagid').primaryKey().references(() => tag.id, { onDelete: 'cascade' }),
  correlatedtags: text('correlatedtags').notNull().default(''),
});

/** Comments (Moodle `comments`): polymorphic by (component, commentarea, itemid, contextid). */
export const comments = pgTable('comments', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  contextid: integer('contextid').notNull(),
  component: text('component').notNull(),
  commentarea: text('commentarea').notNull(),
  itemid: integer('itemid').notNull(),
  content: text('content').notNull(),
  format: integer('format').notNull().default(1),
  userid: integer('userid').notNull(),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timedeleted: timestamp('timedeleted', { withTimezone: true }),
});

/** Ratings (Moodle `rating`): polymorphic; aggregation (average/count/sum) is computed over THIS item only. */
export const rating = pgTable(
  'rating',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    contextid: integer('contextid').notNull(),
    component: text('component').notNull(),
    ratingarea: text('ratingarea').notNull(),
    itemid: integer('itemid').notNull(),
    scaleid: integer('scaleid').notNull(),
    rating: integer('rating').notNull(),
    userid: integer('userid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('rating_unique').on(table.contextid, table.component, table.ratingarea, table.itemid, table.userid)],
);

/** Blog posts (Moodle `post` → `blog_posts`). publishstate: 'draft' (author only) | 'site' (public). The owning context is the author's user context. */
export const blogPosts = pgTable('blog_posts', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  userid: integer('userid').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  publishstate: text('publishstate').notNull().default('draft'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastmodified: timestamp('lastmodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Blog associations (Moodle `blog_association`): a post linked to a course or a course module. */
export const blogAssociation = pgTable(
  'blog_association',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    blogid: integer('blogid').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
    contextid: integer('contextid').notNull(),
    assoctype: text('assoctype').notNull(), // course | coursemodule
    associd: integer('associd').notNull(),
  },
  (table) => [unique('blog_association_unique').on(table.blogid, table.assoctype, table.associd)],
);

/**
 * Notes about a user (Moodle `note` → `notes`). publishstate decides who can
 * read: 'draft' = personal (creator only), 'public' = course note (readers
 * need moodle/notes:view at the COURSE context — in practice the course's
 * teachers), 'site' = site note (moodle/notes:view at system).
 */
export const notes = pgTable('notes', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().default(0),
  userid: integer('userid').notNull(),
  createdby: integer('createdby').notNull(),
  content: text('content').notNull().default(''),
  format: integer('format').notNull().default(1),
  publishstate: text('publishstate').notNull().default('draft'),
  groupid: integer('groupid').notNull().default(0),
  usermodified: integer('usermodified'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastmodified: timestamp('lastmodified', { withTimezone: true }).notNull().defaultNow(),
});
