/** Các bảng của bounded context Courses — định nghĩa Drizzle do module courses sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/** Course categories form a tree (Moodle `course_categories`): path/depth like contexts. parent=0 means top level. */
export const courseCategories = pgTable('course_categories', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  idNumber: text('id_number'),
  description: text('description').notNull().default(''),
  parent: uuid('parent'),
  sortOrder: integer('sort_order').notNull().default(0),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  visible: boolean('visible').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_categories_parent_idx').on(table.parent),
  ]);


/** Courses (Moodle `course`). group_mode: 0=NOGROUPS, 1=SEPARATEGROUPS, 2=VISIBLEGROUPS; group_mode_force=true ép chế độ nhóm của khoá lên mọi activity (bỏ qua group_mode riêng của course module). */
export const course = pgTable('course', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull().references(() => courseCategories.id, { onDelete: 'cascade' }),
  fullName: text('full_name').notNull(),
  shortName: text('short_name').notNull().unique(),
  idNumber: text('id_number').notNull().default(''),
  summary: text('summary').notNull().default(''),
  format: text('format').notNull().default('topics'),
  visible: boolean('visible').notNull().default(true),
  startDate: timestamp('start_date', { withTimezone: true }),
  endDate: timestamp('end_date', { withTimezone: true }),
  groupMode: integer('group_mode').notNull().default(0),
  groupModeForce: boolean('group_mode_force').notNull().default(false),
  enableCompletion: boolean('enable_completion').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_category_idx').on(table.category),
  ]);


/** Course sections (Moodle `course_sections`). `availability` is the AvailabilityTree JSON (report §2#10). */
export const courseSections = pgTable(
  'course_sections',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
    section: integer('section').notNull().default(0),
    name: text('name'),
    summary: text('summary').notNull().default(''),
    visible: boolean('visible').notNull().default(true),
    availability: jsonb('availability'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_sections_course_section_unique').on(table.course, table.section)],
);

/**
 * Course modules (Moodle `course_modules`) — the generic container joining a
 * section to an activity instance via (component, instance_id). This ships the
 * container only; activity content lives in its owning modules.
 * completion: 0=none, 1=manual, 2=automatic. group_mode 0 inherits course mode.
 */
export const courseModules = pgTable('course_modules', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  section: uuid('section').notNull().references(() => courseSections.id, { onDelete: 'cascade' }),
  component: text('component').notNull(),
  instanceId: uuid('instance_id'),
  name: text('name').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  groupMode: integer('group_mode').notNull().default(0),
  availability: jsonb('availability'),
  completion: integer('completion').notNull().default(0),
  completionView: boolean('completion_view').notNull().default(false),
  completionUseGrade: boolean('completion_use_grade').notNull().default(false),
  completionManual: boolean('completion_manual').notNull().default(false),
  completionExpected: timestamp('completion_expected', { withTimezone: true }),
  deletionInProgress: boolean('deletion_in_progress').notNull().default(false),
  added: timestamp('added', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_modules_course_idx').on(table.course),
      index('course_modules_instance_id_idx').on(table.instanceId),
      index('course_modules_section_idx').on(table.section),
  ]);


/** Per-course format options (Moodle `course_format_options`). */
export const courseFormatOptions = pgTable(
  'course_format_options',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    sectionId: uuid('section_id'),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [
      index('course_format_options_section_id_idx').on(table.sectionId),unique('course_format_options_unique').on(table.courseId, table.format, table.sectionId, table.name)],
);
