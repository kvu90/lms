/** Các bảng của bounded context Messaging & Notifications — định nghĩa Drizzle do module messaging sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
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

/** Conversations (Moodle `message_conversations`). type: 1=individual, 2=group, 3=self. */
export const messageConversations = pgTable('message_conversations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  type: integer('type').notNull().default(1),
  name: text('name'),
  component: text('component'),
  itemtype: text('itemtype'),
  itemid: uuid('itemid'),
  contextid: uuid('contextid'),
  enabled: boolean('enabled').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('message_conversations_itemid_idx').on(table.itemid),
      index('message_conversations_contextid_idx').on(table.contextid),
  ]);


/** Conversation membership (Moodle `message_conversation_members`). */
export const messageConversationMembers = pgTable(
  'message_conversation_members',
  {
    conversationid: uuid('conversationid').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
    userid: uuid('userid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_conversation_members_userid_idx').on(table.userid),primaryKey({ columns: [table.conversationid, table.userid] })],
);

/**
 * User-to-user messages inside a conversation (Moodle `message` +
 * `messages`). Once sent, a message belongs to core_message: the sending
 * component/user can NEVER edit or delete it through the API (report §2#12).
 * `timeread` is the recipient-side read marker used for unread counts.
 */
export const message = pgTable('message', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  conversationid: uuid('conversationid').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
  useridfrom: uuid('useridfrom').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
},
  (table) => [
      index('message_conversationid_idx').on(table.conversationid),
      index('message_useridfrom_idx').on(table.useridfrom),
  ]);


/**
 * Contacts (Moodle `message_contacts`): userid đã thêm contactid vào danh
 * bạ của mình. Quan hệ có hướng — dòng (người nhận, người gửi) là một trong
 * hai điều kiện mở cổng liên lạc khi `core/messagingallusers` tắt.
 */
export const messageContacts = pgTable(
  'message_contacts',
  {
    userid: uuid('userid').notNull(),
    contactid: uuid('contactid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_contacts_contactid_idx').on(table.contactid),primaryKey({ columns: [table.userid, table.contactid] })],
);

/** Blocked contacts (Moodle `message_users_blocked`): userid blocks blockeduserid from contacting them. */
export const messageUsersBlocked = pgTable(
  'message_users_blocked',
  {
    userid: uuid('userid').notNull(),
    blockeduserid: uuid('blockeduserid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_users_blocked_blockeduserid_idx').on(table.blockeduserid),primaryKey({ columns: [table.userid, table.blockeduserid] })],
);

/**
 * System notifications (Moodle `notifications`) — DISTINCT from user
 * messages: useridfrom is null/system, the record is produced by a message
 * provider (component + eventtype) and delivered per user preference.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  useridfrom: uuid('useridfrom'),
  useridto: uuid('useridto').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  component: text('component').notNull().default(''),
  eventtype: text('eventtype').notNull().default(''),
  contexturl: text('contexturl'),
  contexturlname: text('contexturlname'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
},
  (table) => [
      index('notifications_useridfrom_idx').on(table.useridfrom),
      index('notifications_useridto_idx').on(table.useridto),
  ]);


/**
 * Per-channel dispatch log for notifications. The in-app (popup) channel is
 * the only REAL channel; email/push are ports whose dispatch is only LOGGED
 * (never actually sent) — status: delivered | queued | logged | skipped-preference | skipped-suspended.
 * `dedupekey` makes worker dispatch idempotent.
 */
export const notificationDispatchLog = pgTable(
  'notification_dispatch_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    notificationid: uuid('notificationid'),
    userid: uuid('userid').notNull(),
    provider: text('provider').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    subject: text('subject').notNull().default(''),
    dedupekey: text('dedupekey'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('notification_dispatch_log_notificationid_idx').on(table.notificationid),
      index('notification_dispatch_log_userid_idx').on(table.userid),unique('notification_dispatch_log_dedupe_unique').on(table.dedupekey)],
);
