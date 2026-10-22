/** Các bảng của bounded context Calendar — định nghĩa Drizzle do module calendar sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Calendar events (Moodle `event` → `calendar_events`). eventtype:
 * site|category|course|group|user decides visibility by the context tree +
 * group membership (report §2#13). A series is a set of rows sharing
 * `repeatid` (= id of the first event); the root carries the `rrule`
 * (FREQ=DAILY|WEEKLY|MONTHLY;COUNT=n|UNTIL=...). An exception is a row with
 * isexception=true and exceptionof = id of the occurrence it replaces.
 */
export const calendarEvents = pgTable('calendar_events', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  eventtype: text('eventtype').notNull().default('user'),
  courseid: integer('courseid').notNull().default(0),
  groupid: integer('groupid').notNull().default(0),
  categoryid: integer('categoryid').notNull().default(0),
  userid: integer('userid').notNull().default(0),
  contextid: integer('contextid'),
  subscriptionid: integer('subscriptionid'),
  uuid: text('uuid'),
  repeatid: integer('repeatid').notNull().default(0),
  rrule: text('rrule'),
  isexception: boolean('isexception').notNull().default(false),
  exceptionof: integer('exceptionof'),
  timestart: timestamp('timestart', { withTimezone: true }).notNull(),
  timeduration: integer('timeduration').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  location: text('location').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Calendar subscriptions (Moodle `calendar_subscriptions`): external ICS feeds imported by a worker job. */
export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  url: text('url'),
  icsdata: text('icsdata'),
  eventtype: text('eventtype').notNull().default('site'),
  courseid: integer('courseid').notNull().default(0),
  categoryid: integer('categoryid').notNull().default(0),
  userid: integer('userid').notNull().default(0),
  pollinterval: integer('pollinterval').notNull().default(604800),
  lastupdated: timestamp('lastupdated', { withTimezone: true }),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
});
