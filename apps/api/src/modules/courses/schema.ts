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
  idnumber: text('idnumber'),
  description: text('description').notNull().default(''),
  parent: uuid('parent'),
  sortorder: integer('sortorder').notNull().default(0),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  visible: boolean('visible').notNull().default(true),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_categories_parent_idx').on(table.parent),
  ]);


/** Courses (Moodle `course`). groupmode: 0=NOGROUPS, 1=SEPARATEGROUPS, 2=VISIBLEGROUPS; groupmodeforce=true ép chế độ nhóm của khoá lên mọi activity (bỏ qua groupmode riêng của course module). */
export const course = pgTable('course', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  category: uuid('category').notNull().references(() => courseCategories.id, { onDelete: 'cascade' }),
  fullname: text('fullname').notNull(),
  shortname: text('shortname').notNull().unique(),
  idnumber: text('idnumber').notNull().default(''),
  summary: text('summary').notNull().default(''),
  format: text('format').notNull().default('topics'),
  visible: boolean('visible').notNull().default(true),
  startdate: timestamp('startdate', { withTimezone: true }),
  enddate: timestamp('enddate', { withTimezone: true }),
  groupmode: integer('groupmode').notNull().default(0),
  groupmodeforce: boolean('groupmodeforce').notNull().default(false),
  enablecompletion: boolean('enablecompletion').notNull().default(true),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
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
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_sections_course_section_unique').on(table.course, table.section)],
);

/**
 * Course modules (Moodle `course_modules`) — the generic container joining a
 * section to an activity instance via (component, instanceid). This ships the
 * container only; activity content lives in its owning modules.
 * completion: 0=none, 1=manual, 2=automatic. groupmode 0 inherits course mode.
 */
export const courseModules = pgTable('course_modules', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  section: uuid('section').notNull().references(() => courseSections.id, { onDelete: 'cascade' }),
  component: text('component').notNull(),
  instanceid: uuid('instanceid'),
  name: text('name').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  groupmode: integer('groupmode').notNull().default(0),
  availability: jsonb('availability'),
  completion: integer('completion').notNull().default(0),
  completionview: boolean('completionview').notNull().default(false),
  completionusegrade: boolean('completionusegrade').notNull().default(false),
  completionmanual: boolean('completionmanual').notNull().default(false),
  completionexpected: timestamp('completionexpected', { withTimezone: true }),
  deletioninprogress: boolean('deletioninprogress').notNull().default(false),
  added: timestamp('added', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_modules_course_idx').on(table.course),
      index('course_modules_instanceid_idx').on(table.instanceid),
      index('course_modules_section_idx').on(table.section),
  ]);


/** Per-course format options (Moodle `course_format_options`). */
export const courseFormatOptions = pgTable(
  'course_format_options',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseid: uuid('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    sectionid: uuid('sectionid'),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [
      index('course_format_options_sectionid_idx').on(table.sectionid),unique('course_format_options_unique').on(table.courseid, table.format, table.sectionid, table.name)],
);
