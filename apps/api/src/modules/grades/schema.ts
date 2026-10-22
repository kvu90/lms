/** Các bảng của bounded context Grades — định nghĩa Drizzle do module grades sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { course } from '../courses/schema';

/** Scales (Moodle `scale`): courseid 0 = site scale. `scale` is a comma-separated list of values, lowest first. */
export const scales = pgTable('scales', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().default(0),
  name: text('name').notNull(),
  scale: text('scale').notNull().default(''),
  description: text('description').notNull().default(''),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Grade categories form a tree per course (Moodle `grade_categories`).
 * aggregation: natural|mean|weightedmean|simpleweightedmean|median|lowest|highest|mode|sum.
 * The category's own total is a grade_items row with itemtype='category'
 * (course total: itemtype='course'), exactly like Moodle.
 */
export const gradeCategories = pgTable('grade_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
  parent: integer('parent'),
  fullname: text('fullname').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  droplow: integer('droplow').notNull().default(0),
  keephigh: integer('keephigh').notNull().default(0),
  aggregateonlygraded: boolean('aggregateonlygraded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
  path: text('path').notNull().default(''),
  hidden: boolean('hidden').notNull().default(false),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Grade items (Moodle `grade_items`). itemtype: course|category|manual|mod.
 * For 'mod', iteminstance = course_modules id and itemmodule = component.
 * For 'category', iteminstance = grade_categories id. For 'course', iteminstance = course id.
 * aggregationcoef is the item's weight inside its parent category (used by
 * weightedmean always, and by natural when weightoverride is set).
 */
export const gradeItems = pgTable(
  'grade_items',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    categoryid: integer('categoryid').references(() => gradeCategories.id, { onDelete: 'cascade' }),
    itemname: text('itemname').notNull().default(''),
    itemtype: text('itemtype').notNull().default('manual'),
    itemmodule: text('itemmodule'),
    iteminstance: integer('iteminstance').notNull().default(0),
    gradetype: text('gradetype').notNull().default('value'),
    grademax: doublePrecision('grademax').notNull().default(100),
    grademin: doublePrecision('grademin').notNull().default(0),
    gradepass: doublePrecision('gradepass').notNull().default(0),
    scaleid: integer('scaleid').references(() => scales.id, { onDelete: 'set null' }),
    weightoverride: boolean('weightoverride').notNull().default(false),
    aggregationcoef: doublePrecision('aggregationcoef').notNull().default(0),
    extracredit: boolean('extracredit').notNull().default(false),
    multiplicator: doublePrecision('multiplicator').notNull().default(1),
    plusfactor: doublePrecision('plusfactor').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    sortorder: integer('sortorder').notNull().default(0),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('grade_items_course_type_instance_unique').on(table.courseid, table.itemtype, table.iteminstance, table.itemmodule)],
);

/**
 * Per-user grades (Moodle `grade_grades`). rawgrade is what was entered;
 * finalgrade is what counts (after multiplicator/offset + aggregation for
 * category/course items). `frozen` is explicit data (report §2#7): once a
 * grade was produced with a multiplicator/offset (a penalty-style formula),
 * its finalgrade is frozen and regrades reuse it verbatim until unfrozen.
 */
export const gradeGrades = pgTable(
  'grade_grades',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    itemid: integer('itemid').notNull().references(() => gradeItems.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    rawgrade: doublePrecision('rawgrade'),
    rawgrademax: doublePrecision('rawgrademax').notNull().default(100),
    rawgrademin: doublePrecision('rawgrademin').notNull().default(0),
    finalgrade: doublePrecision('finalgrade'),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    locktime: timestamp('locktime', { withTimezone: true }),
    overridden: boolean('overridden').notNull().default(false),
    excluded: boolean('excluded').notNull().default(false),
    frozen: boolean('frozen').notNull().default(false),
    feedback: text('feedback'),
    information: text('information'),
    aggregationstatus: text('aggregationstatus').notNull().default('unknown'),
    aggregationweight: doublePrecision('aggregationweight'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('grade_grades_item_user_unique').on(table.itemid, table.userid)],
);

/** Grade change history (Moodle `grade_grades_history`). action: 1=insert, 2=update, 3=delete. */
export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  action: integer('action').notNull().default(2),
  oldid: integer('oldid'),
  itemid: integer('itemid').notNull(),
  userid: integer('userid').notNull(),
  rawgrade: doublePrecision('rawgrade'),
  finalgrade: doublePrecision('finalgrade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  loggeduser: integer('loggeduser'),
});

/** Grade letters per context (Moodle `grade_letters`): letter applies when percentage >= lowerboundary. */
export const gradeLetters = pgTable(
  'grade_letters',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    contextid: integer('contextid').notNull(),
    lowerboundary: doublePrecision('lowerboundary').notNull(),
    letter: text('letter').notNull(),
  },
  (table) => [unique('grade_letters_context_boundary_unique').on(table.contextid, table.lowerboundary)],
);
