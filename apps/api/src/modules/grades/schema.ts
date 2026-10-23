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
 * Grade outcomes (Moodle `grade_outcomes`): thang định tính ở mức site (course_id = null)
 * hoặc mức khoá học, luôn gắn với một scale; grade item gắn outcome thì điểm của nó là
 * chỉ số (1-based) trong scale của outcome và không tham gia tổng hợp số của category.
 */
export const gradeOutcomes = pgTable('grade_outcomes', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').references(() => course.id, { onDelete: 'cascade' }),
  scaleId: uuid('scale_id').notNull().references(() => scales.id, { onDelete: 'restrict' }),
  name: text('name').notNull().default(''),
  description: text('description').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_outcomes_course_id_idx').on(table.courseId),
      index('grade_outcomes_scale_id_idx').on(table.scaleId),
  ]);


/** Scales (Moodle `scale`): course_id 0 = site scale. `scale` is a comma-separated list of values, lowest first. */
export const scales = pgTable('scales', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id'),
  name: text('name').notNull(),
  scale: text('scale').notNull().default(''),
  description: text('description').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('scales_course_id_idx').on(table.courseId),
  ]);


/**
 * Grade categories form a tree per course (Moodle `grade_categories`).
 * aggregation: natural|mean|weightedmean|simpleweightedmean|median|lowest|highest|mode|sum.
 * The category's own total is a grade_items row with item_type='category'
 * (course total: item_type='course'), exactly like Moodle.
 */
export const gradeCategories = pgTable('grade_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
  parent: uuid('parent'),
  fullName: text('full_name').notNull().default(''),
  aggregation: text('aggregation').notNull().default('natural'),
  dropLow: integer('drop_low').notNull().default(0),
  keepHigh: integer('keep_high').notNull().default(0),
  aggregateOnlyGraded: boolean('aggregate_only_graded').notNull().default(false),
  depth: integer('depth').notNull().default(1),
  path: text('path').notNull().default(''),
  hidden: boolean('hidden').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('grade_categories_course_id_idx').on(table.courseId),
      index('grade_categories_parent_idx').on(table.parent),
  ]);


/**
 * Grade items (Moodle `grade_items`). item_type: course|category|manual|mod.
 * For 'mod', item_instance = course_modules id and item_module = component.
 * For 'category', item_instance = grade_categories id. For 'course', item_instance = course id.
 * aggregation_coef is the item's weight inside its parent category (used by
 * weightedmean always, and by natural when weight_override is set).
 */
export const gradeItems = pgTable(
  'grade_items',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => gradeCategories.id, { onDelete: 'cascade' }),
    itemName: text('item_name').notNull().default(''),
    itemType: text('item_type').notNull().default('manual'),
    itemModule: text('item_module'),
    itemInstance: uuid('item_instance'),
    gradeType: text('grade_type').notNull().default('value'),
    gradeMax: doublePrecision('grade_max').notNull().default(100),
    gradeMin: doublePrecision('grade_min').notNull().default(0),
    gradePass: doublePrecision('grade_pass').notNull().default(0),
    scaleId: uuid('scale_id').references(() => scales.id, { onDelete: 'set null' }),
    /** Outcome gắn với item (Moodle grade_items.outcomeid); item có outcome thì grade_type='scale' và scale_id là scale của outcome. */
    outcomeId: uuid('outcome_id').references(() => gradeOutcomes.id, { onDelete: 'set null' }),
    /** Định danh dùng trong công thức tính (Moodle grade_items.idnumber); duy nhất trong một khoá học khi không null. */
    idNumber: text('id_number'),
    /** Công thức của item loại 'calculated' (Moodle grade_items.calculation), dạng `=sum([[a]],[[b]])`. */
    calculation: text('calculation'),
    weightOverride: boolean('weight_override').notNull().default(false),
    aggregationCoef: doublePrecision('aggregation_coef').notNull().default(0),
    extraCredit: boolean('extra_credit').notNull().default(false),
    multiplicator: doublePrecision('multiplicator').notNull().default(1),
    plusFactor: doublePrecision('plus_factor').notNull().default(0),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('grade_items_category_id_idx').on(table.categoryId),
      index('grade_items_item_instance_idx').on(table.itemInstance),
      index('grade_items_scale_id_idx').on(table.scaleId),index('grade_items_outcome_id_idx').on(table.outcomeId),unique('grade_items_course_id_number_unique').on(table.courseId, table.idNumber),unique('grade_items_course_type_instance_unique').on(table.courseId, table.itemType, table.itemInstance, table.itemModule)],
);

/**
 * Per-user grades (Moodle `grade_grades`). raw_grade is what was entered;
 * final_grade is what counts (after multiplicator/offset + aggregation for
 * category/course items). `frozen` is explicit data (report §2#7): once a
 * grade was produced with a multiplicator/offset (a penalty-style formula),
 * its final_grade is frozen and regrades reuse it verbatim until unfrozen.
 */
export const gradeGrades = pgTable(
  'grade_grades',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    itemId: uuid('item_id').notNull().references(() => gradeItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    rawGrade: doublePrecision('raw_grade'),
    rawGradeMax: doublePrecision('raw_grade_max').notNull().default(100),
    rawGradeMin: doublePrecision('raw_grade_min').notNull().default(0),
    finalGrade: doublePrecision('final_grade'),
    hidden: boolean('hidden').notNull().default(false),
    locked: boolean('locked').notNull().default(false),
    lockTime: timestamp('lock_time', { withTimezone: true }),
    overridden: boolean('overridden').notNull().default(false),
    excluded: boolean('excluded').notNull().default(false),
    frozen: boolean('frozen').notNull().default(false),
    feedback: text('feedback'),
    information: text('information'),
    aggregationStatus: text('aggregation_status').notNull().default('unknown'),
    aggregationWeight: doublePrecision('aggregation_weight'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('grade_grades_user_id_idx').on(table.userId),unique('grade_grades_item_user_unique').on(table.itemId, table.userId)],
);

/** Grade change history (Moodle `grade_grades_history`). action: 1=insert, 2=update, 3=delete. */
export const gradeGradesHistory = pgTable('grade_grades_history', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  action: integer('action').notNull().default(2),
  oldId: uuid('old_id'),
  itemId: uuid('item_id').notNull(),
  userId: uuid('user_id').notNull(),
  rawGrade: doublePrecision('raw_grade'),
  finalGrade: doublePrecision('final_grade'),
  overridden: boolean('overridden').notNull().default(false),
  excluded: boolean('excluded').notNull().default(false),
  frozen: boolean('frozen').notNull().default(false),
  source: text('source'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  loggedUser: uuid('logged_user'),
},
  (table) => [
      index('grade_grades_history_old_id_idx').on(table.oldId),
      index('grade_grades_history_item_id_idx').on(table.itemId),
      index('grade_grades_history_user_id_idx').on(table.userId),
      index('grade_grades_history_logged_user_idx').on(table.loggedUser),
  ]);


/** Grade letters per context (Moodle `grade_letters`): letter applies when percentage >= lower_boundary. */
export const gradeLetters = pgTable(
  'grade_letters',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    contextId: uuid('context_id').notNull(),
    lowerBoundary: doublePrecision('lower_boundary').notNull(),
    letter: text('letter').notNull(),
  },
  (table) => [unique('grade_letters_context_boundary_unique').on(table.contextId, table.lowerBoundary)],
);
