/** Các bảng của bounded context Groups & Cohorts — định nghĩa Drizzle do module groups sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course } from '../courses/schema';

/** Groups inside one course (Moodle `groups` → `course_groups`, reserved-word rename). */
export const courseGroups = pgTable(
  'course_groups',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idNumber: text('id_number').notNull().default(''),
    description: text('description').notNull().default(''),
    /**
     * Khoá ghi danh riêng của nhóm (group enrolment key của enrol_self, Moodle
     * `groups.enrolment_key`): học viên tự ghi danh bằng khoá này sẽ được xếp
     * vào nhóm. Bí mật — chỉ người có capability quản lý nhóm mới thấy giá trị thật.
     */
    enrolmentKey: text('enrolment_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_groups_course_name_unique').on(table.courseId, table.name)],
);

/** Group membership (Moodle `groups_members`). */
export const groupsMembers = pgTable(
  'groups_members',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    groupId: uuid('group_id').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    timeAdded: timestamp('time_added', { withTimezone: true }).notNull().defaultNow(),
    component: text('component').notNull().default(''),
    itemId: uuid('item_id'),
  },
  (table) => [
      index('groups_members_user_id_idx').on(table.userId),
      index('groups_members_item_id_idx').on(table.itemId),unique('groups_members_unique').on(table.groupId, table.userId, table.component, table.itemId)],
);

/** Groupings: groups-of-groups inside one course (Moodle `groupings`). */
export const groupings = pgTable(
  'groupings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseId: uuid('course_id').notNull().references(() => course.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idNumber: text('id_number').notNull().default(''),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('groupings_course_name_unique').on(table.courseId, table.name)],
);

/** Grouping ↔ group links (Moodle `groupings_groups`). */
export const groupingsGroups = pgTable(
  'groupings_groups',
  {
    groupingId: uuid('grouping_id').notNull().references(() => groupings.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    timeAdded: timestamp('time_added', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('groupings_groups_group_id_idx').on(table.groupId),primaryKey({ columns: [table.groupingId, table.groupId] })],
);

/** Cohorts live at system or course-category context (Moodle `cohort`). context_id references `context`. */
export const cohort = pgTable('cohort', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  idNumber: text('id_number').notNull().default(''),
  description: text('description').notNull().default(''),
  contextId: uuid('context_id').notNull(),
  component: text('component').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('cohort_context_id_idx').on(table.contextId),
  ]);


/** Cohort membership (Moodle `cohort_members`). */
export const cohortMembers = pgTable(
  'cohort_members',
  {
    cohortId: uuid('cohort_id').notNull().references(() => cohort.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    timeAdded: timestamp('time_added', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('cohort_members_user_id_idx').on(table.userId),primaryKey({ columns: [table.cohortId, table.userId] })],
);
