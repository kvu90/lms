/** Các bảng của bounded context Grades — định nghĩa Drizzle do module grades sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course } from '../courses/schema';

/**
 * Grade outcomes (Moodle `grade_outcomes`): thang định tính ở mức site (courseid = null)
 * hoặc mức khoá học, luôn gắn với một scale; grade item gắn outcome thì điểm của nó là
 * chỉ số (1-based) trong scale của outcome và không tham gia tổng hợp số của category.
 */
export const gradeOutcomes = pgTable('grade_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid').references(() => course.id, { onDelete: 'cascade' }),
  scaleid: uuid('scaleid').notNull().references(() => scales.id, { onDelete: 'restrict' }),
  name: text('name').notNull().default(''),
  description: text('description').notNull().default(''),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_outcomes_courseid_idx').on(table.courseid),
      index('grade_outcomes_scaleid_idx').on(table.scaleid),
  ]);


/** Scales (Moodle `scale`): courseid 0 = site scale. `scale` is a comma-separated list of values, lowest first. */
export const scales = pgTable('scales', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid'),
  name: text('name').notNull(),
  scale: text('scale').notNull().default(''),
  description: text('description').notNull().default(''),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('scales_courseid_idx').on(table.courseid),
  ]);


/**
 * Grade categories form a tree per course (Moodle `grade_categories`).
 * aggregation: natural|mean|weightedmean|simpleweightedmean|median|lowest|highest|mode|sum.
 * The category's own total is a grade_items row with itemtype='category'
 * (course total: itemtype='course'), exactly like Moodle.
 */
export const gradeCategories = pgTable('grade_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
  parent: uuid('parent'),
  fullname: text('fullname').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  droplow: integer('droplow').notNull().default(0),
  keephigh: integer('keephigh').notNull().default(0),
  aggregateonlygraded: boolean('aggregateonlygraded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
  path: text('path').notNull().default(''),
  hidden: boolean('hidden').notNull().default(false),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_categories_courseid_idx').on(table.courseid),
      index('grade_categories_parent_idx').on(table.parent),
  ]);


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
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseid: uuid('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    categoryid: uuid('categoryid').references(() => gradeCategories.id, { onDelete: 'cascade' }),
    itemname: text('itemname').notNull().default(''),
    itemtype: text('itemtype').notNull().default('manual'),
    itemmodule: text('itemmodule'),
    iteminstance: uuid('iteminstance'),
    gradetype: text('gradetype').notNull().default('value'),
    grademax: doublePrecision('grademax').notNull().default(100),
    grademin: doublePrecision('grademin').notNull().default(0),
    gradepass: doublePrecision('gradepass').notNull().default(0),
    scaleid: uuid('scaleid').references(() => scales.id, { onDelete: 'set null' }),
    /** Outcome gắn với item (Moodle grade_items.outcomeid); item có outcome thì gradetype='scale' và scaleid là scale của outcome. */
    outcomeid: uuid('outcomeid').references(() => gradeOutcomes.id, { onDelete: 'set null' }),
    /** Định danh dùng trong công thức tính (Moodle grade_items.idnumber); duy nhất trong một khoá học khi không null. */
    idnumber: text('idnumber'),
    /** Công thức của item loại 'calculated' (Moodle grade_items.calculation), dạng `=sum([[a]],[[b]])`. */
    calculation: text('calculation'),
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
  (table) => [
      index('grade_items_categoryid_idx').on(table.categoryid),
      index('grade_items_iteminstance_idx').on(table.iteminstance),
      index('grade_items_scaleid_idx').on(table.scaleid),index('grade_items_outcomeid_idx').on(table.outcomeid),unique('grade_items_course_idnumber_unique').on(table.courseid, table.idnumber),unique('grade_items_course_type_instance_unique').on(table.courseid, table.itemtype, table.iteminstance, table.itemmodule)],
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
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    itemid: uuid('itemid').notNull().references(() => gradeItems.id, { onDelete: 'cascade' }),
    userid: uuid('userid').notNull(),
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
  (table) => [
      index('grade_grades_userid_idx').on(table.userid),unique('grade_grades_item_user_unique').on(table.itemid, table.userid)],
);

/** Grade change history (Moodle `grade_grades_history`). action: 1=insert, 2=update, 3=delete. */
export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  action: integer('action').notNull().default(2),
  oldid: uuid('oldid'),
  itemid: uuid('itemid').notNull(),
  userid: uuid('userid').notNull(),
  rawgrade: doublePrecision('rawgrade'),
  finalgrade: doublePrecision('finalgrade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  loggeduser: uuid('loggeduser'),
},
  (table) => [
      index('grade_grades_history_oldid_idx').on(table.oldid),
      index('grade_grades_history_itemid_idx').on(table.itemid),
      index('grade_grades_history_userid_idx').on(table.userid),
      index('grade_grades_history_loggeduser_idx').on(table.loggeduser),
  ]);


/** Grade letters per context (Moodle `grade_letters`): letter applies when percentage >= lowerboundary. */
export const gradeLetters = pgTable(
  'grade_letters',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextid: uuid('contextid').notNull(),
    lowerboundary: doublePrecision('lowerboundary').notNull(),
    letter: text('letter').notNull(),
  },
  (table) => [unique('grade_letters_context_boundary_unique').on(table.contextid, table.lowerboundary)],
);
