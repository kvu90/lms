/** Các bảng của bounded context Enrol — định nghĩa Drizzle do module enrol sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { course } from '../courses/schema';

/**
 * Enrol instances per course (Moodle `enrol`). method: manual|cohort|self|guest.
 * status: 0=enabled, 1=disabled. For cohort instances customint1 = cohort id,
 * customint2 = group id to add members to (0=none), customtext1 = sync mode
 * ('suspend'|'unenrol') applied when a user leaves the cohort.
 */
export const enrol = pgTable('enrol', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  courseid: integer('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  name: text('name'),
  roleid: integer('roleid'),
  enrolperiod: integer('enrolperiod').notNull().default(0),
  timestart: timestamp('timestart', { withTimezone: true }),
  timeend: timestamp('timeend', { withTimezone: true }),
  customint1: integer('customint1').notNull().default(0),
  customint2: integer('customint2').notNull().default(0),
  customtext1: text('customtext1').notNull().default('suspend'),
  /** Fee enrol: cost in smallest currency unit (0 = free), currency ISO code, payment account id. */
  cost: integer('cost').notNull().default(0),
  currency: text('currency').notNull().default(''),
  paymentaccountid: integer('paymentaccountid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * User enrolments (Moodle `user_enrolments`).
 * status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN (soft state used on unenrol when
 * the user still has related data — grades/completion/files — that must be
 * kept; the row is never hard-deleted in that case, report §2#5).
 */
export const userEnrolments = pgTable(
  'user_enrolments',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    enrolid: integer('enrolid').notNull().references(() => enrol.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    status: integer('status').notNull().default(0),
    timestart: timestamp('timestart', { withTimezone: true }).notNull().defaultNow(),
    timeend: timestamp('timeend', { withTimezone: true }),
    modifierid: integer('modifierid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('user_enrolments_unique').on(table.enrolid, table.userid)],
);
