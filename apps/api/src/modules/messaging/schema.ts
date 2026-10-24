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
  itemType: text('item_type'),
  itemId: uuid('item_id'),
  contextId: uuid('context_id'),
  enabled: boolean('enabled').notNull().default(true),
  /**
   * Bộ đếm seq của conversation: mỗi tin mới nhận `last_message_seq + 1`
   * trong cùng transaction gửi tin (khoá dòng bằng UPDATE ... RETURNING
   * nên các lần gửi đồng thời không va chạm seq). Client đồng bộ và
   * phân trang theo seq này thay vì dựa vào thứ tự của uuidv7.
   */
  lastMessageSeq: integer('last_message_seq').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('message_conversations_item_id_idx').on(table.itemId),
      index('message_conversations_context_id_idx').on(table.contextId),
  ]);


/** Conversation membership (Moodle `message_conversation_members`). */
export const messageConversationMembers = pgTable(
  'message_conversation_members',
  {
    conversationId: uuid('conversation_id').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    /**
     * Mốc đã đọc CỦA RIÊNG thành viên này: đã đọc mọi tin có
     * `seq <= last_read_seq`. Số chưa đọc = đếm tin có seq lớn hơn mốc
     * và không phải tin của chính mình. (Mô hình cũ để `time_read` trên
     * từng tin dùng CHUNG cho cả nhóm — một người đọc là cả nhóm mất
     * số chưa đọc — đã bỏ ở issue #33.)
     */
    lastReadSeq: integer('last_read_seq').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_conversation_members_user_id_idx').on(table.userId),primaryKey({ columns: [table.conversationId, table.userId] })],
);

/**
 * User-to-user messages inside a conversation (Moodle `message` +
 * `messages`).
 *
 * LƯU Ý mô hình (issue #33): tin nhắn KHÔNG còn được coi là bất biến
 * tuyệt đối — chính sách đã chốt là XOÁ MỀM có truy vết ở đợt Lớp B
 * (người xoá/khi nào xoá + tầm nhìn theo vai trò: học sinh không thấy
 * tin đã xoá, giáo viên vẫn truy vết được). Đợt nền này chưa triển
 * khai xoá, nhưng đường đọc/đếm chưa đọc phải đi qua tầng repository
 * để đợt Lớp B gắn điều kiện lọc theo trạng thái đã-xoá tại một chỗ,
 * không rải giả định "mọi tin luôn hiển thị" khắp nơi.
 *
 * `seq` là số thứ tự đơn điệu trong conversation (xem
 * `message_conversations.last_message_seq`); `client_message_id` là
 * khoá chống trùng do client sinh — ràng buộc duy nhất
 * (conversation, người gửi, khoá) đảm bảo gửi lại không nhân đôi
 * (NULL không va chạm nhau trong Postgres nên tin không kèm khoá
 * không bị ràng buộc này ảnh hưởng).
 */
export const message = pgTable('message', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  conversationId: uuid('conversation_id').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
  userIdFrom: uuid('user_id_from').notNull(),
  subject: text('subject').notNull().default(''),
  fullMessage: text('full_message').notNull().default(''),
  smallMessage: text('small_message').notNull().default(''),
  seq: integer('seq').notNull(),
  clientMessageId: text('client_message_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('message_conversation_id_idx').on(table.conversationId),
      index('message_user_id_from_idx').on(table.userIdFrom),
      index('message_conversation_seq_idx').on(table.conversationId, table.seq),
      unique('message_conversation_client_id_unique').on(table.conversationId, table.userIdFrom, table.clientMessageId),
  ]);


/**
 * Contacts (Moodle `message_contacts`): user_id đã thêm contact_id vào danh
 * bạ của mình. Quan hệ có hướng — dòng (người nhận, người gửi) là một trong
 * hai điều kiện mở cổng liên lạc khi `core/messagingallusers` tắt.
 */
export const messageContacts = pgTable(
  'message_contacts',
  {
    userId: uuid('user_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_contacts_contact_id_idx').on(table.contactId),primaryKey({ columns: [table.userId, table.contactId] })],
);

/** Blocked contacts (Moodle `message_users_blocked`): user_id blocks blocked_user_id from contacting them. */
export const messageUsersBlocked = pgTable(
  'message_users_blocked',
  {
    userId: uuid('user_id').notNull(),
    blockedUserId: uuid('blocked_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_users_blocked_blocked_user_id_idx').on(table.blockedUserId),primaryKey({ columns: [table.userId, table.blockedUserId] })],
);

/**
 * System notifications (Moodle `notifications`) — DISTINCT from user
 * messages: user_id_from is null/system, the record is produced by a message
 * provider (component + event_type) and delivered per user preference.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userIdFrom: uuid('user_id_from'),
  userIdTo: uuid('user_id_to').notNull(),
  subject: text('subject').notNull().default(''),
  fullMessage: text('full_message').notNull().default(''),
  smallMessage: text('small_message').notNull().default(''),
  component: text('component').notNull().default(''),
  eventType: text('event_type').notNull().default(''),
  contextUrl: text('context_url'),
  contextUrlName: text('context_url_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  timeRead: timestamp('time_read', { withTimezone: true }),
},
  (table) => [
      index('notifications_user_id_from_idx').on(table.userIdFrom),
      index('notifications_user_id_to_idx').on(table.userIdTo),
  ]);


/**
 * Per-channel dispatch log for notifications. The in-app (popup) channel is
 * the only REAL channel; email/push are ports whose dispatch is only LOGGED
 * (never actually sent) — status: delivered | queued | logged | skipped-preference | skipped-suspended.
 * `dedupe_key` makes worker dispatch idempotent.
 */
export const notificationDispatchLog = pgTable(
  'notification_dispatch_log',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    notificationId: uuid('notification_id'),
    userId: uuid('user_id').notNull(),
    provider: text('provider').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    subject: text('subject').notNull().default(''),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('notification_dispatch_log_notification_id_idx').on(table.notificationId),
      index('notification_dispatch_log_user_id_idx').on(table.userId),unique('notification_dispatch_log_dedupe_unique').on(table.dedupeKey)],
);
