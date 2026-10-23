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
 * Calendar events (Moodle `event` → `calendar_events`). event_type:
 * site|category|course|group|user decides visibility by the context tree +
 * group membership (report §2#13). A series is a set of rows sharing
 * `repeat_id` (= id of the first event); the root carries the `rrule`
 * (FREQ=DAILY|WEEKLY|MONTHLY;COUNT=n|UNTIL=...). An exception is a row with
 * is_exception=true and exception_of = id of the occurrence it replaces.
 */
export const calendarEvents = pgTable('calendar_events', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  eventType: text('event_type').notNull().default('user'),
  courseId: uuid('course_id'),
  groupId: uuid('group_id'),
  categoryId: uuid('category_id'),
  userId: uuid('user_id'),
  contextId: uuid('context_id'),
  subscriptionId: uuid('subscription_id'),
  uuid: text('uuid'),
  repeatId: uuid('repeat_id'),
  rrule: text('rrule'),
  isException: boolean('is_exception').notNull().default(false),
  exceptionOf: uuid('exception_of'),
  timeStart: timestamp('time_start', { withTimezone: true }).notNull(),
  timeDuration: integer('time_duration').notNull().default(0),
  visible: boolean('visible').notNull().default(true),
  location: text('location').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_events_course_id_idx').on(table.courseId),
      index('calendar_events_group_id_idx').on(table.groupId),
      index('calendar_events_category_id_idx').on(table.categoryId),
      index('calendar_events_user_id_idx').on(table.userId),
      index('calendar_events_context_id_idx').on(table.contextId),
      index('calendar_events_subscription_id_idx').on(table.subscriptionId),
      index('calendar_events_repeat_id_idx').on(table.repeatId),
      index('calendar_events_exception_of_idx').on(table.exceptionOf),
  ]);


/**
 * Token xuất lịch cá nhân (Moodle calendar export URL): mỗi user có tối đa
 * MỘT token đang hiệu lực để tải ICS qua URL công khai không cần đăng nhập.
 * Chỉ lưu HASH SHA-256 của token (đúng mẫu webservice tokens) — token thô
 * chỉ tồn tại trong lần trả về khi tạo/đổi; đổi hoặc thu hồi là URL cũ chết.
 */
export const calendarExportTokens = pgTable('calendar_export_tokens', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: uuid('user_id').notNull().unique(),
  tokenHash: text('token_hash').notNull().unique(),
  lastAccess: timestamp('last_access', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_export_tokens_user_id_idx').on(table.userId),
  ]);


/** Calendar subscriptions (Moodle `calendar_subscriptions`): external ICS feeds imported by a worker job. */
export const calendarSubscriptions = pgTable('calendar_subscriptions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  name: text('name').notNull(),
  url: text('url'),
  icsData: text('ics_data'),
  eventType: text('event_type').notNull().default('site'),
  courseId: uuid('course_id'),
  categoryId: uuid('category_id'),
  userId: uuid('user_id'),
  pollInterval: integer('poll_interval').notNull().default(604800),
  lastUpdated: timestamp('last_updated', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('calendar_subscriptions_course_id_idx').on(table.courseId),
      index('calendar_subscriptions_category_id_idx').on(table.categoryId),
      index('calendar_subscriptions_user_id_idx').on(table.userId),
  ]);

