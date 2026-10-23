/** Các bảng của bounded context Completion — định nghĩa Drizzle do module completion sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
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
import { course, courseModules } from '../courses/schema';

/**
 * Per-activity completion state (Moodle `course_modules_completion`).
 * completion_state: 0=incomplete, 1=complete, 2=complete-pass, 3=complete-fail
 * (pass/fail arrive with grades; this writes 0/1 and `viewed`).
 */
export const courseModulesCompletion = pgTable(
  'course_modules_completion',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseModuleId: uuid('course_module_id').notNull().references(() => courseModules.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    completionState: integer('completion_state').notNull().default(0),
    viewed: boolean('viewed').notNull().default(false),
    overrideBy: uuid('override_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('course_modules_completion_user_id_idx').on(table.userId),unique('course_modules_completion_unique').on(table.courseModuleId, table.userId)],
);

/** Course-level completion criteria (Moodle `course_completion_criteria`). criteria_type: 'module' | 'date' | 'grade' (grade wired through the grades module). */
export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  criteriaType: text('criteria_type').notNull(),
  moduleInstance: uuid('module_instance'),
  date: timestamp('date', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_completion_criteria_course_idx').on(table.course),
      index('course_completion_criteria_module_instance_idx').on(table.moduleInstance),
  ]);


/** Per-course completion aggregation setting: method 1 = ALL (AND), 2 = ANY (OR). */
export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: uuid('course').primaryKey().references(() => course.id, { onDelete: 'cascade' }),
  method: integer('method').notNull().default(1),
});

/** Course completion state per user (Moodle `course_completions`). status: 'not_started' | 'in_progress' | 'complete'. */
export const courseCompletions = pgTable(
  'course_completions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id').notNull(),
    course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('not_started'),
    timeEnrolled: timestamp('time_enrolled', { withTimezone: true }).notNull().defaultNow(),
    timeStarted: timestamp('time_started', { withTimezone: true }),
    timeCompleted: timestamp('time_completed', { withTimezone: true }),
    reAggregate: timestamp('re_aggregate', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('course_completions_course_idx').on(table.course),unique('course_completions_unique').on(table.userId, table.course)],
);
