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
 * Trạng thái hoàn thành theo từng hoạt động (Moodle `course_modules_completion`).
 * completion_state: 0=incomplete, 1=complete, 2=complete-pass, 3=complete-fail
 * (pass/fail đến cùng với điểm số; phần này ghi 0/1 và `viewed`).
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
 * Tiêu chí hoàn thành ở cấp khoá học (Moodle `course_completion_criteria`).
 * criteria_type bao phủ cả 8 loại của Moodle: 'module' | 'date' | 'grade'
 * (grade được nối qua module grades) | 'self' | 'course' | 'duration'
 * | 'role' | 'unenrol'. Tham số theo từng loại nằm trên dòng, giống Moodle:
 * module_instance (module), date (date), course_instance (course — khoá
 * học tiên quyết), enrol_period_days (duration — số ngày sau khi ghi danh;
 * Moodle lưu bằng giây, bề mặt API của LMS dùng ngày), role_id (role —
 * vai trò mà người giữ vai trò đó có thể đánh dấu người học là hoàn thành).
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
 * Dấu hoàn thành theo từng tiêu chí (Moodle `course_completion_crit_compl`):
 * các dòng bằng chứng cho các loại tiêu chí THỦ CÔNG — 'self' (do chính
 * người học đánh dấu) và 'role' (do người giữ vai trò của tiêu chí
 * đánh dấu). Các loại tiêu chí được tính toán (module/date/grade/course/duration/
 * unenrol) được đánh giá ngay khi cần và không bao giờ ghi dòng ở đây. Sự
 * tồn tại của một dòng nghĩa là tiêu chí đã hoàn thành đối với user đó; `marked_by`
 * ghi lại ai đã đánh dấu và `time_completed` ghi lại khi nào.
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


/** Cài đặt tổng hợp hoàn thành theo từng khoá học: method 1 = ALL (AND), 2 = ANY (OR). */
export const courseCompletionSettings = pgTable('course_completion_settings', {
  course: uuid('course').primaryKey().references(() => course.id, { onDelete: 'cascade' }),
  method: integer('method').notNull().default(1),
});

/** Trạng thái hoàn thành khoá học theo từng user (Moodle `course_completions`). status: 'not_started' | 'in_progress' | 'complete'. */
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
