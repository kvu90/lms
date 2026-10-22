/** Các bảng của bounded context Enrol — định nghĩa Drizzle do module enrol sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { course } from '../courses/schema';

/**
 * Enrol instances per course (Moodle `enrol`). method: manual|cohort|self|guest.
 * status: 0=enabled, 1=disabled. For cohort instances customint1 = cohort id,
 * customint2 = group id to add members to (0=none), customtext1 = sync mode
 * ('suspend'|'unenrol') applied when a user leaves the cohort.
 */
export const enrol = pgTable('enrol', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  courseid: uuid('courseid').notNull().references(() => course.id, { onDelete: 'cascade' }),
  enrol: text('enrol').notNull(),
  status: integer('status').notNull().default(0),
  name: text('name'),
  roleid: uuid('roleid'),
  enrolperiod: integer('enrolperiod').notNull().default(0),
  timestart: timestamp('timestart', { withTimezone: true }),
  timeend: timestamp('timeend', { withTimezone: true }),
  customint1: uuid('customint1'),
  customint2: uuid('customint2'),
  customtext1: text('customtext1').notNull().default('suspend'),
  /** Fee enrol: cost in smallest currency unit (0 = free), currency ISO code, payment account id. */
  cost: integer('cost').notNull().default(0),
  currency: text('currency').notNull().default(''),
  paymentaccountid: uuid('paymentaccountid'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('enrol_courseid_idx').on(table.courseid),
      index('enrol_roleid_idx').on(table.roleid),
      index('enrol_customint1_idx').on(table.customint1),
      index('enrol_customint2_idx').on(table.customint2),
      index('enrol_paymentaccountid_idx').on(table.paymentaccountid),
  ]);


/**
 * User enrolments (Moodle `user_enrolments`).
 * status: 0=ACTIVE, 1=SUSPENDED, 2=WITHDRAWN (soft state used on unenrol when
 * the user still has related data — grades/completion/files — that must be
 * kept; the row is never hard-deleted in that case, report §2#5).
 */
export const userEnrolments = pgTable(
  'user_enrolments',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    enrolid: uuid('enrolid').notNull().references(() => enrol.id, { onDelete: 'cascade' }),
    userid: uuid('userid').notNull(),
    status: integer('status').notNull().default(0),
    timestart: timestamp('timestart', { withTimezone: true }).notNull().defaultNow(),
    timeend: timestamp('timeend', { withTimezone: true }),
    modifierid: uuid('modifierid'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
    timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('user_enrolments_userid_idx').on(table.userid),
      index('user_enrolments_modifierid_idx').on(table.modifierid),unique('user_enrolments_unique').on(table.enrolid, table.userid)],
);
