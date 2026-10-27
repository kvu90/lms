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
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from '../tenants/schema';

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
   * Người tạo conversation (Lớp B, issue #33): căn cứ thẩm quyền quản
   * lý cho nhóm tự do (người tạo tắt/bật chat của nhóm mình) và truy
   * vết ai đã lập nhóm. Conversation sinh từ đồng bộ cấu trúc lớp/khoá
   * ghi người đã khởi tạo bản ghi, nhưng thẩm quyền quản lý của chúng
   * vẫn theo staff của khoá, không theo người tạo.
   */
  createdBy: uuid('created_by'),
  /**
   * Tenant sở hữu conversation (TENANT-1, #196): conversation cấu trúc
   * (lớp/khoá) mang tenant của khoá chứa nó; conversation cá nhân mang
   * tenant của ngữ cảnh tạo. Cột nullable — tầng realtime dùng nó để
   * namespace room theo tenant khi có mặt; hàng lịch sử không có tenant
   * chỉ hiển thị ở ngữ cảnh platform.
   */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
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
      index('message_conversations_tenant_id_idx').on(table.tenantId),
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
    /**
     * Ba trạng thái THEO TỪNG THÀNH VIÊN trên conversation (lát M5,
     * issue #240) — trạng thái cá nhân của dòng thành viên này, không
     * ảnh hưởng thành viên khác:
     * - `pinnedAt`: mốc GHIM — danh sách xếp các conversation đã ghim
     *   lên đầu (trong nhóm ghim vẫn theo hoạt động gần nhất); null =
     *   không ghim.
     * - `archivedAt`: mốc LƯU TRỮ — conversation đã lưu mặc định ẩn
     *   khỏi danh sách chính; tin mới vào conversation thì server TỰ
     *   BỎ LƯU cho các thành viên còn lại (trừ người gửi) ngay trong
     *   transaction gửi tin, để hội thoại hiện lại. null = không lưu.
     * - `muted`: TẮT TIẾNG — consumer thông báo bỏ qua thành viên này
     *   khi sinh `message_new`, và số huy hiệu điều hướng không tính
     *   conversation này; tin vẫn tới và đọc được bình thường.
     */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    muted: boolean('muted').notNull().default(false),
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
  /**
   * Trả lời TRÍCH DẪN (lát M3, issue #229): tin này trả lời một tin
   * gốc trong ĐÚNG conversation của nó (gác ở tầng service — trích
   * dẫn chéo conversation bị từ chối, không lộ tồn tại). Tự tham
   * chiếu tới `message.id`; tin gốc bị XOÁ CỨNG thì khoá ngoại
   * `set null` — trích dẫn mất neo và tin hiển thị như tin thường,
   * còn xoá mềm/thu hồi giữ nguyên dòng nên server dựng khối tóm tắt
   * "tin gốc đã bị xoá" mà không lộ nội dung. Không có ràng buộc
   * không-trùng: nhiều tin cùng trích dẫn một tin gốc là bình thường.
   */
  replyToMessageId: uuid('reply_to_message_id').references((): AnyPgColumn => message.id, { onDelete: 'set null' }),
  /**
   * Dấu vết XOÁ MỀM (Lớp B, issue #33 — chính sách đã chốt thay tính
   * bất biến tuyệt đối): tin bị xoá chỉ được đánh dấu tại đây (ai xoá,
   * khi nào), dòng tin và nội dung giữ nguyên. Mọi đường đọc thường
   * của thành viên lọc bỏ tin có `deleted_at` (kể cả tác giả); chỉ các
   * đường truy vết có thẩm quyền (giáo viên phụ trách/quản trị, xem lại
   * conversation bị báo cáo) mới đọc được các tin này.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: uuid('deleted_by'),
  /**
   * Dấu vết THU HỒI (vòng đời tin nhắn theo vai, issue #33): tác giả
   * thu hồi tin cho MỌI NGƯỜI trong cửa sổ cấu hình site
   * (`core/messagingrecallwindowminutes`, mặc định 15 phút kể từ lúc
   * gửi). Nội dung gốc GIỮ NGUYÊN trong dòng — đường đọc thường vô
   * hiệu hoá nó (trả nội dung rỗng + hai trường này) cho mọi thành
   * viên thường, đường truy vết có thẩm quyền vẫn đọc được để đối
   * chiếu với dòng moderator_action 'recall' tương ứng.
   */
  recalledAt: timestamp('recalled_at', { withTimezone: true }),
  recalledBy: uuid('recalled_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('message_conversation_id_idx').on(table.conversationId),
      index('message_user_id_from_idx').on(table.userIdFrom),
      index('message_reply_to_message_id_idx').on(table.replyToMessageId),
      index('message_conversation_seq_idx').on(table.conversationId, table.seq),
      unique('message_conversation_client_id_unique').on(table.conversationId, table.userIdFrom, table.clientMessageId),
  ]);

/**
 * Cờ XOÁ-PHÍA-MÌNH theo từng user (vòng đời tin nhắn theo vai, issue
 * #33 — lớp (a)): một thành viên (thường là tác giả) ẩn một tin khỏi
 * tầm nhìn của CHÍNH MÌNH, mọi lúc, không điều kiện cửa sổ. Tin vẫn
 * hiển thị nguyên vẹn với mọi thành viên khác; dòng này chỉ là cờ
 * hiển thị cá nhân — KHÔNG phải dấu vết kiểm duyệt và không ai khác
 * đọc được nó. PK phức hợp (message, user) là định danh tự nhiên;
 * tin bị xoá cứng thì các cờ của nó cascade theo.
 */
