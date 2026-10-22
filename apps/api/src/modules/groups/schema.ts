/** Các bảng của bounded context Groups & Cohorts — định nghĩa Drizzle do module groups sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { course } from '../courses/schema';

/** Groups inside one course (Moodle `groups` → `course_groups`, reserved-word rename). */
export const courseGroups = pgTable(
  'course_groups',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idnumber: text('idnumber').notNull().default(''),
    description: text('description').notNull().default(''),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('course_groups_course_name_unique').on(table.courseid, table.name)],
);

/** Group membership (Moodle `groups_members`). */
export const groupsMembers = pgTable(
  'groups_members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupid: integer('groupid').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
    component: text('component').notNull().default(''),
    itemid: integer('itemid').notNull().default(0),
  },
  (table) => [unique('groups_members_unique').on(table.groupid, table.userid, table.component, table.itemid)],
);

/** Groupings: groups-of-groups inside one course (Moodle `groupings`). */
export const groupings = pgTable(
  'groupings',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    idnumber: text('idnumber').notNull().default(''),
    description: text('description').notNull().default(''),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('groupings_course_name_unique').on(table.courseid, table.name)],
);

/** Grouping ↔ group links (Moodle `groupings_groups`). */
export const groupingsGroups = pgTable(
  'groupings_groups',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupingid: integer('groupingid').notNull().references(() => groupings.id, { onDelete: 'cascade' }),
    groupid: integer('groupid').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('groupings_groups_unique').on(table.groupingid, table.groupid)],
);

/** Cohorts live at system or course-category context (Moodle `cohort`). contextid references `context`. */
export const cohort = pgTable('cohort', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  contextid: integer('contextid').notNull(),
  component: text('component').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Cohort membership (Moodle `cohort_members`). */
export const cohortMembers = pgTable(
  'cohort_members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    cohortid: integer('cohortid').notNull().references(() => cohort.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('cohort_members_unique').on(table.cohortid, table.userid)],
);
