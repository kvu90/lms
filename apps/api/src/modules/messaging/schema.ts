/** Các bảng của bounded context Messaging & Notifications — định nghĩa Drizzle do module messaging sở hữu; file barrel `src/db/schema.ts` tổng hợp toàn bộ cho Drizzle. */
import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

/** Conversations (Moodle `message_conversations`). type: 1=individual, 2=group, 3=self. */
export const messageConversations = pgTable('message_conversations', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  type: integer('type').notNull().default(1),
  name: text('name'),
  component: text('component'),
  itemtype: text('itemtype'),
  itemid: integer('itemid').notNull().default(0),
  contextid: integer('contextid'),
  enabled: boolean('enabled').notNull().default(true),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timemodified: timestamp('timemodified', { withTimezone: true }).notNull().defaultNow(),
});

/** Conversation membership (Moodle `message_conversation_members`). */
export const messageConversationMembers = pgTable(
  'message_conversation_members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    conversationid: integer('conversationid').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
    userid: integer('userid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('message_conversation_members_unique').on(table.conversationid, table.userid)],
);

/**
 * User-to-user messages inside a conversation (Moodle `message` +
 * `messages`). Once sent, a message belongs to core_message: the sending
 * component/user can NEVER edit or delete it through the API (report §2#12).
 * `timeread` is the recipient-side read marker used for unread counts.
 */
export const message = pgTable('message', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  conversationid: integer('conversationid').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
  useridfrom: integer('useridfrom').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
});

/** Blocked contacts (Moodle `message_users_blocked`): userid blocks blockeduserid from contacting them. */
export const messageUsersBlocked = pgTable(
  'message_users_blocked',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userid: integer('userid').notNull(),
    blockeduserid: integer('blockeduserid').notNull(),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('message_users_blocked_unique').on(table.userid, table.blockeduserid)],
);

/**
 * System notifications (Moodle `notifications`) — DISTINCT from user
 * messages: useridfrom is null/system, the record is produced by a message
 * provider (component + eventtype) and delivered per user preference.
 */
export const notifications = pgTable('notifications', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  useridfrom: integer('useridfrom'),
  useridto: integer('useridto').notNull(),
  subject: text('subject').notNull().default(''),
  fullmessage: text('fullmessage').notNull().default(''),
  smallmessage: text('smallmessage').notNull().default(''),
  component: text('component').notNull().default(''),
  eventtype: text('eventtype').notNull().default(''),
  contexturl: text('contexturl'),
  contexturlname: text('contexturlname'),
  timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  timeread: timestamp('timeread', { withTimezone: true }),
});

/**
 * Per-channel dispatch log for notifications. The in-app (popup) channel is
 * the only REAL channel; email/push are ports whose dispatch is only LOGGED
 * (never actually sent) — status: delivered | queued | logged | skipped-preference | skipped-suspended.
 * `dedupekey` makes worker dispatch idempotent.
 */
export const notificationDispatchLog = pgTable(
  'notification_dispatch_log',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    notificationid: integer('notificationid'),
    userid: integer('userid').notNull(),
    provider: text('provider').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    subject: text('subject').notNull().default(''),
    dedupekey: text('dedupekey'),
    timecreated: timestamp('timecreated', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('notification_dispatch_log_dedupe_unique').on(table.dedupekey)],
);
