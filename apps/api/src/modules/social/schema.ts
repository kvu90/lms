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
  isstandard: boolean('isstandard').notNull().default(false),
  component: text('component'),
  searchable: boolean('searchable').notNull().default(true),
  customurl: text('customurl'),
});

/** Tags (Moodle `tag`). name is the normalised (lowercase) form; rawname keeps the display form. */
export const tag = pgTable(
  'tag',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userid: uuid('userid'),
    tagcollid: uuid('tagcollid'),
    name: text('name').notNull(),
    rawname: text('rawname').notNull(),
    isstandard: boolean('isstandard').notNull().default(false),
    flag: integer('flag').notNull().default(0),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('tag_userid_idx').on(table.userid),unique('tag_coll_name_unique').on(table.tagcollid, table.name)],
);

/** Tag instances (Moodle `tag_instance`): the polymorphic link — no FK to the tagged item, by design. */
export const tagInstance = pgTable(
  'tag_instance',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    tagid: uuid('tagid').notNull().references(() => tag.id, { onDelete: 'cascade' }),
    component: text('component').notNull(),
    itemtype: text('itemtype').notNull(),
    itemid: uuid('itemid').notNull(),
    contextid: uuid('contextid').notNull(),
    tiuserid: uuid('tiuserid'),
    ordering: integer('ordering').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('tag_instance_itemid_idx').on(table.itemid),
      index('tag_instance_contextid_idx').on(table.contextid),
      index('tag_instance_tiuserid_idx').on(table.tiuserid),unique('tag_instance_unique').on(table.tagid, table.component, table.itemtype, table.itemid, table.contextid, table.tiuserid)],
);

/** Correlated tags (Moodle `tag_correlation`): tags that co-occur on the same items, as a comma list of tag ids. */
export const tagCorrelation = pgTable('tag_correlation', {
  tagid: uuid('tagid').primaryKey().references(() => tag.id, { onDelete: 'cascade' }),
  correlatedtags: text('correlatedtags').notNull().default(''),
});

/** Comments (Moodle `comments`): polymorphic by (component, commentarea, itemid, contextid). */
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  contextid: uuid('contextid').notNull(),
  component: text('component').notNull(),
  commentarea: text('commentarea').notNull(),
  itemid: uuid('itemid').notNull(),
  content: text('content').notNull(),
  format: integer('format').notNull().default(1),
  userid: uuid('userid').notNull(),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timedeleted: timestamp('timedeleted', { withTimezone: true }),
},
  (table) => [
      index('comments_contextid_idx').on(table.contextid),
      index('comments_itemid_idx').on(table.itemid),
      index('comments_userid_idx').on(table.userid),
  ]);


/** Ratings (Moodle `rating`): polymorphic; aggregation (average/count/sum) is computed over THIS item only. */
export const rating = pgTable(
  'rating',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextid: uuid('contextid').notNull(),
    component: text('component').notNull(),
    ratingarea: text('ratingarea').notNull(),
    itemid: uuid('itemid').notNull(),
    scaleid: integer('scaleid').notNull(),
    rating: integer('rating').notNull(),
    userid: uuid('userid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('rating_itemid_idx').on(table.itemid),
      index('rating_userid_idx').on(table.userid),unique('rating_unique').on(table.contextid, table.component, table.ratingarea, table.itemid, table.userid)],
);

/** Blog posts (Moodle `post` → `blog_posts`). publishstate: 'draft' (author only) | 'site' (public). The owning context is the author's user context. */
export const blogPosts = pgTable('blog_posts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userid: uuid('userid').notNull(),
  subject: text('subject').notNull().default(''),
  summary: text('summary').notNull().default(''),
  content: text('content').notNull().default(''),
  publishstate: text('publishstate').notNull().default('draft'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastmodified: timestamp('lastmodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('blog_posts_userid_idx').on(table.userid),
  ]);


/** Blog associations (Moodle `blog_association`): a post linked to a course or a course module. */
export const blogAssociation = pgTable(
  'blog_association',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    blogid: uuid('blogid').notNull().references(() => blogPosts.id, { onDelete: 'cascade' }),
    contextid: uuid('contextid').notNull(),
    assoctype: text('assoctype').notNull(), // course | coursemodule
    associd: uuid('associd').notNull(),
  },
  (table) => [
      index('blog_association_contextid_idx').on(table.contextid),
      index('blog_association_associd_idx').on(table.associd),unique('blog_association_unique').on(table.blogid, table.assoctype, table.associd)],
);

/**
 * Notes about a user (Moodle `note` → `notes`). publishstate decides who can
 * read: 'draft' = personal (creator only), 'public' = course note (readers
 * need moodle/notes:view at the COURSE context — in practice the course's
 * teachers), 'site' = site note (moodle/notes:view at system).
 */
export const notes = pgTable('notes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid'),
  userid: uuid('userid').notNull(),
  createdby: uuid('createdby').notNull(),
  content: text('content').notNull().default(''),
  format: integer('format').notNull().default(1),
  publishstate: text('publishstate').notNull().default('draft'),
  groupid: uuid('groupid'),
  usermodified: uuid('usermodified'),
  created: timestamp('created', { withTimezone: true }).notNull().defaultNow(),
  lastmodified: timestamp('lastmodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('notes_courseid_idx').on(table.courseid),
      index('notes_userid_idx').on(table.userid),
      index('notes_createdby_idx').on(table.createdby),
      index('notes_groupid_idx').on(table.groupid),
  ]);

