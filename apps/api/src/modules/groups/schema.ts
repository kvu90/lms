/** Các bảng của bounded context Groups & Cohorts — định nghĩa Drizzle do module groups sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
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
    courseid: uuid('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
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
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    groupid: uuid('groupid').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    userid: uuid('userid').notNull(),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
    component: text('component').notNull().default(''),
    itemid: uuid('itemid'),
  },
  (table) => [
      index('groups_members_userid_idx').on(table.userid),
      index('groups_members_itemid_idx').on(table.itemid),unique('groups_members_unique').on(table.groupid, table.userid, table.component, table.itemid)],
);

/** Groupings: groups-of-groups inside one course (Moodle `groupings`). */
export const groupings = pgTable(
  'groupings',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    courseid: uuid('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
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
    groupingid: uuid('groupingid').notNull().references(() => groupings.id, { onDelete: 'cascade' }),
    groupid: uuid('groupid').notNull().references(() => courseGroups.id, { onDelete: 'cascade' }),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('groupings_groups_groupid_idx').on(table.groupid),primaryKey({ columns: [table.groupingid, table.groupid] })],
);

/** Cohorts live at system or course-category context (Moodle `cohort`). contextid references `context`. */
export const cohort = pgTable('cohort', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  idnumber: text('idnumber').notNull().default(''),
  description: text('description').notNull().default(''),
  contextid: uuid('contextid').notNull(),
  component: text('component').notNull().default(''),
  visible: boolean('visible').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('cohort_contextid_idx').on(table.contextid),
  ]);


/** Cohort membership (Moodle `cohort_members`). */
export const cohortMembers = pgTable(
  'cohort_members',
  {
    cohortid: uuid('cohortid').notNull().references(() => cohort.id, { onDelete: 'cascade' }),
    userid: uuid('userid').notNull(),
    timeadded: timestamp('timeadded', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('cohort_members_userid_idx').on(table.userid),primaryKey({ columns: [table.cohortid, table.userid] })],
);
