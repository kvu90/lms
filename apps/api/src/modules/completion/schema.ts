/** Các bảng của bounded context Completion — định nghĩa Drizzle do module completion sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { course, courseModules } from '../courses/schema';

/**
 * Per-activity completion state (Moodle `course_modules_completion`).
 * completionstate: 0=incomplete, 1=complete, 2=complete-pass, 3=complete-fail
 * (pass/fail arrive with grades; this writes 0/1 and `viewed`).
 */
export const courseModulesCompletion = pgTable(
  'course_modules_completion',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    coursemoduleid: integer('coursemoduleid').notNull().references(() => courseModules.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    completionstate: integer('completionstate').notNull().default(0),
    viewed: boolean('viewed').notNull().default(false),
    overrideby: integer('overrideby'),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_modules_completion_unique').on(table.coursemoduleid, table.userid)],
);

/** Course-level completion criteria (Moodle `course_completion_criteria`). criteriatype: 'module' | 'date' | 'grade' (grade wired through the grades module). */
export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  criteriatype: text('criteriatype').notNull(),
  moduleinstance: integer('moduleinstance'),
  date: timestamp('date', { withTimezone: true }),
  sortorder: integer('sortorder').notNull().default(0),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-course completion aggregation setting: method 1 = ALL (AND), 2 = ANY (OR). */
export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: integer('course').primaryKey().references(() => course.id, { onDelete: 'cascade' }),
  method: integer('method').notNull().default(1),
});

/** Course completion state per user (Moodle `course_completions`). status: 'not_started' | 'in_progress' | 'complete'. */
export const courseCompletions = pgTable(
  'course_completions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull(),
    course: integer('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('not_started'),
    timeenrolled: timestamp('timeenrolled', { withTimezone: true }).notNull().defaultNow(),
    timestarted: timestamp('timestarted', { withTimezone: true }),
    timecompleted: timestamp('timecompleted', { withTimezone: true }),
    reaggregate: timestamp('reaggregate', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_completions_unique').on(table.userid, table.course)],
);
