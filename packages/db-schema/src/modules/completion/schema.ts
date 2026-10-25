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
import { role } from '../access/schema';
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

/**
 * Course-level completion criteria (Moodle `course_completion_criteria`).
 * criteria_type covers all 8 Moodle types: 'module' | 'date' | 'grade'
 * (grade wired through the grades module) | 'self' | 'course' | 'duration'
 * | 'role' | 'unenrol'. Per-type parameters live on the row, like Moodle:
 * module_instance (module), date (date), course_instance (course — the
 * prerequisite course), enrol_period_days (duration — days after enrolment;
 * Moodle stores seconds, the LMS API surface is days), role_id (role — the
 * role whose holders may mark learners complete).
 */
export const courseCompletionCriteria = pgTable('course_completion_criteria', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  course: uuid('course').notNull().references(() => course.id, { onDelete: 'cascade' }),
  criteriaType: text('criteria_type').notNull(),
  moduleInstance: uuid('module_instance'),
  date: timestamp('date', { withTimezone: true }),
  courseInstance: uuid('course_instance').references(() => course.id, { onDelete: 'cascade' }),
  enrolPeriodDays: integer('enrol_period_days'),
  roleId: uuid('role_id').references(() => role.id, { onDelete: 'set null' }),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('course_completion_criteria_course_idx').on(table.course),
      index('course_completion_criteria_module_instance_idx').on(table.moduleInstance),
      index('course_completion_criteria_course_instance_idx').on(table.courseInstance),
      index('course_completion_criteria_role_id_idx').on(table.roleId),
  ]);

/**
 * Per-criterion completion marks (Moodle `course_completion_crit_compl`):
 * the evidence rows for the MANUAL criteria types — 'self' (marked by the
 * learner themselves) and 'role' (marked by a holder of the criterion's
 * role). Computed criteria types (module/date/grade/course/duration/
 * unenrol) are evaluated on the fly and never write rows here. A row's
 * existence means the criterion is complete for that user; `marked_by`
 * records who made the mark and `time_completed` when.
 */
export const courseCompletionCritCompl = pgTable(
  'course_completion_crit_compl',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    criteriaId: uuid('criteria_id').notNull().references(() => courseCompletionCriteria.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    markedBy: uuid('marked_by'),
    timeCompleted: timestamp('time_completed', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('course_completion_crit_compl_user_id_idx').on(table.userId),unique('course_completion_crit_compl_unique').on(table.criteriaId, table.userId)],
);


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
