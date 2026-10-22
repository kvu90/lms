/** Các bảng của bounded context Courses — định nghĩa Drizzle do module courses sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Course categories form a tree (Moodle `course_categories`): path/depth like contexts. parent=0 means top level. */
export const courseCategories = pgTable('course_categories', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  idnumber: text('idnumber'),
  description: text('description').notNull().default(''),
  parent: integer('parent').notNull().default(0),
  sortorder: integer('sortorder').notNull().default(0),
  path: text('path').notNull().default(''),
  depth: integer('depth').notNull().default(1),
  visible: boolean('visible').notNull().default(true),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Courses (Moodle `course`). groupmode: 0=NOGROUPS, 1=SEPARATEGROUPS, 2=VISIBLEGROUPS. */
export const course = pgTable('course', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  category: integer('category').notNull().references(() => courseCategories.id, { onDelete: 'cascade' }),
  fullname: text('fullname').notNull(),
  shortname: text('shortname').notNull().unique(),
  idnumber: text('idnumber').notNull().default(''),
  summary: text('summary').notNull().default(''),
  format: text('format').notNull().default('topics'),
  visible: boolean('visible').notNull().default(true),
  startdate: timestamp('startdate', { withTimezone: true }),
  enddate: timestamp('enddate', { withTimezone: true }),
  groupmode: integer('groupmode').notNull().default(0),
  enablecompletion: boolean('enablecompletion').notNull().default(true),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Course sections (Moodle `course_sections`). `availability` is the AvailabilityTree JSON (report §2#10). */
export const courseSections = pgTable(
  'course_sections',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
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
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  section: integer('section').notNull().references(() => courseSections.id, { onDelete: 'cascade' }),
  component: text('component').notNull(),
  instanceid: integer('instanceid').notNull().default(0),
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
});

/** Per-course format options (Moodle `course_format_options`). */
export const courseFormatOptions = pgTable(
  'course_format_options',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    sectionid: integer('sectionid').notNull().default(0),
    name: text('name').notNull(),
    value: text('value'),
  },
  (table) => [unique('course_format_options_unique').on(table.courseid, table.format, table.sectionid, table.name)],
);
