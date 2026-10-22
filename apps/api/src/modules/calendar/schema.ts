/** Các bảng của bounded context Calendar — định nghĩa Drizzle do module calendar sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Calendar events (Moodle `event` → `calendar_events`). eventtype:
 * site|category|course|group|user decides visibility by the context tree +
 * group membership (report §2#13). A series is a set of rows sharing
 * `repeatid` (= id of the first event); the root carries the `rrule`
 * (FREQ=DAILY|WEEKLY|MONTHLY;COUNT=n|UNTIL=...). An exception is a row with
 * isexception=true and exceptionof = id of the occurrence it replaces.
 */
export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  eventtype: text('eventtype').notNull().default('user'),
  courseid: uuid('courseid'),
  groupid: uuid('groupid'),
  categoryid: uuid('categoryid'),
  userid: uuid('userid'),
  contextid: uuid('contextid'),
  subscriptionid: uuid('subscriptionid'),
  uuid: text('uuid'),
  repeatid: uuid('repeatid'),
  rrule: text('rrule'),
  isexception: boolean('isexception').notNull().default(false),
  exceptionof: uuid('exceptionof'),
  timestart: timestamp('timestart', { withTimezone: true }).notNull(),
  timeduration: integer('timeduration').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  location: text('location').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_events_courseid_idx').on(table.courseid),
      index('calendar_events_groupid_idx').on(table.groupid),
      index('calendar_events_categoryid_idx').on(table.categoryid),
      index('calendar_events_userid_idx').on(table.userid),
      index('calendar_events_contextid_idx').on(table.contextid),
      index('calendar_events_subscriptionid_idx').on(table.subscriptionid),
      index('calendar_events_repeatid_idx').on(table.repeatid),
      index('calendar_events_exceptionof_idx').on(table.exceptionof),
  ]);


/** Calendar subscriptions (Moodle `calendar_subscriptions`): external ICS feeds imported by a worker job. */
export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  url: text('url'),
  icsdata: text('icsdata'),
  eventtype: text('eventtype').notNull().default('site'),
  courseid: uuid('courseid'),
  categoryid: uuid('categoryid'),
  userid: uuid('userid'),
  pollinterval: integer('pollinterval').notNull().default(604800),
  lastupdated: timestamp('lastupdated', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_subscriptions_courseid_idx').on(table.courseid),
      index('calendar_subscriptions_categoryid_idx').on(table.categoryid),
      index('calendar_subscriptions_userid_idx').on(table.userid),
  ]);