export const messageUserDeletions = pgTable(
  'message_user_deletions',
  {
    messageId: uuid('message_id').notNull().references(() => message.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_user_deletions_user_id_idx').on(table.userId),primaryKey({ columns: [table.messageId, table.userId] })],
);

/**
 * Dấu vết HÀNH ĐỘNG KIỂM DUYỆT trên tin nhắn (vòng đời tin nhắn theo
 * vai, issue #33): mỗi lần thu hồi (`recall` — do chính tác giả, lý
 * do để trống) và mỗi lần xoá cứng (`hard_delete` / `bulk_hard_delete`
 * — do người có capability `moderation:manage`, lý do BẮT BUỘC) đều
 * ghi đúng một dòng tại đây TRƯỚC khi trạng thái tin thay đổi. Đây là
 * căn cứ truy vết duy nhất còn lại sau xoá cứng nên các cột định danh
 * (message/conversation/tác giả/seq) là BẢN CHỤP, cố ý KHÔNG khoá
 * ngoại: dòng tin bị xoá vật lý không được kéo theo dấu vết của
 * chính lần xoá đó. Nội dung tin KHÔNG được sao vào đây — xoá cứng
 * là xoá thật khỏi hệ thống.
 */
export const messageModeratorActions = pgTable('message_moderator_actions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  messageId: uuid('message_id').notNull(),
  conversationId: uuid('conversation_id').notNull(),
  /** Người thực hiện hành động (tác giả khi recall, moderator khi xoá cứng). */
  actorId: uuid('actor_id').notNull(),
  /** Bản chụp tác giả của tin tại thời điểm hành động. */
  authorId: uuid('author_id').notNull(),
  /** 'recall' | 'hard_delete' | 'bulk_hard_delete'. */
  action: text('action').notNull(),
  /** Lý do: bắt buộc với hai hành động xoá cứng (chốt ở tầng service + DTO), null với recall. */
  reason: text('reason'),
  /** Bản chụp seq của tin trong conversation tại thời điểm hành động. */
  messageSeq: integer('message_seq'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('message_moderator_actions_message_id_idx').on(table.messageId),
      index('message_moderator_actions_conversation_id_idx').on(table.conversationId),
      index('message_moderator_actions_actor_id_idx').on(table.actorId),
  ]);


/**
 * Contacts (Moodle `message_contacts`): quan hệ liên hệ ĐÃ ĐƯỢC DUYỆT
 * (issue #33 Lớp B — thay danh bạ một chiều bằng luồng yêu cầu–chấp
 * nhận như Moodle). Một quan hệ được duyệt luôn tồn tại ở CẢ HAI dòng
 * (a→b và b→a): chấp nhận ghi cả hai, gỡ liên hệ xoá cả hai. Hàng chờ
 * duyệt sống ở bảng `message_contact_requests`, KHÔNG nằm ở đây — cổng
 * liên lạc chỉ đọc bảng này nên yêu cầu đang chờ không mở cổng.
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

/**
 * Yêu cầu kết bạn đang chờ duyệt (Moodle `message_contact_requests`):
 * user_id_from gửi yêu cầu tới user_id_to; phía nhận chấp nhận thì quan
 * hệ chuyển thành hai dòng trong `message_contacts` và dòng yêu cầu bị
 * xoá; từ chối thì chỉ xoá dòng yêu cầu. PK phức hợp (from, to) — cặp
 * có hướng là định danh tự nhiên của một yêu cầu (bảng nối thuần tuý,
 * không khoá thay thế).
 */
export const messageContactRequests = pgTable(
  'message_contact_requests',
  {
    userIdFrom: uuid('user_id_from').notNull(),
    userIdTo: uuid('user_id_to').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('message_contact_requests_user_id_to_idx').on(table.userIdTo),primaryKey({ columns: [table.userIdFrom, table.userIdTo] })],
);

/**
 * Báo cáo conversation (Lớp B, issue #33 — chính sách báo cáo/kiểm
 * duyệt đã chốt): một thành viên báo cáo một conversation; báo cáo vào
 * hàng đợi của giáo viên phụ trách lớp/khoá liên quan + quản trị viên.
 * Chỉ người có thẩm quyền theo phạm vi mới xem lại được nội dung của
 * đúng conversation bị báo cáo (mọi lần xem ghi event_log qua outbox),
 * và chỉ họ mới đổi được trạng thái xử lý (`open` → `resolved`/
 * `dismissed`, kèm dấu người xử lý và thời điểm).
 */
export const messageConversationReports = pgTable('message_conversation_reports', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  conversationId: uuid('conversation_id').notNull().references(() => messageConversations.id, { onDelete: 'cascade' }),
  reporterId: uuid('reporter_id').notNull(),
  reason: text('reason').notNull().default(''),
  status: text('status').notNull().default('open'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
},
  (table) => [
      index('message_conversation_reports_conversation_id_idx').on(table.conversationId),
      index('message_conversation_reports_reporter_id_idx').on(table.reporterId),
  ]);


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
  /**
   * Tenant của ngữ cảnh sinh notification (TENANT-1, #196): điểm tạo gắn
   * tenant đang hiệu lực (ngữ cảnh khoá/sự kiện sinh ra nó); hàng không
   * gắn tenant chỉ hiển thị ở ngữ cảnh platform theo policy fail-closed.
   */
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
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
      index('notifications_tenant_id_idx').on(table.tenantId),
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
    /** Tenant của notification gốc (TENANT-1, #196) — dedupe + quét phát theo tenant. */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    subject: text('subject').notNull().default(''),
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
      index('notification_dispatch_log_notification_id_idx').on(table.notificationId),
      index('notification_dispatch_log_user_id_idx').on(table.userId),
      index('notification_dispatch_log_tenant_id_idx').on(table.tenantId),unique('notification_dispatch_log_dedupe_unique').on(table.dedupeKey)],
);
