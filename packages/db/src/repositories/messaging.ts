import {
  sql,
  type Expression,
  type Insertable,
  type RawBuilder,
  type SqlBool,
} from 'kysely';
import type { CentreDb, CentreTx, CentreDB } from '../client';

/**
 * Kho dữ liệu nhắn tin và thông báo trên Kysely (issue #658, nhóm
 * G11 — nhóm cuối của chiến dịch chuyển tầng dữ liệu sang Kysely):
 * chuyển nguyên vẹn bề mặt của `MessagingRepository` cũ ở
 * `apps/api` (bộ máy cũ, 2.250 dòng) sang đây — conversation, thành
 * viên, message, block, notification, nhật ký dispatch, cùng các
 * phép đọc bảng dùng chung (role/context/enrol/ghi danh/lớp/khoá)
 * mà các cổng nghiệp vụ của messaging cần.
 *
 * Khuôn truy vấn theo đúng pilot kho control plane và các
 * repository đã chuyển trước đó:
 * - Cột đọc khai tường minh kèm bí danh camelCase dùng chung cho
 *   select và returning — KHÔNG bật CamelCasePlugin.
 * - Kiểu dòng công khai khai tay trong file này, khớp hình dạng
 *   `$inferSelect` của repository cũ để phía tiêu thụ không đổi
 *   hợp đồng.
 * - Ghi qua hàm ánh xạ Insert loại `undefined` tường minh từng
 *   trường (thử nghiệm T-4).
 * - Khoá chính `uuidv7()` do database sinh (phụ lục U): insert bỏ
 *   qua `id` khi phía gọi không cấp và lấy id qua `returning`.
 * - `count(*)` ép `::int` tường minh để giữ kiểu `number` của hợp
 *   đồng cũ (T-7).
 * - Điều kiện động dựng theo mẫu T-13: mọi điều kiện đều là biểu
 *   thức có giá trị bắt buộc, hợp bằng `eb.and(conds)`; KHÔNG bao
 *   giờ truyền `undefined` vào `where`.
 * - Ba điểm ghép đoạn động bằng `sql.join` của bản cũ (danh sách
 *   IN, WHERE, HAVING của `listNotificationGroups`) viết lại bằng
 *   `sql.join` của Kysely theo khuôn T-11, có spec riêng ở
 *   `messaging.spec.ts` (tầng biên dịch) và
 *   `messaging.int-spec.ts` (kết quả thật).
 *
 * GỠ VÒNG PHỤ THUỘC `@lms/db` ↔ `@lms/messaging`: bề mặt đọc dùng
 * chung của messaging (luật đọc tin/hội thoại cho cả đường REST
 * phía API và consumer phân phối phía worker) vẫn cài đặt tại
 * `@lms/messaging` dưới dạng hàm thuần nhận handle Kysely. File
 * này KHAI cổng {@link MessagingStorePort} cho đúng bề mặt đó;
 * repository nhận cài đặt của cổng qua constructor và uỷ quyền
 * mọi phép đọc dùng chung qua cổng — `@lms/db` không import
 * `@lms/messaging` ở bất kỳ dạng nào, còn `@lms/messaging` chỉ
 * import type-only từ file này (kiểu dòng + cổng), nên đồ thị
 * phụ thuộc là DAG. Các helper thuần chuỗi của họ excerpt
 * (`quoteExcerptOf`, `searchExcerptOf`) ở lại `@lms/messaging`
 * vì chúng là logic hình dạng wire, không phải truy cập dữ liệu.
 *
 * RANH GIỚI NGỮ CẢNH: repository này KHÔNG đọc ALS hay bất kỳ
 * ngữ cảnh app nào. Chín method của cụm notification nhận tham
 * số `tenantId` tường minh do tầng service phía app truyền
 * xuống (service đọc ngữ cảnh tenant của request hiện hành) —
 * đúng luật của issue: đổi chỗ đọc ALS trong repository thành
 * tham số tường minh, giữ nguyên ngữ nghĩa lọc (có tenant thì
 * lọc theo tenant đó, không có thì không lọc thêm ở tầng này;
 * RLS fail-closed là lưới cứng phía sau).
 *
 * Mọi truy vấn thuần dữ liệu; quy tắc nghiệp vụ nằm ở tầng
 * service phía ứng dụng.
 */

/** Handle kho trung tâm mà repository chấp nhận: thường hoặc trong giao dịch. */
export type MessagingDb = CentreDb | CentreTx;
/** Handle giao dịch kho trung tâm. */
export type MessagingTx = CentreTx;

// ---------------------------------------------------------------------------
// Kiểu dòng đọc (hợp đồng công khai — khớp `$inferSelect` của repository cũ)
// ---------------------------------------------------------------------------

/** Dòng `message_conversations`. */
export interface ConversationRow {
  id: string;
  type: number;
  name: string | null;
  component: string | null;
  itemType: string | null;
  itemId: string | null;
  contextId: string | null;
  enabled: boolean;
  createdBy: string | null;
  tenantId: string | null;
  lastMessageSeq: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dòng `message`. */
export interface MessageRow {
  id: string;
  conversationId: string;
  userIdFrom: string;
  subject: string;
  fullMessage: string;
  smallMessage: string;
  seq: number;
  clientMessageId: string | null;
  replyToMessageId: string | null;
  deletedAt: Date | null;
  deletedBy: string | null;
  recalledAt: Date | null;
  recalledBy: string | null;
  createdAt: Date;
}

/** Dòng `notifications`. */
export interface NotificationRow {
  id: string;
  userIdFrom: string | null;
  userIdTo: string;
  tenantId: string | null;
  subject: string;
  fullMessage: string;
  smallMessage: string;
  component: string;
  eventType: string;
  contextUrl: string | null;
  contextUrlName: string | null;
  createdAt: Date;
  timeRead: Date | null;
}

/** Dòng `notification_dispatch_log`. */
export interface DispatchLogRow {
  id: string;
  notificationId: string | null;
  userId: string;
  tenantId: string | null;
  provider: string;
  channel: string;
  status: string;
  subject: string;
  dedupeKey: string | null;
  createdAt: Date;
}

/** Dòng `message_contacts`. */
export interface ContactRow {
  userId: string;
  contactId: string;
  createdAt: Date;
}

/** Dòng `message_contact_requests`. */
export interface ContactRequestRow {
  userIdFrom: string;
  userIdTo: string;
  createdAt: Date;
}

/** Dòng `message_conversation_reports`. */
export interface ReportRow {
  id: string;
  conversationId: string;
  reporterId: string;
  reason: string;
  status: string;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/** Dòng `message_moderator_actions`. */
export interface ModeratorActionRow {
  id: string;
  messageId: string;
  conversationId: string;
  actorId: string;
  authorId: string;
  action: string;
  reason: string | null;
  messageSeq: number | null;
  createdAt: Date;
}

/** Dòng `course_groups`. */
export interface CourseGroupRow {
  id: string;
  courseId: string;
  name: string;
  idNumber: string;
  description: string;
  enrolmentKey: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Một dòng của danh sách conversation cho một user: conversation + mốc
 * đã đọc của CHÍNH user đó + số chưa đọc tính từ mốc + tin cuối. Lấy
 * bằng MỘT truy vấn (join + lateral) — thay mô hình cũ tải toàn bộ tin
 * của mọi conversation về đếm ở tầng JS.
 */
export interface ConversationSummaryRow {
  conversation: ConversationRow;
  members: string[];
  lastReadSeq: number;
  unreadCount: number;
  lastMessage: MessageRow | null;
  /** Trạng thái cá nhân của chính user trên conversation này (lát M5): mốc ghim (null = không ghim). */
  pinnedAt: Date | null;
  /** Trạng thái cá nhân (lát M5): mốc lưu trữ (null = không lưu). */
  archivedAt: Date | null;
  /** Trạng thái cá nhân (lát M5): đã tắt tiếng conversation này hay chưa. */
  muted: boolean;
}

/** Tuỳ chọn tìm nội dung tin trong một conversation (lát M4, issue #237). */
export interface MessageSearchOptions {
  /** Chuỗi con cần khớp (đã cắt khoảng trắng ở tầng service), khớp không phân biệt hoa thường. */
  query: string;
  /** Số kết quả tối đa (mặc định 20, trần 50) — kết quả mới nhất trước. */
  limit?: number;
  /**
   * Tầm nhìn truy vết của người có thẩm quyền kiểm duyệt: tìm cả
   * trên tin đã xoá mềm/đã thu hồi và bỏ qua cờ xoá-phía-mình —
   * đúng tầm nhìn của cửa sổ tin truy vết.
   */
  privileged?: boolean;
  /** Người đang tìm (chỉ áp khi không privileged): loại tin người này đã xoá-phía-mình. */
  viewerId?: string;
  /**
   * Tác giả bị loại khỏi kết quả của người thường: các phía có quan
   * hệ chặn hai chiều với người tìm — luật "liên hệ đã chặn thì ẩn
   * khỏi mọi bề mặt" áp cho cả kết quả tìm (hội thoại 1–1 đã bị cổng
   * chặn chặn ở tầng service trước khi tới đây).
   */
  excludedAuthorIds?: string[];
}

/**
 * Một dòng GỘP thô của trung tâm thông báo v2 (issue #51) từ truy vấn
 * tổng hợp: khoá gộp (loại × nguồn × ngày) + đếm + mốc của mục mới
 * nhất làm neo phân trang keyset. `sourceKey` là `contextUrl` đã
 * chuẩn hoá ('' khi thông báo không có ngữ cảnh đích); `day` là ngày
 * lịch Asia/Saigon dạng YYYY-MM-DD.
 */
export interface NotificationGroupAggregateRow {
  eventType: string;
  component: string;
  sourceKey: string;
  day: string;
  count: number;
  unreadCount: number;
  latestAt: Date;
  latestId: string;
}

/** Bộ lọc của danh sách thông báo phẳng v2 (mở chi tiết một dòng gộp hoặc lọc theo nhóm). */
export interface NotificationItemsOptions {
  /** Lọc đúng một loại sự kiện. */
  eventType?: string;
  /** Lọc theo tập loại của một nhóm (học tập / lớp & mọi người / hệ thống). */
  eventTypes?: string[];
  /** Nguồn: undefined = không lọc, null = chỉ mục không có contextUrl, chuỗi = contextUrl cụ thể. */
  source?: string | null;
  /** Ngày lịch Asia/Saigon dạng YYYY-MM-DD. */
  day?: string;
  unreadOnly?: boolean;
  /** Neo keyset: chỉ lấy mục "cũ hơn" mốc (createdAt, id) này. */
  cursor?: { createdAt: Date; id: string };
  limit: number;
}

/** Tuỳ chọn cửa sổ tin theo cursor seq (bề mặt đọc dùng chung của `@lms/messaging`). */
export interface MessageWindowOptions {
  /** Chỉ lấy tin có seq nhỏ hơn mốc này (tải lịch sử cũ hơn). */
  beforeSeq?: number;
  /** Chỉ lấy tin có seq lớn hơn mốc này (đồng bộ phần thiếu). */
  afterSeq?: number;
  /** Số tin tối đa trong cửa sổ (mặc định 50, trần 100). */
  limit?: number;
  /**
   * Kèm cả tin đã xoá mềm (mặc định KHÔNG): chỉ các cửa sổ truy vết của
   * người có thẩm quyền (giáo viên phụ trách/quản trị) mới bật — mọi
   * đường đọc thường của thành viên luôn lọc bỏ tin đã xoá.
   */
  includeDeleted?: boolean;
  /**
   * Người đang xem (vòng đời tin nhắn theo vai): khi có mặt và KHÔNG
   * ở chế độ truy vết (includeDeleted), cửa sổ lọc bỏ thêm các tin
   * người này đã XOÁ-PHÍA-MÌNH (bảng `message_user_deletions`) — cờ
   * cá nhân chỉ áp cho đúng chủ nhân của nó, không ai khác bị ảnh
   * hưởng. Chế độ truy vết bỏ qua cờ này: dấu vết phải đầy đủ.
   */
  viewerId?: string;
}

/**
 * Khối tóm tắt TRÍCH DẪN của một tin gốc (lát M3, issue #229) — hình
 * dạng khớp `messageQuoteSchema` của @lms/contracts (khai báo ở đây
 * để tầng dữ liệu là nguồn định nghĩa duy nhất của hình dạng dòng;
 * `@lms/messaging` re-export cho các phía tiêu thụ hiện hữu).
 */
export interface MessageQuoteView {
  id: string;
  seq: number;
  userIdFrom: string;
  excerpt: string;
  unavailable: boolean;
}

/** Một dòng tin kèm khối trích dẫn đã dựng sẵn cho người nhận (`replyTo = null` khi không trích dẫn). */
export type MessageWithQuoteRow = MessageRow & { replyTo: MessageQuoteView | null };

/**
 * Các archetype vai trò được coi là "staff" cho các cổng nghiệp vụ của
 * Lớp B (tạo nhóm tự do, quản lý conversation): quản lý, người tạo
 * khoá, giáo viên có/không quyền sửa. Học sinh (archetype student) và
 * các vai trò mặc định (user/guest) KHÔNG nằm trong tập này.
 */
export const STAFF_ARCHETYPES = ['manager', 'coursecreator', 'editingteacher', 'teacher'] as const;

// ---------------------------------------------------------------------------
// Cổng bề mặt đọc dùng chung (gỡ vòng @lms/db ↔ @lms/messaging)
// ---------------------------------------------------------------------------

/**
 * Cổng của tầng store đọc dùng chung: đúng 13 phép đọc mà repository
 * uỷ quyền sang cài đặt tại `@lms/messaging` (hàm thuần nhận handle
 * Kysely, xem `distribution-store.ts` của package đó). Phía app gắn
 * cài đặt qua `createMessagingStore(handle)` khi dựng repository;
 * phía worker tiêu thụ cùng các hàm thuần qua bề mặt phân phối hẹp
 * hơn của nó. Repository KHÔNG tự import cài đặt — chiều phụ thuộc
 * duy nhất là `@lms/messaging` → (type-only) file này.
 */
export interface MessagingStorePort {
  /** Lấy conversation theo id. */
  getConversationById(id: string): Promise<ConversationRow | undefined>;
  /** Thành viên của conversation. */
  listConversationMemberIds(conversationId: string): Promise<string[]>;
  /** Tenant của một conversation — nguồn tenant cho notification tin nhắn mới. */
  getConversationTenantId(conversationId: string): Promise<string | null>;
  /** Lấy tin nhắn theo id. */
  getMessageById(id: string): Promise<MessageRow | undefined>;
  /** Lấy nhiều dòng tin theo id (kiểm tra thẩm quyền hàng loạt trước khi gỡ). */
  getMessagesByIds(ids: string[]): Promise<MessageRow[]>;
  /** Trong tập id này, các tin user đã đặt cờ xoá-phía-mình. */
  listDeletedForUserIds(messageIds: string[], userId: string): Promise<Set<string>>;
  /** Gắn khối trích dẫn cho một lô tin theo quyền của người nhận. */
  attachQuotesToRows(rows: MessageRow[], opts: { privileged: boolean; viewerId?: string }): Promise<MessageWithQuoteRow[]>;
  /** Mốc đã đọc của một thành viên (undefined nếu không phải thành viên). */
  getMemberLastReadSeq(conversationId: string, userId: string): Promise<number | undefined>;
  /** Số tin chưa đọc của MỘT user trong MỘT conversation theo vũ trụ đếm chuẩn. */
  countUnreadForConversation(conversationId: string, userId: string): Promise<number>;
  /** Một cửa sổ tin của conversation theo cursor seq, luôn trả tăng dần theo seq. */
  listMessagesPage(conversationId: string, opts?: MessageWindowOptions): Promise<MessageRow[]>;
  /** Danh sách user bị chặn bởi user này. */
  listBlockedUserIds(userId: string): Promise<string[]>;
  /** Danh sách user ĐÃ CHẶN user này (chiều ngược). */
  listBlockerUserIds(userId: string): Promise<string[]>;
  /** Mọi user đang có quan hệ chặn với user này ở bất kỳ chiều nào. */
  listBlockedCounterpartIds(userId: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// Kiểu ghi vào (khớp `$inferInsert` của repository cũ)
// ---------------------------------------------------------------------------

/** Giá trị chèn `message_conversations` (id do database sinh bằng uuidv7 khi không cấp). */
export interface NewConversation {
  id?: string;
  type?: number;
  name?: string | null;
  component?: string | null;
  itemType?: string | null;
  itemId?: string | null;
  contextId?: string | null;
  enabled?: boolean;
  createdBy?: string | null;
  tenantId?: string | null;
  lastMessageSeq?: number;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

/** Giá trị chèn `message` (id do database sinh bằng uuidv7 khi không cấp). */
export interface NewMessage {
  id?: string;
  conversationId: string;
  userIdFrom: string;
  subject?: string;
  fullMessage?: string;
  smallMessage?: string;
  seq: number;
  clientMessageId?: string | null;
  replyToMessageId?: string | null;
  deletedAt?: Date | string | null;
  deletedBy?: string | null;
  recalledAt?: Date | string | null;
  recalledBy?: string | null;
  createdAt?: Date | string;
}

/** Giá trị chèn `notifications` (id do database sinh bằng uuidv7 khi không cấp). */
export interface NewNotification {
  id?: string;
  userIdFrom?: string | null;
  userIdTo: string;
  tenantId?: string | null;
  subject?: string;
  fullMessage?: string;
  smallMessage?: string;
  component?: string;
  eventType?: string;
  contextUrl?: string | null;
  contextUrlName?: string | null;
  createdAt?: Date | string;
  timeRead?: Date | string | null;
}

/** Giá trị chèn `message_conversation_reports` (id do database sinh bằng uuidv7 khi không cấp). */
export interface NewReport {
  id?: string;
  conversationId: string;
  reporterId: string;
  reason?: string;
  status?: string;
  resolvedBy?: string | null;
  resolvedAt?: Date | string | null;
  createdAt?: Date | string;
}

/** Giá trị chèn `notification_dispatch_log` (id do database sinh bằng uuidv7 khi không cấp). */
export interface NewDispatchLog {
  id?: string;
  notificationId?: string | null;
  userId: string;
  tenantId?: string | null;
  provider: string;
  channel: string;
  status: string;
  subject?: string;
  dedupeKey?: string | null;
  createdAt?: Date | string;
}

/** Giá trị chèn một dòng dấu vết hành động kiểm duyệt (`message_moderator_actions`). */
export interface NewModeratorAction {
  messageId: string;
  conversationId: string;
  actorId: string;
  authorId: string;
  action: 'recall' | 'hard_delete' | 'bulk_hard_delete';
  reason?: string | null;
  messageSeq?: number | null;
}

// ---------------------------------------------------------------------------
// Danh sách cột đọc (dùng chung cho select và returning)
// ---------------------------------------------------------------------------

const CONVERSATION_COLUMNS = [
  'id',
  'type',
  'name',
  'component',
  'item_type as itemType',
  'item_id as itemId',
  'context_id as contextId',
  'enabled',
  'created_by as createdBy',
  'tenant_id as tenantId',
  'last_message_seq as lastMessageSeq',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

/** Như {@link CONVERSATION_COLUMNS} nhưng đủ tiền tố bảng — dùng ở truy vấn có join với bảng thành viên. */
const CONVERSATION_COLUMNS_QUALIFIED = [
  'message_conversations.id as id',
  'message_conversations.type as type',
  'message_conversations.name as name',
  'message_conversations.component as component',
  'message_conversations.item_type as itemType',
  'message_conversations.item_id as itemId',
  'message_conversations.context_id as contextId',
  'message_conversations.enabled as enabled',
  'message_conversations.created_by as createdBy',
  'message_conversations.tenant_id as tenantId',
  'message_conversations.last_message_seq as lastMessageSeq',
  'message_conversations.created_at as createdAt',
  'message_conversations.updated_at as updatedAt',
] as const;

const MESSAGE_COLUMNS = [
  'id',
  'conversation_id as conversationId',
  'user_id_from as userIdFrom',
  'subject',
  'full_message as fullMessage',
  'small_message as smallMessage',
  'seq',
  'client_message_id as clientMessageId',
  'reply_to_message_id as replyToMessageId',
  'deleted_at as deletedAt',
  'deleted_by as deletedBy',
  'recalled_at as recalledAt',
  'recalled_by as recalledBy',
  'created_at as createdAt',
] as const;

const NOTIFICATION_COLUMNS = [
  'id',
  'user_id_from as userIdFrom',
  'user_id_to as userIdTo',
  'tenant_id as tenantId',
  'subject',
  'full_message as fullMessage',
  'small_message as smallMessage',
  'component',
  'event_type as eventType',
  'context_url as contextUrl',
  'context_url_name as contextUrlName',
  'created_at as createdAt',
  'time_read as timeRead',
] as const;

const DISPATCH_LOG_COLUMNS = [
  'id',
  'notification_id as notificationId',
  'user_id as userId',
  'tenant_id as tenantId',
  'provider',
  'channel',
  'status',
  'subject',
  'dedupe_key as dedupeKey',
  'created_at as createdAt',
] as const;

const CONTACT_REQUEST_COLUMNS = [
  'user_id_from as userIdFrom',
  'user_id_to as userIdTo',
  'created_at as createdAt',
] as const;

const REPORT_COLUMNS = [
  'id',
  'conversation_id as conversationId',
  'reporter_id as reporterId',
  'reason',
  'status',
  'resolved_by as resolvedBy',
  'resolved_at as resolvedAt',
  'created_at as createdAt',
] as const;

const MODERATOR_ACTION_COLUMNS = [
  'id',
  'message_id as messageId',
  'conversation_id as conversationId',
  'actor_id as actorId',
  'author_id as authorId',
  'action',
  'reason',
  'message_seq as messageSeq',
  'created_at as createdAt',
] as const;

const COURSE_GROUP_COLUMNS = [
  'id',
  'course_id as courseId',
  'name',
  'id_number as idNumber',
  'description',
  'enrolment_key as enrolmentKey',
  'created_at as createdAt',
  'updated_at as updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Ánh xạ ghi: loại `undefined` tường minh từng trường (T-4).
// ---------------------------------------------------------------------------

function conversationInsertValues(v: NewConversation): Insertable<CentreDB['message_conversations']> {
  const row: Insertable<CentreDB['message_conversations']> = {};
  if (v.id !== undefined) row.id = v.id;
  if (v.type !== undefined) row.type = v.type;
  if (v.name !== undefined) row.name = v.name;
  if (v.component !== undefined) row.component = v.component;
  if (v.itemType !== undefined) row.item_type = v.itemType;
  if (v.itemId !== undefined) row.item_id = v.itemId;
  if (v.contextId !== undefined) row.context_id = v.contextId;
  if (v.enabled !== undefined) row.enabled = v.enabled;
  if (v.createdBy !== undefined) row.created_by = v.createdBy;
  if (v.tenantId !== undefined) row.tenant_id = v.tenantId;
  if (v.lastMessageSeq !== undefined) row.last_message_seq = v.lastMessageSeq;
  if (v.createdAt !== undefined) row.created_at = v.createdAt;
  if (v.updatedAt !== undefined) row.updated_at = v.updatedAt;
  return row;
}

function messageInsertValues(v: NewMessage): Insertable<CentreDB['message']> {
  const row: Insertable<CentreDB['message']> = {
    conversation_id: v.conversationId,
    user_id_from: v.userIdFrom,
    seq: v.seq,
  };
  if (v.id !== undefined) row.id = v.id;
  if (v.subject !== undefined) row.subject = v.subject;
  if (v.fullMessage !== undefined) row.full_message = v.fullMessage;
  if (v.smallMessage !== undefined) row.small_message = v.smallMessage;
  if (v.clientMessageId !== undefined) row.client_message_id = v.clientMessageId;
  if (v.replyToMessageId !== undefined) row.reply_to_message_id = v.replyToMessageId;
  if (v.deletedAt !== undefined) row.deleted_at = v.deletedAt;
  if (v.deletedBy !== undefined) row.deleted_by = v.deletedBy;
  if (v.recalledAt !== undefined) row.recalled_at = v.recalledAt;
  if (v.recalledBy !== undefined) row.recalled_by = v.recalledBy;
  if (v.createdAt !== undefined) row.created_at = v.createdAt;
  return row;
}

function notificationInsertValues(v: NewNotification): Insertable<CentreDB['notifications']> {
  const row: Insertable<CentreDB['notifications']> = {
    user_id_to: v.userIdTo,
  };
  if (v.id !== undefined) row.id = v.id;
  if (v.userIdFrom !== undefined) row.user_id_from = v.userIdFrom;
  if (v.tenantId !== undefined) row.tenant_id = v.tenantId;
  if (v.subject !== undefined) row.subject = v.subject;
  if (v.fullMessage !== undefined) row.full_message = v.fullMessage;
  if (v.smallMessage !== undefined) row.small_message = v.smallMessage;
  if (v.component !== undefined) row.component = v.component;
  if (v.eventType !== undefined) row.event_type = v.eventType;
  if (v.contextUrl !== undefined) row.context_url = v.contextUrl;
  if (v.contextUrlName !== undefined) row.context_url_name = v.contextUrlName;
  if (v.createdAt !== undefined) row.created_at = v.createdAt;
  if (v.timeRead !== undefined) row.time_read = v.timeRead;
  return row;
}

function reportInsertValues(v: NewReport): Insertable<CentreDB['message_conversation_reports']> {
  const row: Insertable<CentreDB['message_conversation_reports']> = {
    conversation_id: v.conversationId,
    reporter_id: v.reporterId,
  };
  if (v.id !== undefined) row.id = v.id;
  if (v.reason !== undefined) row.reason = v.reason;
  if (v.status !== undefined) row.status = v.status;
  if (v.resolvedBy !== undefined) row.resolved_by = v.resolvedBy;
  if (v.resolvedAt !== undefined) row.resolved_at = v.resolvedAt;
  if (v.createdAt !== undefined) row.created_at = v.createdAt;
  return row;
}

function dispatchLogInsertValues(v: NewDispatchLog): Insertable<CentreDB['notification_dispatch_log']> {
  const row: Insertable<CentreDB['notification_dispatch_log']> = {
    user_id: v.userId,
    provider: v.provider,
    channel: v.channel,
    status: v.status,
  };
  if (v.id !== undefined) row.id = v.id;
  if (v.notificationId !== undefined) row.notification_id = v.notificationId;
  if (v.tenantId !== undefined) row.tenant_id = v.tenantId;
  if (v.subject !== undefined) row.subject = v.subject;
  if (v.dedupeKey !== undefined) row.dedupe_key = v.dedupeKey;
  if (v.createdAt !== undefined) row.created_at = v.createdAt;
  return row;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Kho dữ liệu nhắn tin và thông báo: conversation, thành viên, message, block, notification, tuỳ chọn kênh và nhật ký dispatch. */
export class MessagingRepository {
  constructor(
    private readonly handle: CentreDb,
    private readonly store: MessagingStorePort,
  ) {}

  /** Mở một transaction trên kho trung tâm (thay `dbHandle.transaction` của bản bộ máy cũ). */
  async transaction<T>(fn: (tx: MessagingTx) => Promise<T>): Promise<T> {
    return this.handle.transaction().execute(fn);
  }

  /**
   * Chèn conversation.
   */
  async insertConversation(v: NewConversation, tx?: MessagingDb): Promise<ConversationRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('message_conversations')
      .values(conversationInsertValues(v))
      .returning(CONVERSATION_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<ConversationRow>;
  }
  /**
   * Lấy conversation theo id. Cài đặt truy vấn ở bề mặt đọc dùng
   * chung `@lms/messaging` — repository chỉ uỷ quyền qua cổng
   * {@link MessagingStorePort} (issue #521).
   */
  async getConversation(id: string): Promise<ConversationRow | undefined> {
    return this.store.getConversationById(id);
  }
  /**
   * Thêm thành viên conversation.
   */
  async addMember(conversationId: string, userId: string, tx?: MessagingDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .insertInto('message_conversation_members')
      .values({ conversation_id: conversationId, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  /**
   * Gỡ một thành viên khỏi conversation (dùng cho đồng bộ group conversation:
   * người rời group thì rời conversation, tin nhắn cũ giữ nguyên).
   */
  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.handle
      .deleteFrom('message_conversation_members')
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .execute();
  }
  /**
   * Thành viên của conversation. Cài đặt truy vấn ở bề mặt đọc dùng
   * chung `@lms/messaging` — repository chỉ uỷ quyền (issue #521).
   */
  async listMembers(conversationId: string): Promise<string[]> {
    return this.store.listConversationMemberIds(conversationId);
  }
  /**
   * User có thuộc conversation hay không.
   */
  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const rows = await this.handle
      .selectFrom('message_conversation_members')
      .select('user_id')
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .execute();
    return rows.length > 0;
  }
  /**
   * Conversation của user, mới nhất trước (một truy vấn join).
   */
  async listConversationsForUser(userId: string): Promise<ConversationRow[]> {
    return this.handle
      .selectFrom('message_conversation_members')
      .innerJoin('message_conversations', 'message_conversations.id', 'message_conversation_members.conversation_id')
      .select(CONVERSATION_COLUMNS_QUALIFIED)
      .where('message_conversation_members.user_id', '=', userId)
      .orderBy('message_conversations.updated_at', 'desc')
      .execute() as Promise<ConversationRow[]>;
  }
  /**
   * Danh sách conversation kèm số chưa đọc + tin cuối cho một user —
   * MỘT truy vấn duy nhất: unread đếm bằng count(*) theo mốc last-read
   * của chính user, tin cuối lấy bằng lateral theo seq.
   *
   * Lát M5 (issue #240): kèm ba trạng thái cá nhân của chính user;
   * mặc định CHỈ các conversation chưa lưu trữ, `archivedOnly` thì
   * chỉ các conversation ĐÃ lưu — hai mục không bao giờ trộn nhau.
   * Thứ tự: conversation ĐÃ GHIM lên đầu (trong nhóm ghim vẫn theo
   * hoạt động gần nhất), còn lại theo hoạt động gần nhất.
   *
   * Vũ trụ đếm chuẩn (issue #592): `unread` ở đây là số chưa đọc
   * THEO VŨ TRỤ CHUẨN — hội thoại đã tắt tiếng trả 0 dù tin chưa
   * đọc vẫn còn, để mọi bề mặt suy từ danh sách này (huy hiệu đầu
   * trang, huy hiệu hàng, chip lọc, cây nhóm) khớp với huy hiệu
   * thanh bên mà không cần lọc lại ở client. Hội thoại 1–1 bị ẩn
   * do chặn không xuất hiện trong danh sách nên cũng không đóng
   * góp số. Mốc đã đọc và tin cuối không bị ảnh hưởng: bật tiếng
   * lại thì số thật hiện lại ngay.
   */
  async listConversationSummaries(userId: string, opts: { archivedOnly?: boolean } = {}): Promise<ConversationSummaryRow[]> {
    const archivedClause = opts.archivedOnly
      ? sql`AND mine.archived_at IS NOT NULL`
      : sql`AND mine.archived_at IS NULL`;
    const executed = await sql<Record<string, unknown>>`
      SELECT c.id AS conversation_id, c.type AS conversation_type, c.name AS conversation_name,
        c.component AS conversation_component, c.item_type AS conversation_item_type,
        c.item_id AS conversation_item_id, c.context_id AS conversation_context_id,
        c.enabled AS conversation_enabled, c.created_by AS conversation_created_by,
        c.tenant_id AS conversation_tenant_id,
        c.last_message_seq AS conversation_last_seq,
        c.created_at AS conversation_created_at, c.updated_at AS conversation_updated_at,
        mine.last_read_seq AS last_read_seq,
        mine.pinned_at AS pinned_at, mine.archived_at AS archived_at, mine.muted AS muted,
        COALESCE(mem.members, ARRAY[]::uuid[]) AS members,
        COALESCE(u.unread, 0)::int AS unread_count,
        lm.last_message AS last_message
      FROM message_conversation_members mine
      JOIN message_conversations c ON c.id = mine.conversation_id
      LEFT JOIN LATERAL (
        SELECT array_agg(user_id ORDER BY created_at, user_id) AS members
        FROM message_conversation_members WHERE conversation_id = c.id
      ) mem ON true
      LEFT JOIN LATERAL (
        SELECT CASE WHEN mine.muted THEN 0 ELSE count(*) END AS unread FROM message msg
        WHERE msg.conversation_id = c.id AND msg.seq > mine.last_read_seq AND msg.user_id_from <> mine.user_id
          AND msg.deleted_at IS NULL
          -- Tin đã THU HỒI không còn nội dung để đọc — không đếm chưa
          -- đọc; tin người xem đã xoá-phía-mình cũng ra khỏi tầm nhìn
          -- của chính họ nên không đếm (vòng đời theo vai, #33).
          AND msg.recalled_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM message_user_deletions d
            WHERE d.message_id = msg.id AND d.user_id = mine.user_id
          )
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT to_jsonb(msg) AS last_message FROM message msg
        WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL
          -- Tin cuối là tin cuối CÒN HIỂN THỊ với chính người xem:
          -- tin họ đã xoá-phía-mình không được làm xem trước của họ.
          -- Tin đã thu hồi VẪN được chọn (nội dung bị vô hiệu hoá ở
          -- tầng service — xem trước hiện dòng thu hồi, không lùi về
          -- tin cũ hơn như thể cuộc trò chuyện trống rỗng đi).
          AND NOT EXISTS (
            SELECT 1 FROM message_user_deletions d
            WHERE d.message_id = msg.id AND d.user_id = mine.user_id
          )
        ORDER BY msg.seq DESC LIMIT 1
      ) lm ON true
      WHERE mine.user_id = ${userId}
        ${archivedClause}
        -- Chuẩn app nhắn tin (chốt bổ sung trên issue #33, 24/10/2026):
        -- có quan hệ chặn ở BẤT KỲ chiều nào thì conversation 1–1 bị
        -- ẨN khỏi danh sách của CẢ HAI phía (dữ liệu giữ nguyên, bỏ
        -- chặn là hiện lại). Conversation nhóm không bị luật này chạm.
        AND NOT (c.type = 1 AND EXISTS (
          SELECT 1 FROM message_conversation_members other_m
          JOIN message_users_blocked b
            ON (b.user_id = mine.user_id AND b.blocked_user_id = other_m.user_id)
            OR (b.user_id = other_m.user_id AND b.blocked_user_id = mine.user_id)
          WHERE other_m.conversation_id = c.id AND other_m.user_id <> mine.user_id
        ))
      ORDER BY (mine.pinned_at IS NOT NULL) DESC, c.updated_at DESC
    `.execute(this.handle);
    return executed.rows.map((raw) => {
      const lastMessageRaw = raw.last_message as Record<string, unknown> | null;
      return {
        conversation: {
          id: raw.conversation_id as string,
          type: raw.conversation_type as number,
          name: raw.conversation_name as string | null,
          component: raw.conversation_component as string | null,
          itemType: raw.conversation_item_type as string | null,
          itemId: raw.conversation_item_id as string | null,
          contextId: raw.conversation_context_id as string | null,
          enabled: raw.conversation_enabled as boolean,
          createdBy: (raw.conversation_created_by as string | null) ?? null,
          tenantId: (raw.conversation_tenant_id as string | null) ?? null,
          lastMessageSeq: raw.conversation_last_seq as number,
          createdAt: new Date(raw.conversation_created_at as string),
          updatedAt: new Date(raw.conversation_updated_at as string),
        },
        members: (raw.members as string[]) ?? [],
        lastReadSeq: raw.last_read_seq as number,
        unreadCount: raw.unread_count as number,
        pinnedAt: raw.pinned_at ? new Date(raw.pinned_at as string) : null,
        archivedAt: raw.archived_at ? new Date(raw.archived_at as string) : null,
        muted: raw.muted === true,
        lastMessage: lastMessageRaw
          ? {
              id: lastMessageRaw.id as string,
              conversationId: lastMessageRaw.conversation_id as string,
              userIdFrom: lastMessageRaw.user_id_from as string,
              subject: lastMessageRaw.subject as string,
              fullMessage: lastMessageRaw.full_message as string,
              smallMessage: lastMessageRaw.small_message as string,
              seq: lastMessageRaw.seq as number,
              clientMessageId: (lastMessageRaw.client_message_id as string | null) ?? null,
              replyToMessageId: (lastMessageRaw.reply_to_message_id as string | null) ?? null,
              deletedAt: lastMessageRaw.deleted_at ? new Date(lastMessageRaw.deleted_at as string) : null,
              deletedBy: (lastMessageRaw.deleted_by as string | null) ?? null,
              recalledAt: lastMessageRaw.recalled_at ? new Date(lastMessageRaw.recalled_at as string) : null,
              recalledBy: (lastMessageRaw.recalled_by as string | null) ?? null,
              createdAt: new Date(lastMessageRaw.created_at as string),
            }
          : null,
      };
    });
  }
  /**
   * Tìm conversation 1-1 giữa hai user.
   */
  async findIndividualConversation(a: string, b: string): Promise<ConversationRow | undefined> {
    const mine = await this.listConversationsForUser(a);
    for (const c of mine) {
      if (c.type !== 1) continue;
      const members = await this.listMembers(c.id);
      if (members.length === 2 && members.includes(b)) return c;
    }
    return undefined;
  }
  /**
   * Cấp seq tiếp theo cho một tin mới trong conversation: tăng bộ đếm
   * trên dòng conversation và chạm updated_at trong CÙNG một lệnh
   * UPDATE — khoá dòng của UPDATE khiến các transaction gửi đồng thời
   * xếp hàng trên dòng này, seq không bao giờ trùng hay nhảy cóc.
   * Phải gọi trong transaction sẽ chèn tin (seq và tin commit cùng lúc).
   */
  async allocateNextSeq(conversationId: string, tx: MessagingTx): Promise<number> {
    const row = await tx
      .updateTable('message_conversations')
      .set({ last_message_seq: sql<number>`last_message_seq + 1`, updated_at: new Date() })
      .where('id', '=', conversationId)
      .returning('last_message_seq as seq')
      .executeTakeFirstOrThrow();
    return row.seq;
  }

  /**
   * Chèn tin nhắn.
   */
  async insertMessage(v: NewMessage, tx?: MessagingDb): Promise<MessageRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('message')
      .values(messageInsertValues(v))
      .returning(MESSAGE_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<MessageRow>;
  }
  /**
   * Lấy tin nhắn theo id. Cài đặt truy vấn ở bề mặt đọc dùng
   * chung `@lms/messaging` — repository chỉ uỷ quyền (issue #521).
   */
  async getMessage(id: string): Promise<MessageRow | undefined> {
    return this.store.getMessageById(id);
  }
  /**
   * Tin đã lưu với khoá chống trùng (conversation, người gửi,
   * clientMessageId) — đường tra cứu cho gửi lại idempotent.
   */
  async getMessageByClientId(conversationId: string, userIdFrom: string, clientMessageId: string): Promise<MessageRow | undefined> {
    return this.handle
      .selectFrom('message')
      .select(MESSAGE_COLUMNS)
      .where('conversation_id', '=', conversationId)
      .where('user_id_from', '=', userIdFrom)
      .where('client_message_id', '=', clientMessageId)
      .executeTakeFirst() as Promise<MessageRow | undefined>;
  }
  /**
   * Một cửa sổ tin của conversation theo cursor seq, luôn trả tăng dần
   * theo seq. Không cursor: cửa sổ MỚI NHẤT (limit tin cuối). beforeSeq:
   * cửa sổ ngay trước mốc. afterSeq: các tin sau mốc (đồng bộ thiếu
   * hụt). Cài đặt truy vấn ở bề mặt đọc dùng chung `@lms/messaging` —
   * repository chỉ uỷ quyền (issue #521).
   */
  async listMessages(conversationId: string, opts: MessageWindowOptions = {}): Promise<MessageRow[]> {
    return this.store.listMessagesPage(conversationId, opts);
  }
  /**
   * Tìm nội dung tin trong MỘT conversation (lát M4, issue #237):
   * khớp chuỗi con trên `full_message` bằng ILIKE (không phân biệt
   * hoa thường), kết quả mới nhất (seq cao nhất) trước. Tầm nhìn
   * khóa theo ĐÚNG luật bề mặt đọc hiện hành: người thường chỉ khớp
   * tin còn hiển thị với chính họ — tin đã xoá mềm, đã THU HỒI (nội
   * dung đã vô hiệu: khớp trên nội dung gốc của tin thu hồi sẽ lộ
   * rằng nội dung đó từng tồn tại), tin họ đã xoá-phía-mình, và tin
   * của phía có quan hệ chặn hai chiều đều bị loại NGAY TẠI SQL.
   * Người có thẩm quyền (privileged) tìm theo tầm nhìn truy vết.
   * Ký tự đặc biệt của mẫu LIKE trong truy vấn của người dùng được
   * thoát để tìm là tìm CHUỖI CON đúng nghĩa, không phải mẫu.
   */
  async searchMessages(conversationId: string, opts: MessageSearchOptions): Promise<MessageRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const escaped = opts.query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    const pattern = `%${escaped}%`;
    return this.handle
      .selectFrom('message')
      .select(MESSAGE_COLUMNS)
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('conversation_id', '=', conversationId),
          sql<SqlBool>`full_message ilike ${pattern}`,
        ];
        if (!opts.privileged) {
          conds.push(eb('deleted_at', 'is', null));
          conds.push(eb('recalled_at', 'is', null));
          if (opts.viewerId) {
            const viewerId = opts.viewerId;
            conds.push(sql<SqlBool>`not exists (select 1 from message_user_deletions d where d.message_id = message.id and d.user_id = ${viewerId})`);
          }
          if (opts.excludedAuthorIds && opts.excludedAuthorIds.length > 0) {
            conds.push(eb('user_id_from', 'not in', opts.excludedAuthorIds));
          }
        }
        return eb.and(conds);
      })
      .orderBy('seq', 'desc')
      .limit(limit)
      .execute() as Promise<MessageRow[]>;
  }
  /** Còn tin cũ hơn seq này trong conversation hay không (cho nút tải thêm). */
  async hasMessagesBefore(conversationId: string, seq: number, includeDeleted = false, viewerId?: string): Promise<boolean> {
    const row = await this.handle
      .selectFrom('message')
      .select(sql<number>`count(*)::int`.as('value'))
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('conversation_id', '=', conversationId),
          eb('seq', '<', seq),
        ];
        if (!includeDeleted) conds.push(eb('deleted_at', 'is', null));
        // Cùng luật lọc xoá-phía-mình như listMessages: nếu không, mốc
        // "còn tin cũ hơn" sẽ đúng giả khi mọi tin cũ hơn đã bị chính
        // người xem ẩn đi (client tải thêm một trang rỗng vô ích).
        if (viewerId && !includeDeleted) {
          conds.push(sql<SqlBool>`not exists (select 1 from message_user_deletions d where d.message_id = message.id and d.user_id = ${viewerId})`);
        }
        return eb.and(conds);
      })
      .executeTakeFirst();
    return (row?.value ?? 0) > 0;
  }
  /**
   * Xoá mềm một tin: chỉ đánh dấu `deleted_at`/`deleted_by`, dòng tin
   * giữ nguyên nội dung phục vụ truy vết của người có thẩm quyền.
   * Tin đã xoá rồi thì giữ nguyên dấu vết lần xoá đầu (idempotent ở
   * tầng service).
   */
  async softDeleteMessage(id: string, deletedBy: string): Promise<MessageRow | undefined> {
    return this.handle
      .updateTable('message')
      .set({ deleted_at: new Date(), deleted_by: deletedBy })
      .where('id', '=', id)
      .returning(MESSAGE_COLUMNS)
      .executeTakeFirst() as Promise<MessageRow | undefined>;
  }
  /**
   * Đặt cờ XOÁ-PHÍA-MÌNH cho một user trên một tin (lớp (a) của vòng
   * đời theo vai): idempotent — đặt lại cùng cờ là no-op nhờ PK phức
   * hợp + onConflictDoNothing. Chỉ ẩn tin khỏi tầm nhìn của chính
   * user đó; không đụng tới dòng tin.
   */
  async markDeletedForUser(messageId: string, userId: string): Promise<void> {
    await this.handle
      .insertInto('message_user_deletions')
      .values({ message_id: messageId, user_id: userId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  /** User này đã đặt cờ xoá-phía-mình trên tin này chưa. */
  async isDeletedForUser(messageId: string, userId: string): Promise<boolean> {
    const rows = await this.handle
      .selectFrom('message_user_deletions')
      .select('message_id as messageId')
      .where('message_id', '=', messageId)
      .where('user_id', '=', userId)
      .limit(1)
      .execute();
    return rows.length > 0;
  }
  /**
   * Áp dấu THU HỒI lên dòng tin (lớp (b)): chỉ set hai cột dấu vết,
   * nội dung giữ nguyên trong DB — việc vô hiệu hoá nội dung thuộc
   * về đường đọc (người xem thường) và đường phân phối realtime.
   */
  async applyRecall(id: string, recalledBy: string): Promise<MessageRow | undefined> {
    return this.handle
      .updateTable('message')
      .set({ recalled_at: new Date(), recalled_by: recalledBy })
      .where('id', '=', id)
      .returning(MESSAGE_COLUMNS)
      .executeTakeFirst() as Promise<MessageRow | undefined>;
  }
  /**
   * Xoá CỨNG một dòng tin (lớp (c)): xoá vật lý; các cờ xoá-phía-mình
   * cascade theo, dấu vết moderator_action KHÔNG cascade (cố ý không
   * khoá ngoại) nên vẫn còn để truy vết.
   */
  async hardDeleteMessage(id: string): Promise<void> {
    await this.handle.deleteFrom('message').where('id', '=', id).execute();
  }
  /**
   * Lấy nhiều dòng tin theo id (kiểm tra thẩm quyền hàng loạt trước
   * khi gỡ). Cài đặt truy vấn ở bề mặt đọc dùng chung `@lms/messaging`.
   */
  async getMessagesByIds(ids: string[]): Promise<MessageRow[]> {
    return this.store.getMessagesByIds(ids);
  }
  /**
   * Trong tập id này, các tin user đã đặt cờ xoá-phía-mình. Cài đặt
   * truy vấn ở bề mặt đọc dùng chung `@lms/messaging`.
   */
  async listDeletedForUserIds(messageIds: string[], userId: string): Promise<Set<string>> {
    return this.store.listDeletedForUserIds(messageIds, userId);
  }
  /**
   * Gắn khối trích dẫn (lát M3, issue #229) cho một lô tin: tra lô
   * các tin gốc một lần (không N+1), dựng quote theo quyền của người
   * nhận bằng `messageQuoteOf` của `@lms/messaging`. Tin gốc tra
   * không thấy (chỉ còn xảy ra khi khoá ngoại chưa kịp set null
   * sau xoá cứng) hoặc thuộc conversation khác (dữ liệu không thể
   * sinh qua đường gửi — gác ở service) thì `replyTo = null`: hiển
   * thị như tin thường, không dựng khối trích dẫn rỗng.
   *
   * `viewerId` chỉ áp khi KHÔNG privileged: tin gốc bị chính người
   * xem xoá-phía-mình thì quote thành unavailable như đã xoá. Đường
   * realtime phân phối theo room dùng privileged=false và KHÔNG
   * truyền viewerId (khối trích dẫn là dữ kiện chung của room; việc
   * cá nhân hoá xoá-phía-mình chốt ở các đường đọc REST/sync vốn có
   * viewerId — người đã ẩn tin gốc vốn đã thấy nó khi còn là thành
   * viên nên đây không phải kênh lộ nội dung mới).
   */
  async attachQuotes(rows: MessageRow[], opts: { privileged: boolean; viewerId?: string }): Promise<MessageWithQuoteRow[]> {
    return this.store.attachQuotesToRows(rows, opts);
  }
  /**
   * Ghi một dòng dấu vết hành động kiểm duyệt. Gọi TRƯỚC khi trạng
   * thái tin thay đổi (nhất là trước xoá cứng) để dấu vết không bao
   * giờ thiếu cho một thay đổi đã xảy ra.
   */
  async insertModeratorAction(values: NewModeratorAction): Promise<void> {
    await this.handle
      .insertInto('message_moderator_actions')
      .values({
        message_id: values.messageId,
        conversation_id: values.conversationId,
        actor_id: values.actorId,
        author_id: values.authorId,
        action: values.action,
        reason: values.reason ?? null,
        message_seq: values.messageSeq ?? null,
      })
      .execute();
  }
  /** Dấu vết kiểm duyệt của một tin (đường truy vết/test đối chiếu). */
  async listModeratorActionsForMessage(messageId: string): Promise<ModeratorActionRow[]> {
    return this.handle
      .selectFrom('message_moderator_actions')
      .select(MODERATOR_ACTION_COLUMNS)
      .where('message_id', '=', messageId)
      .orderBy('created_at', 'asc')
      .execute() as Promise<ModeratorActionRow[]>;
  }
  /** Bật/tắt chat của một conversation (giáo viên phụ trách tắt chat nhóm lớp). */
  async setConversationEnabled(id: string, enabled: boolean): Promise<ConversationRow | undefined> {
    return this.handle
      .updateTable('message_conversations')
      .set({ enabled, updated_at: new Date() })
      .where('id', '=', id)
      .returning(CONVERSATION_COLUMNS)
      .executeTakeFirst() as Promise<ConversationRow | undefined>;
  }
  /**
   * Mốc đã đọc của một thành viên (undefined nếu không phải thành
   * viên). Cài đặt truy vấn ở bề mặt đọc dùng chung `@lms/messaging`.
   */
  async getMemberLastReadSeq(conversationId: string, userId: string): Promise<number | undefined> {
    return this.store.getMemberLastReadSeq(conversationId, userId);
  }
  /**
   * Mốc đã đọc của mọi thành viên — cho client hiển thị biên "đã xem".
   */
  async listMemberReadMarkers(conversationId: string): Promise<{ userId: string; lastReadSeq: number }[]> {
    return this.handle
      .selectFrom('message_conversation_members')
      .select(['user_id as userId', 'last_read_seq as lastReadSeq'])
      .where('conversation_id', '=', conversationId)
      .execute();
  }
  /**
   * Ba trạng thái cá nhân của MỘT thành viên trên MỘT conversation
   * (lát M5, issue #240) — undefined nếu user không phải thành viên.
   */
  async getMemberConversationState(conversationId: string, userId: string): Promise<{ pinnedAt: Date | null; archivedAt: Date | null; muted: boolean } | undefined> {
    return this.handle
      .selectFrom('message_conversation_members')
      .select(['pinned_at as pinnedAt', 'archived_at as archivedAt', 'muted'])
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
  }
  /**
   * Đặt trạng thái cá nhân của CHÍNH một thành viên (lát M5): chỉ các
   * trường có mặt trong `patch` mới đổi — ghim/lưu đặt mốc thời gian
   * hiện tại khi bật và xoá mốc (null) khi tắt; tắt tiếng là cờ
   * boolean. Trả trạng thái sau khi đặt (undefined nếu không phải
   * thành viên — tầng service đã gác thành viên trước khi gọi).
   */
  async updateMemberConversationState(
    conversationId: string,
    userId: string,
    patch: { pinned?: boolean; archived?: boolean; muted?: boolean },
  ): Promise<{ pinnedAt: Date | null; archivedAt: Date | null; muted: boolean } | undefined> {
    const set: { pinned_at?: Date | null; archived_at?: Date | null; muted?: boolean } = {};
    if (patch.pinned !== undefined) set.pinned_at = patch.pinned ? new Date() : null;
    if (patch.archived !== undefined) set.archived_at = patch.archived ? new Date() : null;
    if (patch.muted !== undefined) set.muted = patch.muted;
    if (Object.keys(set).length === 0) return this.getMemberConversationState(conversationId, userId);
    return this.handle
      .updateTable('message_conversation_members')
      .set(set)
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', userId)
      .returning(['pinned_at as pinnedAt', 'archived_at as archivedAt', 'muted'])
      .executeTakeFirst();
  }
  /**
   * Các thành viên đã TẮT TIẾNG một conversation (lát M5) — consumer
   * thông báo đọc tập này MỘT lần cho mỗi sự kiện tin mới rồi bỏ qua
   * các thành viên trong tập khi sinh `message_new`.
   */
  async listMutedMemberIds(conversationId: string): Promise<string[]> {
    const rows = await this.handle
      .selectFrom('message_conversation_members')
      .select('user_id as userId')
      .where('conversation_id', '=', conversationId)
      .where('muted', '=', true)
      .execute();
    return rows.map((r) => r.userId);
  }
  /**
   * Tin mới vào conversation thì các thành viên còn lại TỰ BỎ LƯU
   * (lát M5, quyết định đã chốt: hội thoại đã lưu tự hiện lại khi có
   * tin mới): xoá `archived_at` của mọi thành viên TRỪ người gửi,
   * trong CÙNG transaction với lần chèn tin — danh sách của người
   * nhận không bao giờ ở trạng thái "có tin mới nhưng vẫn ẩn vì lưu".
   */
  async clearArchivedForIncomingMessage(conversationId: string, senderId: string, tx?: MessagingDb): Promise<void> {
    const db = tx ?? this.handle;
    await db
      .updateTable('message_conversation_members')
      .set({ archived_at: null })
      .where('conversation_id', '=', conversationId)
      .where('user_id', '<>', senderId)
      .where('archived_at', 'is not', null)
      .execute();
  }
  /**
   * Đánh dấu một thành viên đã đọc tới tin mới nhất hiện có: nâng mốc
   * last-read của RIÊNG thành viên đó lên last_message_seq của
   * conversation. Trả số tin vừa được đánh dấu (tin của người khác nằm
   * trên mốc cũ) và mốc mới.
   */
  async markConversationRead(conversationId: string, readerId: string): Promise<{ marked: number; lastReadSeq: number }> {
    const member = await this.handle
      .selectFrom('message_conversation_members')
      .select(['conversation_id as conversationId', 'user_id as userId', 'last_read_seq as lastReadSeq', 'pinned_at as pinnedAt', 'archived_at as archivedAt', 'muted', 'created_at as createdAt'])
      .where('conversation_id', '=', conversationId)
      .where('user_id', '=', readerId)
      .executeTakeFirst();
    if (!member) return { marked: 0, lastReadSeq: 0 };
    const conversation = await this.handle
      .selectFrom('message_conversations')
      .select('last_message_seq as lastMessageSeq')
      .where('id', '=', conversationId)
      .executeTakeFirst();
    const target = conversation?.lastMessageSeq ?? member.lastReadSeq;
    const unread = await this.handle
      .selectFrom('message')
      .select(sql<number>`count(*)::int`.as('value'))
      .where((eb) => eb.and([
        eb('conversation_id', '=', conversationId),
        eb('seq', '>', member.lastReadSeq),
        eb('seq', '<=', target),
        eb('user_id_from', '<>', readerId),
        eb('deleted_at', 'is', null),
        // Tin đã thu hồi/đã xoá-phía-mình không tính là "vừa đánh dấu
        // đọc" — nhất quán với mọi bộ đếm chưa đọc khác của vòng đời.
        eb('recalled_at', 'is', null),
        sql<SqlBool>`not exists (select 1 from message_user_deletions d where d.message_id = message.id and d.user_id = ${readerId})`,
      ]))
      .executeTakeFirst();
    if (target > member.lastReadSeq) {
      await this.handle
        .updateTable('message_conversation_members')
        .set({ last_read_seq: target })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', readerId)
        .execute();
    }
    return { marked: unread?.value ?? 0, lastReadSeq: target };
  }
  /**
   * Số tin chưa đọc của MỘT user trong MỘT conversation (đếm bằng
   * count(*) theo mốc đã đọc của chính user — consumer realtime dùng
   * để gửi kèm sự kiện cập nhật cho từng người nhận). Cài đặt truy
   * vấn ở bề mặt đọc dùng chung `@lms/messaging` — repository chỉ
   * uỷ quyền (issue #521).
   */
  async countUnreadForConversation(conversationId: string, userId: string): Promise<number> {
    return this.store.countUnreadForConversation(conversationId, userId);
  }
  /**
   * Số conversation có tin chưa đọc của user — một truy vấn EXISTS theo
   * mốc đã đọc của từng thành viên, không tải lịch sử về đếm.
   */
  async countUnreadConversations(userId: string): Promise<number> {
    const row = await this.handle
      .selectFrom('message_conversation_members')
      .select(sql<number>`count(*)::int`.as('value'))
      .where((eb) => eb.and([
        eb('user_id', '=', userId),
        // Conversation đã TẮT TIẾNG không tính vào huy hiệu điều
        // hướng (lát M5) và cũng không tính ở bất kỳ bề mặt nào
        // khác theo vũ trụ chuẩn duy nhất (issue #592): tin vẫn
        // tới, mốc đã đọc và tin cuối không đổi, nhưng số chưa
        // đọc trả về bằng 0 ở mọi nơi cho tới khi bật lại tiếng.
        eb('muted', '=', false),
        sql<SqlBool>`exists (
          select 1 from message msg
          where msg.conversation_id = message_conversation_members.conversation_id
            and msg.seq > message_conversation_members.last_read_seq
            and msg.user_id_from <> ${userId}
            and msg.deleted_at is null
            and msg.recalled_at is null
            and not exists (
              select 1 from message_user_deletions d
              where d.message_id = msg.id and d.user_id = ${userId}
            )
        )`,
        // Conversation 1–1 đang bị ẩn vì quan hệ chặn (xem
        // listConversationSummaries) cũng không đếm vào huy hiệu chưa
        // đọc — danh sách không thấy thì huy hiệu không được lộ.
        sql<SqlBool>`not exists (
          select 1 from message_conversations c
          join message_conversation_members other_m
            on other_m.conversation_id = c.id and other_m.user_id <> ${userId}
          join message_users_blocked b
            on (b.user_id = ${userId} and b.blocked_user_id = other_m.user_id)
            or (b.user_id = other_m.user_id and b.blocked_user_id = ${userId})
          where c.id = message_conversation_members.conversation_id and c.type = 1
        )`,
      ]))
      .executeTakeFirst();
    return row?.value ?? 0;
  }

  /**
   * Chặn liên lạc từ một user.
   */
  async block(userId: string, blockedUserId: string): Promise<void> {
    await this.handle
      .insertInto('message_users_blocked')
      .values({ user_id: userId, blocked_user_id: blockedUserId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  /**
   * Bỏ chặn.
   */
  async unblock(userId: string, blockedUserId: string): Promise<void> {
    await this.handle
      .deleteFrom('message_users_blocked')
      .where('user_id', '=', userId)
      .where('blocked_user_id', '=', blockedUserId)
      .execute();
  }
  /**
   * A có chặn B hay không.
   */
  async isBlocked(userId: string, blockedUserId: string): Promise<boolean> {
    const rows = await this.handle
      .selectFrom('message_users_blocked')
      .select('user_id')
      .where('user_id', '=', userId)
      .where('blocked_user_id', '=', blockedUserId)
      .execute();
    return rows.length > 0;
  }
  /**
   * Danh sách user bị chặn. Cài đặt truy vấn ở bề mặt đọc dùng chung
   * `@lms/messaging` — repository chỉ uỷ quyền (issue #521).
   */
  async listBlocked(userId: string): Promise<string[]> {
    return this.store.listBlockedUserIds(userId);
  }
  /**
   * Danh sách user ĐÃ CHẶN user này (chiều ngược của listBlocked) —
   * danh sách thành viên khoá dùng để giấu phía chặn khỏi roster của
   * phía bị chặn, khớp ngữ nghĩa chặn hiện có. Cài đặt truy vấn ở
   * bề mặt đọc dùng chung `@lms/messaging` (issue #521).
   */
  async listBlockerIds(userId: string): Promise<string[]> {
    return this.store.listBlockerUserIds(userId);
  }
  /**
   * Mọi user đang có quan hệ chặn với user này ở BẤT KỲ chiều nào
   * (người mình chặn ∪ người chặn mình) — tập "đối tác bị chặn" dùng
   * cho các luật ẩn bề mặt 1–1 (presence, mốc đã đọc). Cài đặt truy
   * vấn ở bề mặt đọc dùng chung `@lms/messaging` (issue #521).
   */
  async listBlockedCounterpartIds(userId: string): Promise<string[]> {
    return this.store.listBlockedCounterpartIds(userId);
  }

  /**
   * Hai user có chung ít nhất một conversation NHÌN THẤY ĐƯỢC với
   * nhau hay không (issue #592 — cổng của endpoint hồ sơ người
   * phục vụ panel chat 1–1): chung dòng thành viên ở cùng một
   * conversation, TRỪ conversation 1–1 đang bị ẩn do quan hệ chặn
   * ở bất kỳ chiều nào (đường đó đối với cả hai phía như không
   * tồn tại, đúng luật ẩn bề mặt 1–1 khi chặn). Hội thoại nhóm
   * không bị luật chặn chạm tới. Chính mình với mình luôn được
   * coi là "chung" (hồ sơ của chính chủ không cần cổng này).
   *
   * @param viewerId - Người xem cần kiểm.
   * @param targetId - Người cần xem hồ sơ.
   * @returns `true` khi hai người chung một conversation nhìn thấy được.
   */
  async sharesConversation(viewerId: string, targetId: string): Promise<boolean> {
    if (viewerId === targetId) return true;
    const row = await this.handle
      .selectFrom('message_conversation_members')
      .innerJoin('message_conversations', 'message_conversations.id', 'message_conversation_members.conversation_id')
      .select(sql<number>`1`.as('value'))
      .where((eb) => eb.and([
        eb('message_conversation_members.user_id', '=', viewerId),
        sql<SqlBool>`exists (
          select 1 from message_conversation_members other_m
          where other_m.conversation_id = message_conversation_members.conversation_id
            and other_m.user_id = ${targetId}
        )`,
        sql<SqlBool>`not (
          message_conversations.type = 1 and exists (
            select 1 from message_users_blocked b
            where (b.user_id = ${viewerId} and b.blocked_user_id = ${targetId})
               or (b.user_id = ${targetId} and b.blocked_user_id = ${viewerId})
          )
        )`,
      ]))
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  /**
   * Hai người có chung ít nhất một hội thoại 1–1 KHÔNG bị chặn hay
   * không (cổng hồ sơ chat 1–1, issue #592): cùng câu truy vấn với
   * {@link sharesConversation} nhưng giới hạn `type = 1` — hội thoại
   * nhóm/lớp/khoá chung không tính, và quan hệ chặn ở bất kỳ chiều
   * nào cũng loại như luật ẩn bề mặt 1–1 khi chặn.
   *
   * @param viewerId - Người xem cần kiểm.
   * @param targetId - Người cần xem hồ sơ.
   * @returns `true` khi hai người chung một hội thoại 1–1 không bị chặn.
   */
  async sharesDirectConversation(viewerId: string, targetId: string): Promise<boolean> {
    if (viewerId === targetId) return true;
    const row = await this.handle
      .selectFrom('message_conversation_members')
      .innerJoin('message_conversations', 'message_conversations.id', 'message_conversation_members.conversation_id')
      .select(sql<number>`1`.as('value'))
      .where((eb) => eb.and([
        eb('message_conversation_members.user_id', '=', viewerId),
        eb('message_conversations.type', '=', 1),
        sql<SqlBool>`exists (
          select 1 from message_conversation_members other_m
          where other_m.conversation_id = message_conversation_members.conversation_id
            and other_m.user_id = ${targetId}
        )`,
        sql<SqlBool>`not (exists (
          select 1 from message_users_blocked b
          where (b.user_id = ${viewerId} and b.blocked_user_id = ${targetId})
             or (b.user_id = ${targetId} and b.blocked_user_id = ${viewerId})
        ))`,
      ]))
      .limit(1)
      .executeTakeFirst();
    return Boolean(row);
  }

  // --- contacts (quan hệ đã duyệt) + yêu cầu kết bạn -------------------------

  /**
   * Ghi quan hệ liên hệ ĐÃ DUYỆT ở cả hai chiều (a→b và b→a) — một
   * quan hệ được chấp nhận là hai phía theo đúng mô hình Moodle.
   */
  async addContactPair(a: string, b: string): Promise<void> {
    await this.handle
      .insertInto('message_contacts')
      .values([
        { user_id: a, contact_id: b },
        { user_id: b, contact_id: a },
      ])
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  /**
   * Gỡ quan hệ liên hệ ở cả hai chiều, đồng thời dọn mọi yêu cầu đang
   * chờ giữa hai người (quan hệ đã chấm dứt thì hàng chờ cũng hết nghĩa).
   */
  async removeContactPair(a: string, b: string): Promise<void> {
    await this.handle
      .deleteFrom('message_contacts')
      .where((eb) => eb.or([
        eb.and([eb('user_id', '=', a), eb('contact_id', '=', b)]),
        eb.and([eb('user_id', '=', b), eb('contact_id', '=', a)]),
      ]))
      .execute();
    await this.deleteContactRequestsBetween(a, b);
  }
  /**
   * Danh bạ của user (các liên hệ đã được duyệt — quan hệ hai chiều nên
   * một hướng truy vấn là đủ). Quan hệ chặn đang hiệu lực (bất kỳ
   * chiều nào) thì hai người ẨN khỏi danh bạ của nhau theo chuẩn app
   * nhắn tin; hàng quan hệ trong DB giữ nguyên — bỏ chặn là hiện lại.
   */
  async listContacts(userId: string): Promise<string[]> {
    const rows = await this.handle
      .selectFrom('message_contacts')
      .select('contact_id as contactId')
      .where((eb) => eb.and([
        eb('user_id', '=', userId),
        sql<SqlBool>`not exists (
          select 1 from message_users_blocked b
          where (b.user_id = ${userId} and b.blocked_user_id = message_contacts.contact_id)
             or (b.user_id = message_contacts.contact_id and b.blocked_user_id = ${userId})
        )`,
      ]))
      .execute();
    return rows.map((r) => r.contactId);
  }
  /**
   * Owner có contactId trong danh bạ đã duyệt hay không. Cổng liên lạc
   * dùng hướng (người nhận, người gửi) — vì quan hệ được duyệt tồn tại
   * ở cả hai chiều nên hướng này đúng khi và chỉ khi hai người là liên
   * hệ đã chấp nhận của nhau. Yêu cầu đang chờ KHÔNG nằm ở bảng này.
   */
  async isContact(ownerId: string, contactId: string): Promise<boolean> {
    const rows = await this.handle
      .selectFrom('message_contacts')
      .select('user_id')
      .where('user_id', '=', ownerId)
      .where('contact_id', '=', contactId)
      .execute();
    return rows.length > 0;
  }
  /** Tạo một yêu cầu kết bạn (trùng cặp thì bỏ qua). */
  async createContactRequest(fromId: string, toId: string): Promise<void> {
    await this.handle
      .insertInto('message_contact_requests')
      .values({ user_id_from: fromId, user_id_to: toId })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
  /** Một yêu cầu kết bạn theo đúng hướng (from → to), nếu đang chờ. */
  async getContactRequest(fromId: string, toId: string): Promise<ContactRequestRow | undefined> {
    return this.handle
      .selectFrom('message_contact_requests')
      .select(CONTACT_REQUEST_COLUMNS)
      .where('user_id_from', '=', fromId)
      .where('user_id_to', '=', toId)
      .executeTakeFirst() as Promise<ContactRequestRow | undefined>;
  }
  /** Xoá một yêu cầu theo hướng (from → to): chấp nhận/từ chối đều qua đây. */
  async deleteContactRequest(fromId: string, toId: string): Promise<void> {
    await this.handle
      .deleteFrom('message_contact_requests')
      .where('user_id_from', '=', fromId)
      .where('user_id_to', '=', toId)
      .execute();
  }
  /** Xoá mọi yêu cầu đang chờ giữa hai người (cả hai hướng). */
  async deleteContactRequestsBetween(a: string, b: string): Promise<void> {
    await this.handle
      .deleteFrom('message_contact_requests')
      .where((eb) => eb.or([
        eb.and([eb('user_id_from', '=', a), eb('user_id_to', '=', b)]),
        eb.and([eb('user_id_from', '=', b), eb('user_id_to', '=', a)]),
      ]))
      .execute();
  }
  /** Các yêu cầu ĐẾN user này đang chờ (người gửi → chờ user duyệt). */
  async listIncomingContactRequests(userId: string): Promise<ContactRequestRow[]> {
    return this.handle
      .selectFrom('message_contact_requests')
      .select(CONTACT_REQUEST_COLUMNS)
      .where('user_id_to', '=', userId)
      .orderBy('created_at', 'asc')
      .execute() as Promise<ContactRequestRow[]>;
  }
  /** Các yêu cầu user này ĐÃ GỬI đang chờ phía kia duyệt. */
  async listOutgoingContactRequests(userId: string): Promise<ContactRequestRow[]> {
    return this.handle
      .selectFrom('message_contact_requests')
      .select(CONTACT_REQUEST_COLUMNS)
      .where('user_id_from', '=', userId)
      .orderBy('created_at', 'asc')
      .execute() as Promise<ContactRequestRow[]>;
  }

  // --- staff (cho các cổng nghiệp vụ Lớp B) -----------------------------------
  // Đọc thẳng bảng role_assignments + role (barrel schema), cùng kỷ luật
  // "đọc bảng dùng chung, không import module khác" như phần enrol/groups.

  /**
   * User có ÍT NHẤT một gán vai trò staff (theo archetype) ở bất kỳ
   * context nào hay không — căn cứ của cổng "chỉ giáo viên/staff được
   * tạo nhóm tự do": người chỉ mang vai trò học sinh ở mọi nơi bị chặn,
   * giáo viên của bất kỳ khoá nào cũng qua được.
   */
  async hasStaffRoleAssignment(userId: string): Promise<boolean> {
    const rows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .select('role_assignments.id as id')
      .where('role_assignments.user_id', '=', userId)
      .where('role.archetype', 'in', [...STAFF_ARCHETYPES])
      .limit(1)
      .execute();
    return rows.length > 0;
  }

  /**
   * User có ÍT NHẤT một context HỌC SINH thật hay không — căn cứ của
   * tầng audience phía học sinh trong tuỳ chọn thông báo (lát phân
   * chia theo vai, issue #288). "Context học sinh" theo đúng hợp nhất
   * mà hệ đã dùng cho tư cách thành viên khoá (ghi danh hiệu lực ∪
   * gán vai tại context khoá): ở đây gồm (a) một ghi danh ĐANG HIỆU
   * LỰC ở bất kỳ khoá nào — cùng điều kiện hiệu lực với
   * `listActiveEnrolledUserIds` (trạng thái ghi danh + trạng thái
   * instance đều 0, nằm trong cửa sổ thời gian) nhưng không ghim một
   * khoá cụ thể; hoặc (b) một gán vai archetype `student` ở bất kỳ
   * context nào — đối xứng với `hasStaffRoleAssignment` phía nhân sự.
   * Giáo viên thuần (không ghi danh học viên ở đâu) trả false.
   */
  async hasStudentContext(userId: string): Promise<boolean> {
    const now = new Date();
    const enrolled = await this.handle
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .select('user_enrolments.id as id')
      .where((eb) => eb.and([
        eb('user_enrolments.user_id', '=', userId),
        eb('user_enrolments.status', '=', 0),
        eb('enrol.status', '=', 0),
        eb('user_enrolments.time_start', '<=', now),
        eb.or([
          eb('user_enrolments.time_end', 'is', null),
          eb('user_enrolments.time_end', '>=', now),
        ]),
      ]))
      .limit(1)
      .execute();
    if (enrolled.length > 0) return true;
    const assigned = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .select('role_assignments.id as id')
      .where('role_assignments.user_id', '=', userId)
      .where('role.archetype', '=', 'student')
      .limit(1)
      .execute();
    return assigned.length > 0;
  }

  /**
   * User có ÍT NHẤT một liên kết giám hộ ĐANG HIỆU LỰC trong vai trò
   * PHỤ HUYNH hay không (`guardian_links.status = 'active'` với
   * guardianUserId là chính user) — căn cứ của tầng audience phía
   * phụ huynh trong tuỳ chọn thông báo (issue #288): chỉ người thật
   * sự đang là phụ huynh mới thấy hai loại guardian_*; liên kết đã
   * thu hồi không tính. Đọc thẳng bảng dùng chung như kỷ luật của
   * phần staff ở trên, không import module Guardians (module đó đang
   * phụ thuộc MessagingService để phát thông báo — import ngược sẽ
   * thành vòng).
   */
  async hasActiveGuardianLink(userId: string): Promise<boolean> {
    const rows = await this.handle
      .selectFrom('guardian_links')
      .select('id')
      .where('guardian_user_id', '=', userId)
      .where('status', '=', 'active')
      .limit(1)
      .execute();
    return rows.length > 0;
  }
  /**
   * Mọi user mang vai trò staff tại context của khoá hoặc một context
   * tổ tiên của nó (kế thừa theo đường path của context, khớp ngữ
   * nghĩa evaluator) — tập "giáo viên phụ trách" nhận báo cáo và thông
   * báo về conversation của khoá.
   */
  async listCourseStaffUserIds(courseId: string): Promise<string[]> {
    const courseCtx = await this.handle
      .selectFrom('context')
      .select(['id', 'path'])
      .where('context_level', '=', 50)
      .where('instance_id', '=', courseId)
      .executeTakeFirst();
    if (!courseCtx) return [];
    // path của context là chuỗi id các context từ gốc tới chính nó
    // (định dạng '/<id>/.../<id>'): các id trong path là đúng tập
    // context mà gán vai trò tại đó kế thừa xuống khoá này.
    const pathIds = courseCtx.path.split('/').filter((part) => part.length > 0);
    if (!pathIds.length) return [];
    const rows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .select('role_assignments.user_id as userId')
      .distinct()
      .where('role.archetype', 'in', [...STAFF_ARCHETYPES])
      .where('role_assignments.context_id', 'in', pathIds)
      .execute();
    return rows.map((r) => r.userId);
  }

  // --- báo cáo conversation ---------------------------------------------------

  /** Ghi một báo cáo conversation mới (trạng thái open). */
  async insertReport(v: NewReport): Promise<ReportRow> {
    return this.handle
      .insertInto('message_conversation_reports')
      .values(reportInsertValues(v))
      .returning(REPORT_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<ReportRow>;
  }
  /** Một báo cáo theo id. */
  async getReport(id: string): Promise<ReportRow | undefined> {
    return this.handle
      .selectFrom('message_conversation_reports')
      .select(REPORT_COLUMNS)
      .where('id', '=', id)
      .executeTakeFirst() as Promise<ReportRow | undefined>;
  }
  /** Các báo cáo mới nhất trước (hàng đợi xử lý lọc theo thẩm quyền ở tầng service). */
  async listReports(limit = 200): Promise<ReportRow[]> {
    return this.handle
      .selectFrom('message_conversation_reports')
      .select(REPORT_COLUMNS)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .execute() as Promise<ReportRow[]>;
  }
  /** Đổi trạng thái xử lý của báo cáo; resolved/dismissed ghi người xử lý + mốc, mở lại thì xoá hai dấu đó. */
  async updateReportStatus(id: string, status: string, resolvedBy: string | null): Promise<ReportRow | undefined> {
    const closing = status !== 'open';
    return this.handle
      .updateTable('message_conversation_reports')
      .set({
        status,
        resolved_by: closing ? resolvedBy : null,
        resolved_at: closing ? new Date() : null,
      })
      .where('id', '=', id)
      .returning(REPORT_COLUMNS)
      .executeTakeFirst() as Promise<ReportRow | undefined>;
  }

  // --- ghi danh hiệu lực + roster thành viên khoá ------------------------------
  // Đọc trực tiếp bảng enrol/user_enrolments qua định nghĩa bảng dùng chung
  // (barrel schema) — Messaging KHÔNG import EnrolModule để tránh vòng lặp
  // module; ngữ nghĩa "đang active" chép đúng EnrolService.isEnrolled
  // (instance enabled, ghi danh ACTIVE, now trong [timeStart, timeEnd]).

  /**
   * Các khoá mà user có ghi danh đang hiệu lực (instance enabled + ghi danh
   * ACTIVE + trong cửa sổ thời gian).
   */
  async activeCourseIds(userId: string): Promise<string[]> {
    const now = new Date();
    const rows = await this.handle
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .select('enrol.course_id as courseId')
      .where((eb) => eb.and([
        eb('user_enrolments.user_id', '=', userId),
        eb('user_enrolments.status', '=', 0),
        eb('enrol.status', '=', 0),
        eb('user_enrolments.time_start', '<=', now),
        eb.or([
          eb('user_enrolments.time_end', 'is', null),
          eb('user_enrolments.time_end', '>=', now),
        ]),
      ]))
      .execute();
    return rows.map((r) => r.courseId);
  }
  /**
   * Khoá chung của một cặp (giáo viên, học sinh) theo quan hệ mở cổng
   * nhắn riêng trực tiếp (ngoại lệ đã chốt bổ sung 25/10/2026 trên
   * issue #33): MỘT phía có gán vai archetype staff
   * ({@link STAFF_ARCHETYPES}) TẠI context của khoá — đúng khái niệm
   * "giáo viên của khoá" mà roster dùng cho cờ teacher, hẹp hơn
   * capability `course:managegroups` (chỉ tổ trưởng/quản lý nhóm mới
   * có) — và phía KIA có ghi danh ĐANG HIỆU LỰC trong chính khoá đó.
   * Trả id khoá đầu tiên khớp, không có thì null. Một truy vấn duy
   * nhất neo theo cặp user (role_assignments theo user/context và
   * user_enrolments theo user đều có index sẵn) — không quét toàn bộ
   * danh sách khoá hay thành viên, không cần index/schema mới.
   */
  async findTeacherStudentSharedCourseId(userA: string, userB: string): Promise<string | null> {
    const now = new Date();
    const rows = await this.handle
      .selectFrom('context')
      .innerJoin('role_assignments', 'role_assignments.context_id', 'context.id')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .innerJoin('enrol', 'enrol.course_id', 'context.instance_id')
      .innerJoin('user_enrolments', 'user_enrolments.enrol_id', 'enrol.id')
      .select('context.instance_id as courseId')
      .where((eb) => eb.and([
        eb('context.context_level', '=', 50),
        eb('role.archetype', 'in', [...STAFF_ARCHETYPES]),
        eb('user_enrolments.status', '=', 0),
        eb('enrol.status', '=', 0),
        eb('user_enrolments.time_start', '<=', now),
        eb.or([
          eb('user_enrolments.time_end', 'is', null),
          eb('user_enrolments.time_end', '>=', now),
        ]),
        eb.or([
          eb.and([eb('role_assignments.user_id', '=', userA), eb('user_enrolments.user_id', '=', userB)]),
          eb.and([eb('role_assignments.user_id', '=', userB), eb('user_enrolments.user_id', '=', userA)]),
        ]),
      ]))
      .limit(1)
      .execute();
    return rows[0]?.courseId ?? null;
  }
  /**
   * User có gán vai archetype staff TẠI context của đúng khoá này hay
   * không — "giáo viên của khoá" theo cùng định nghĩa roster dùng,
   * dùng để tính cờ nhắn thẳng trên từng dòng roster.
   */
  async isCourseTeachingStaff(courseId: string, userId: string): Promise<boolean> {
    const courseCtx = await this.handle
      .selectFrom('context')
      .select('id')
      .where('context_level', '=', 50)
      .where('instance_id', '=', courseId)
      .executeTakeFirst();
    if (!courseCtx) return false;
    const rows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .select('role_assignments.id as id')
      .where('role_assignments.context_id', '=', courseCtx.id)
      .where('role_assignments.user_id', '=', userId)
      .where('role.archetype', 'in', [...STAFF_ARCHETYPES])
      .limit(1)
      .execute();
    return rows.length > 0;
  }
  /** Tóm tắt một khoá (cho danh sách "khoá của tôi" của luồng tìm bạn theo khoá). */
  async getCourseSummary(courseId: string): Promise<{ courseId: string; fullName: string; shortName: string } | undefined> {
    return this.handle
      .selectFrom('course')
      .select(['id as courseId', 'full_name as fullName', 'short_name as shortName'])
      .where('id', '=', courseId)
      .executeTakeFirst();
  }
  /**
   * Các khoá mà user là THÀNH VIÊN theo định nghĩa roster đã chốt:
   * ghi danh đang hiệu lực ∪ có gán vai tại context của khoá (mọi
   * archetype — gán vai học viên tại context khoá cũng là thành viên).
   */
  async listMembershipCourseIds(userId: string): Promise<string[]> {
    const enrolled = await this.activeCourseIds(userId);
    const assigned = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('context', 'context.id', 'role_assignments.context_id')
      .select('context.instance_id as courseId')
      .distinct()
      .where('role_assignments.user_id', '=', userId)
      .where('context.context_level', '=', 50)
      .execute();
    const assignedCourseIds = assigned.map((r) => r.courseId).filter((id): id is string => id !== null);
    return [...new Set([...enrolled, ...assignedCourseIds])];
  }
  /**
   * User có thuộc khoá theo định nghĩa thành viên roster hay không —
   * cổng xem roster: người ngoài khoá bị từ chối ở tầng service bằng
   * cùng một 404 như khoá không tồn tại (không lộ sự tồn tại của khoá).
   */
  async isCourseMember(courseId: string, userId: string): Promise<boolean> {
    const now = new Date();
    const enrolled = await this.handle
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .select('user_enrolments.user_id as userId')
      .where((eb) => eb.and([
        eb('enrol.course_id', '=', courseId),
        eb('user_enrolments.user_id', '=', userId),
        eb('user_enrolments.status', '=', 0),
        eb('enrol.status', '=', 0),
        eb('user_enrolments.time_start', '<=', now),
        eb.or([
          eb('user_enrolments.time_end', 'is', null),
          eb('user_enrolments.time_end', '>=', now),
        ]),
      ]))
      .limit(1)
      .executeTakeFirst();
    if (enrolled) return true;
    const courseCtx = await this.handle
      .selectFrom('context')
      .select('id')
      .where('context_level', '=', 50)
      .where('instance_id', '=', courseId)
      .executeTakeFirst();
    if (!courseCtx) return false;
    const assigned = await this.handle
      .selectFrom('role_assignments')
      .select('id')
      .where('context_id', '=', courseCtx.id)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
    return Boolean(assigned);
  }
  /**
   * Một trang roster của khoá, sắp tăng dần theo (displayName,
   * username, id); `cursor` là mốc của dòng cuối trang trước (null =
   * trang đầu) — phân trang con trỏ ngay tại SQL, không nạp tập thành
   * viên về app (số đo của đội kiểm tra trên issue #33: roster 50.000
   * thành viên trả hết là ~6,3 MB JSON; OFFSET sâu chậm hơn hẳn).
   * Tập thành viên = ghi danh hiệu lực ∪ gán vai tại context khoá;
   * cờ `staff` = có gán vai archetype staff tại context khoá; cờ
   * `enrolled` = thành viên có ghi danh hiệu lực (dù đồng thời có gán
   * vai hay không) — căn cứ phía "học sinh" của quan hệ nhắn thẳng
   * GV–HS trên roster. Tài
   * khoản đã xoá/tạm ngưng/khách, chính người xem, và người có quan
   * hệ chặn với người xem (CẢ hai chiều) bị loại ngay tại SQL. Chỉ
   * các trường trong whitelist của hợp đồng roster được chọn ra.
   */
  async listCourseRosterPage(courseId: string, actorId: string, cursor: { displayName: string; username: string; userId: string } | null, limit: number): Promise<{
    userId: string; username: string; firstName: string; lastName: string; displayName: string; staff: boolean; enrolled: boolean;
  }[]> {
    const cursorCond = cursor
      ? sql`and ((case when btrim(u.first_name || ' ' || u.last_name) = '' then u.username else btrim(u.first_name || ' ' || u.last_name) end), u.username, u.id) > (${cursor.displayName}, ${cursor.username}, ${cursor.userId}::uuid)`
      : sql``;
    const executed = await sql<Record<string, unknown>>`
      with course_ctx as (
        select id from "context" where context_level = 50 and instance_id = ${courseId}
      ),
      member_flags as (
        select ue.user_id as user_id, false as staff, true as enrolled
        from user_enrolments ue
        join enrol e on e.id = ue.enrol_id
        where e.course_id = ${courseId}
          and ue.status = 0 and e.status = 0
          and ue.time_start <= now() and (ue.time_end is null or ue.time_end >= now())
        union all
        select ra.user_id as user_id, (r.archetype in ('manager', 'coursecreator', 'editingteacher', 'teacher')) as staff, false as enrolled
        from role_assignments ra
        join role r on r.id = ra.role_id
        where ra.context_id = (select id from course_ctx)
      ),
      members as (
        select user_id, bool_or(staff) as staff, bool_or(enrolled) as enrolled from member_flags group by user_id
      )
      select u.id as user_id, u.username as username, u.first_name as first_name, u.last_name as last_name,
        (case when btrim(u.first_name || ' ' || u.last_name) = '' then u.username else btrim(u.first_name || ' ' || u.last_name) end) as display_name,
        m.staff as staff, m.enrolled as enrolled
      from members m
      join users u on u.id = m.user_id
      where u.deleted = false and u.suspended = false and u.is_guest = false
        and u.id <> ${actorId}
        and not exists (
          select 1 from message_users_blocked b
          where (b.user_id = ${actorId} and b.blocked_user_id = u.id)
             or (b.user_id = u.id and b.blocked_user_id = ${actorId})
        )
        ${cursorCond}
      order by display_name asc, u.username asc, u.id asc
      limit ${limit}
    `.execute(this.handle);
    return executed.rows.map((raw) => ({
      userId: raw.user_id as string,
      username: raw.username as string,
      firstName: raw.first_name as string,
      lastName: raw.last_name as string,
      displayName: raw.display_name as string,
      staff: Boolean(raw.staff),
      enrolled: Boolean(raw.enrolled),
    }));
  }

  // --- đồng bộ cuộc trò chuyện nhóm ------------------------------------------------
  // Đọc trực tiếp bảng groups/groups_members qua barrel schema (không import
  // GroupsModule): đồng bộ lười phía messaging, không cần hook bên groups.

  /**
   * Lấy một course group theo id (kèm courseId để resolve context/staff).
   */
  async getCourseGroup(groupId: string): Promise<CourseGroupRow | undefined> {
    return this.handle
      .selectFrom('course_groups')
      .select(COURSE_GROUP_COLUMNS)
      .where('id', '=', groupId)
      .executeTakeFirst() as Promise<CourseGroupRow | undefined>;
  }
  /**
   * Thành viên hiện tại của một course group.
   */
  async listGroupMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.handle
      .selectFrom('groups_members')
      .select('user_id as userId')
      .where('group_id', '=', groupId)
      .execute();
    return rows.map((r) => r.userId);
  }
  /**
   * Mọi group mà user hiện là thành viên (để tầng service phát hiện
   * membership conversation đã cũ so với group).
   */
  async listGroupIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.handle
      .selectFrom('groups_members')
      .select('group_id as groupId')
      .where('user_id', '=', userId)
      .execute();
    return rows.map((r) => r.groupId);
  }
  /**
   * Conversation gắn với một course group qua (component, itemType, itemId).
   */
  async findGroupConversation(groupId: string): Promise<ConversationRow | undefined> {
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_group')
      .where('item_type', '=', 'groups')
      .where('item_id', '=', groupId)
      .executeTakeFirst() as Promise<ConversationRow | undefined>;
  }
  /**
   * Mọi conversation gắn group mà user là thành viên của group tương ứng —
   * để thao tác liệt kê cũng kích hoạt đồng bộ (người mới vào group thấy
   * conversation ngay cả khi chưa từng là thành viên conversation).
   */
  async listGroupConversationsForGroupMember(userId: string): Promise<ConversationRow[]> {
    const memberships = await this.handle
      .selectFrom('groups_members')
      .select('group_id as groupId')
      .where('user_id', '=', userId)
      .execute();
    if (!memberships.length) return [];
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_group')
      .where('item_type', '=', 'groups')
      .where('item_id', 'in', memberships.map((m) => m.groupId))
      .execute() as Promise<ConversationRow[]>;
  }

  // --- đồng bộ cuộc trò chuyện khoá học ----------------------------------------------
  // Conversation CẤP KHOÁ (chat toàn lớp): một conversation type 2 gắn
  // với chính khoá qua (component 'core_course', itemType 'course',
  // itemId = course id). Thành viên đúng nghĩa = ghi danh đang hiệu lực
  // ∪ staff của khoá — đọc trực tiếp enrol/user_enrolments +
  // role_assignments qua barrel schema như phần roster/staff phía trên.

  /**
   * Conversation gắn với chính một khoá qua (component, itemType, itemId).
   * Nhận tx tuỳ chọn để re-check TRONG transaction đã giữ khoá advisory
   * (xem {@link acquireCourseConversationLock}) — đường đọc mặc định
   * vẫn qua kết nối thường.
   */
  async findCourseConversation(courseId: string, tx?: MessagingDb): Promise<ConversationRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_course')
      .where('item_type', '=', 'course')
      .where('item_id', '=', courseId)
      .executeTakeFirst() as Promise<ConversationRow | undefined>;
  }
  /**
   * Khoá advisory cấp transaction theo courseId cho đường ensure
   * conversation cấp khoá: mọi lượt ensure song song của cùng một khoá
   * xếp hàng tại đây, và vì là xact lock (giữ tới commit/rollback) nên
   * lượt xếp sau re-check sẽ thấy conversation của lượt trước đã
   * commit. Đây là điểm đồng bộ duy nhất giữ bất biến "mỗi khoá đúng
   * một conversation cấp khoá" mà không cần unique trên schema.
   */
  async acquireCourseConversationLock(tx: MessagingTx, courseId: string): Promise<void> {
    const key = `messaging:core_course:${courseId}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
  }
  /**
   * User đang ghi danh HIỆU LỰC trong một khoá (instance enabled + ghi
   * danh ACTIVE + trong cửa sổ thời gian — cùng ngữ nghĩa activeCourseIds).
   */
  async listActiveEnrolledUserIds(courseId: string): Promise<string[]> {
    const now = new Date();
    const rows = await this.handle
      .selectFrom('user_enrolments')
      .innerJoin('enrol', 'enrol.id', 'user_enrolments.enrol_id')
      .select('user_enrolments.user_id as userId')
      .where((eb) => eb.and([
        eb('enrol.course_id', '=', courseId),
        eb('user_enrolments.status', '=', 0),
        eb('enrol.status', '=', 0),
        eb('user_enrolments.time_start', '<=', now),
        eb.or([
          eb('user_enrolments.time_end', 'is', null),
          eb('user_enrolments.time_end', '>=', now),
        ]),
      ]))
      .execute();
    return [...new Set(rows.map((r) => r.userId))];
  }
  /**
   * Tập thành viên của conversation cấp khoá: ghi danh đang hiệu lực ∪
   * staff của khoá ({@link listCourseStaffUserIds} — gán vai staff tại
   * context khoá hoặc tổ tiên).
   */
  async listCourseConversationMemberIds(courseId: string): Promise<string[]> {
    const enrolled = await this.listActiveEnrolledUserIds(courseId);
    const staff = await this.listCourseStaffUserIds(courseId);
    return [...new Set([...enrolled, ...staff])];
  }
  /**
   * Mọi conversation cấp khoá thuộc các khoá mà user là thành viên theo
   * định nghĩa roster (ghi danh hiệu lực ∪ gán vai tại context khoá) —
   * để thao tác liệt kê cũng kích hoạt đồng bộ lười như đường group.
   */
  async listCourseConversationsForMember(userId: string): Promise<ConversationRow[]> {
    const courseIds = await this.listMembershipCourseIds(userId);
    if (!courseIds.length) return [];
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_course')
      .where('item_type', '=', 'course')
      .where('item_id', 'in', courseIds)
      .execute() as Promise<ConversationRow[]>;
  }

  // --- class conversation sync (lát MSG-T2, issue #184) ----------------------
  // Conversation CẤP LỚP (chat của chính lớp): một conversation type 2
  // gắn với lớp qua (component 'core_class', itemType 'class',
  // itemId = class id) — conversation RIÊNG, không dùng lại nhóm con
  // "Cả lớp" của khoá trong lớp. Thành viên đúng nghĩa = roster lớp
  // hiệu lực (≡ cohort_members của backing cohort, định nghĩa của
  // module classes) ∪ chủ lớp ∪ staff của lớp (gán vai archetype staff
  // tại context lớp mức 45 hoặc tổ tiên) — đọc trực tiếp qua barrel
  // schema như phần cây nhóm ở dưới, không import ClassesModule.

  /**
   * Tóm tắt một lớp (cho đường ensure + roster phía messages).
   *
   * @param classId - Id lớp cần tra.
   * @returns Tên, chủ lớp, cohort đỡ roster, tenant và trạng thái
   *   của lớp; `undefined` khi lớp không tồn tại.
   */
  async getClassSummary(classId: string): Promise<{ classId: string; name: string; ownerId: string; cohortId: string; tenantId: string; status: string } | undefined> {
    return this.handle
      .selectFrom('classes')
      .select(['id as classId', 'name', 'owner_id as ownerId', 'cohort_id as cohortId', 'tenant_id as tenantId', 'status'])
      .where('id', '=', classId)
      .executeTakeFirst();
  }
  /**
   * Mọi user mang vai trò staff tại context của lớp hoặc một context
   * tổ tiên của nó — tập "giáo viên của lớp" (chủ lớp có editingteacher
   * tại context lớp nên nằm trong tập này), khớp
   * {@link listCourseStaffUserIds} ở cấp khoá.
   *
   * @param classId - Id lớp làm phạm vi.
   * @returns Danh sách id người dùng thuộc tập staff của lớp (rỗng
   *   khi lớp chưa có context).
   */
  async listClassStaffUserIds(classId: string): Promise<string[]> {
    const classCtx = await this.handle
      .selectFrom('context')
      .select(['id', 'path'])
      .where('context_level', '=', 45)
      .where('instance_id', '=', classId)
      .executeTakeFirst();
    if (!classCtx) return [];
    const pathIds = classCtx.path.split('/').filter((part) => part.length > 0);
    if (!pathIds.length) return [];
    const rows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .select('role_assignments.user_id as userId')
      .distinct()
      .where('role.archetype', 'in', [...STAFF_ARCHETYPES])
      .where('role_assignments.context_id', 'in', pathIds)
      .execute();
    return rows.map((r) => r.userId);
  }
  /**
   * User có gán vai archetype staff TẠI context của đúng lớp này hay
   * không — "giáo viên của lớp" theo cùng định nghĩa roster khoá dùng
   * cho cờ nhắn thẳng GV–HS (chủ lớp mang editingteacher tại context
   * lớp nên qua được kiểm này).
   *
   * @param classId - Id lớp làm phạm vi.
   * @param userId - Người cần kiểm.
   * @returns `true` khi có gán vai staff ngay tại context lớp.
   */
  async isClassTeachingStaff(classId: string, userId: string): Promise<boolean> {
    const classCtx = await this.handle
      .selectFrom('context')
      .select('id')
      .where('context_level', '=', 45)
      .where('instance_id', '=', classId)
      .executeTakeFirst();
    if (!classCtx) return false;
    const rows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .select('role_assignments.id as id')
      .where('role_assignments.context_id', '=', classCtx.id)
      .where('role_assignments.user_id', '=', userId)
      .where('role.archetype', 'in', [...STAFF_ARCHETYPES])
      .limit(1)
      .execute();
    return rows.length > 0;
  }
  /**
   * Thành viên roster hiệu lực của lớp (≡ cohort_members của backing
   * cohort).
   *
   * @param classId - Id lớp.
   * @returns Danh sách id thành viên roster (rỗng khi lớp không còn).
   */
  async listClassRosterMemberIds(classId: string): Promise<string[]> {
    const cls = await this.getClassSummary(classId);
    if (!cls) return [];
    const rows = await this.handle
      .selectFrom('cohort_members')
      .select('user_id as userId')
      .where('cohort_id', '=', cls.cohortId)
      .execute();
    return rows.map((r) => r.userId);
  }
  /**
   * Tập thành viên của conversation cấp lớp: roster lớp hiệu lực ∪
   * chủ lớp ∪ staff của lớp. Đây là TẬP ĐÍCH duy nhất mà mọi đường
   * đồng bộ lười của chat lớp hướng về — roster lớp là nguồn sự
   * thật, thành viên chat chỉ là hình chiếu của nó.
   *
   * @param classId - Id lớp.
   * @returns Danh sách id thành viên (đã khử trùng) của chat lớp.
   */
  async listClassConversationMemberIds(classId: string): Promise<string[]> {
    const cls = await this.getClassSummary(classId);
    if (!cls) return [];
    const roster = await this.listClassRosterMemberIds(classId);
    const staff = await this.listClassStaffUserIds(classId);
    return [...new Set([...roster, cls.ownerId, ...staff])];
  }
  /**
   * User có thuộc lớp theo định nghĩa thành viên của chat lớp hay
   * không: thành viên roster, chủ lớp, hoặc có BẤT KỲ gán vai nào tại
   * context lớp (gán vai tại lớp cũng là quan hệ thuộc lớp, như định
   * nghĩa thành viên khoá gồm gán vai tại context khoá).
   *
   * @param classId - Id lớp.
   * @param userId - Người cần kiểm.
   * @returns `true` khi người dùng thuộc lớp theo bất kỳ vế nào.
   */
  async isClassMember(classId: string, userId: string): Promise<boolean> {
    const cls = await this.getClassSummary(classId);
    if (!cls) return false;
    if (cls.ownerId === userId) return true;
    const inRoster = await this.handle
      .selectFrom('cohort_members')
      .select('user_id as userId')
      .where('cohort_id', '=', cls.cohortId)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
    if (inRoster) return true;
    const classCtx = await this.handle
      .selectFrom('context')
      .select('id')
      .where('context_level', '=', 45)
      .where('instance_id', '=', classId)
      .executeTakeFirst();
    if (!classCtx) return false;
    const assigned = await this.handle
      .selectFrom('role_assignments')
      .select('id')
      .where('context_id', '=', classCtx.id)
      .where('user_id', '=', userId)
      .limit(1)
      .executeTakeFirst();
    return Boolean(assigned);
  }
  /**
   * Conversation gắn với chính một lớp qua (component, itemType,
   * itemId). Nhận tx tuỳ chọn để re-check TRONG transaction đã giữ
   * khoá advisory (xem {@link acquireClassConversationLock}).
   *
   * @param classId - Id lớp.
   * @param tx - Transaction đang chạy (khi re-check trong ensure),
   *   bỏ trống thì đọc bằng kết nối thường.
   * @returns Conversation cấp lớp của lớp, hoặc `undefined`.
   */
  async findClassConversation(classId: string, tx?: MessagingDb): Promise<ConversationRow | undefined> {
    const db = tx ?? this.handle;
    return db
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_class')
      .where('item_type', '=', 'class')
      .where('item_id', '=', classId)
      .executeTakeFirst() as Promise<ConversationRow | undefined>;
  }
  /**
   * Khoá advisory cấp transaction theo classId cho đường ensure
   * conversation cấp lớp — cùng khuôn khoá cấp khoá, giữ bất biến
   * "mỗi lớp đúng một conversation cấp lớp" mà không cần unique trên
   * schema.
   *
   * @param tx - Transaction sẽ giữ khoá tới khi commit/rollback.
   * @param classId - Id lớp làm khoá.
   */
  async acquireClassConversationLock(tx: MessagingTx, classId: string): Promise<void> {
    const key = `messaging:core_class:${classId}`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(tx);
  }
  /**
   * Mọi conversation cấp lớp thuộc các lớp mà user có quan hệ (chủ
   * lớp / staff tại context lớp / thành viên roster — đúng tập lớp
   * của cây nhóm) — để thao tác liệt kê cũng kích hoạt đồng bộ lười
   * như đường khoá.
   *
   * @param userId - Người đang liệt kê.
   * @returns Các conversation cấp lớp đã tồn tại của những lớp mà
   *   người dùng có quan hệ (chưa ensure thì lớp chưa có dòng nào).
   */
  async listClassConversationsForMember(userId: string): Promise<ConversationRow[]> {
    const relations = await this.listTreeClassesForUser(userId);
    if (!relations.length) return [];
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_class')
      .where('item_type', '=', 'class')
      .where('item_id', 'in', relations.map((r) => r.classId))
      .execute() as Promise<ConversationRow[]>;
  }
  /**
   * Một trang roster của lớp, sắp tăng dần theo (displayName,
   * username, id) — cùng khuôn trang roster khoá
   * ({@link listCourseRosterPage}): tập thành viên = roster lớp
   * (cohort_members của backing cohort; cờ `enrolled` = thuộc roster)
   * ∪ gán vai tại context lớp (cờ `staff` = archetype staff tại
   * context lớp); tài khoản đã xoá/tạm ngưng/khách, chính người xem
   * và quan hệ chặn hai chiều bị loại ngay tại SQL.
   *
   * @param classId - Id lớp.
   * @param actorId - Người xem (bị loại khỏi kết quả).
   * @param cursor - Mốc (displayName, username, id) của dòng cuối
   *   trang trước; null khi lấy trang đầu.
   * @param limit - Số dòng tối đa (service truyền limit + 1 để dò
   *   còn trang sau hay không).
   * @returns Các dòng roster của trang, đã sắp xếp ổn định.
   */
  async listClassRosterPage(classId: string, actorId: string, cursor: { displayName: string; username: string; userId: string } | null, limit: number): Promise<{
    userId: string; username: string; firstName: string; lastName: string; displayName: string; staff: boolean; enrolled: boolean;
  }[]> {
    const cursorCond = cursor
      ? sql`and ((case when btrim(u.first_name || ' ' || u.last_name) = '' then u.username else btrim(u.first_name || ' ' || u.last_name) end), u.username, u.id) > (${cursor.displayName}, ${cursor.username}, ${cursor.userId}::uuid)`
      : sql``;
    const executed = await sql<Record<string, unknown>>`
      with class_row as (
        select cohort_id, owner_id from classes where id = ${classId}
      ),
      class_ctx as (
        select id from "context" where context_level = 45 and instance_id = ${classId}
      ),
      member_flags as (
        select cm.user_id as user_id, false as staff, true as enrolled
        from cohort_members cm
        where cm.cohort_id = (select cohort_id from class_row)
        union all
        select ra.user_id as user_id, (r.archetype in ('manager', 'coursecreator', 'editingteacher', 'teacher')) as staff, false as enrolled
        from role_assignments ra
        join role r on r.id = ra.role_id
        where ra.context_id = (select id from class_ctx)
        union all
        select owner_id as user_id, true as staff, false as enrolled
        from class_row
      ),
      members as (
        select user_id, bool_or(staff) as staff, bool_or(enrolled) as enrolled from member_flags group by user_id
      )
      select u.id as user_id, u.username as username, u.first_name as first_name, u.last_name as last_name,
        (case when btrim(u.first_name || ' ' || u.last_name) = '' then u.username else btrim(u.first_name || ' ' || u.last_name) end) as display_name,
        m.staff as staff, m.enrolled as enrolled
      from members m
      join users u on u.id = m.user_id
      where u.deleted = false and u.suspended = false and u.is_guest = false
        and u.id <> ${actorId}
        and not exists (
          select 1 from message_users_blocked b
          where (b.user_id = ${actorId} and b.blocked_user_id = u.id)
             or (b.user_id = u.id and b.blocked_user_id = ${actorId})
        )
        ${cursorCond}
      order by display_name asc, u.username asc, u.id asc
      limit ${limit}
    `.execute(this.handle);
    return executed.rows.map((raw) => ({
      userId: raw.user_id as string,
      username: raw.username as string,
      firstName: raw.first_name as string,
      lastName: raw.last_name as string,
      displayName: raw.display_name as string,
      staff: Boolean(raw.staff),
      enrolled: Boolean(raw.enrolled),
    }));
  }
  /**
   * Lớp chung của một cặp (giáo viên, học sinh) theo quan hệ mở cổng
   * nhắn riêng trực tiếp — bản cấp lớp của
   * {@link findTeacherStudentSharedCourseId} (sổ quyết định mục D:
   * GV nhắn riêng trực tiếp HS thuộc khoá/LỚP của mình): MỘT phía là
   * giáo viên của lớp (gán vai archetype staff tại context lớp — chủ
   * lớp mang editingteacher tại context lớp nên nằm trong vế này) và
   * phía KIA là thành viên roster hiệu lực của chính lớp đó. Trả id
   * lớp đầu tiên khớp, không có thì null.
   *
   * @param userA - Một phía của cặp.
   * @param userB - Phía còn lại của cặp.
   * @returns Id lớp chung đầu tiên theo quan hệ GV–HS, hoặc null.
   */
  async findTeacherStudentSharedClassId(userA: string, userB: string): Promise<string | null> {
    const rows = await this.handle
      .selectFrom('context')
      .innerJoin('role_assignments', 'role_assignments.context_id', 'context.id')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .innerJoin('classes', 'classes.id', 'context.instance_id')
      .innerJoin('cohort_members', 'cohort_members.cohort_id', 'classes.cohort_id')
      .select('context.instance_id as classId')
      .where((eb) => eb.and([
        eb('context.context_level', '=', 45),
        eb('classes.status', '=', 'active'),
        eb('role.archetype', 'in', [...STAFF_ARCHETYPES]),
        eb.or([
          eb.and([eb('role_assignments.user_id', '=', userA), eb('cohort_members.user_id', '=', userB)]),
          eb.and([eb('role_assignments.user_id', '=', userB), eb('cohort_members.user_id', '=', userA)]),
        ]),
      ]))
      .limit(1)
      .execute();
    return rows[0]?.classId ?? null;
  }

  // --- cây nhóm theo vai (lát MSG-T1, issue #33) ------------------------------
  // Cây dựng hoàn toàn ở server từ classes + enrol + conversations.
  // Messaging KHÔNG import ClassesModule (tránh vòng lặp module như
  // tiền lệ enrol ở trên): quan hệ của user với lớp đọc trực tiếp qua
  // barrel schema — chủ lớp (ownerId), gán vai tại context lớp (mức
  // 45), và roster lớp ≡ cohort_members của backing cohort (định
  // nghĩa của module classes). Lớp đã lưu trữ (status 'archived')
  // không thuộc cây đang hoạt động nên bị loại ở mọi đường.

  /** Quan hệ của user với MỘT lớp: chủ lớp hay có gán vai archetype staff tại context lớp (mức 45) hay không. */
  async listTreeClassesForUser(userId: string): Promise<{ classId: string; name: string; isOwner: boolean; isClassStaff: boolean; isRosterMember: boolean }[]> {
    const owned = await this.handle
      .selectFrom('classes')
      .select(['id as classId', 'name'])
      .where('owner_id', '=', userId)
      .where('status', '=', 'active')
      .execute();
    const staffRows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .innerJoin('context', 'context.id', 'role_assignments.context_id')
      .innerJoin('classes', 'classes.id', 'context.instance_id')
      .select(['context.instance_id as classId', 'classes.name as name'])
      .distinct()
      .where((eb) => eb.and([
        eb('role_assignments.user_id', '=', userId),
        eb('context.context_level', '=', 45),
        eb('role.archetype', 'in', [...STAFF_ARCHETYPES]),
        eb('classes.status', '=', 'active'),
      ]))
      .execute();
    const rosterRows = await this.handle
      .selectFrom('cohort_members')
      .innerJoin('classes', 'classes.cohort_id', 'cohort_members.cohort_id')
      .select(['classes.id as classId', 'classes.name as name'])
      .distinct()
      .where('cohort_members.user_id', '=', userId)
      .where('classes.status', '=', 'active')
      .execute();
    const byId = new Map<string, { classId: string; name: string; isOwner: boolean; isClassStaff: boolean; isRosterMember: boolean }>();
    const ensure = (classId: string | null, name: string) => {
      if (!classId) return undefined;
      let entry = byId.get(classId);
      if (!entry) {
        entry = { classId, name, isOwner: false, isClassStaff: false, isRosterMember: false };
        byId.set(classId, entry);
      }
      return entry;
    };
    for (const r of owned) { const e = ensure(r.classId, r.name); if (e) e.isOwner = true; }
    for (const r of staffRows) { const e = ensure(r.classId, r.name); if (e) e.isClassStaff = true; }
    for (const r of rosterRows) { const e = ensure(r.classId, r.name); if (e) e.isRosterMember = true; }
    return [...byId.values()];
  }

  /** Mọi khoá THẬT (không phải mẫu) thuộc một tập lớp — để neo cây theo quan hệ lớp–khoá. */
  async listCoursesByClassIds(classIds: string[]): Promise<{ courseId: string; fullName: string; classId: string }[]> {
    if (!classIds.length) return [];
    const rows = await this.handle
      .selectFrom('course')
      .select(['id as courseId', 'full_name as fullName', 'class_id as classId'])
      .where('class_id', 'in', classIds)
      .where('is_template', '=', false)
      .execute();
    return rows.filter((r): r is { courseId: string; fullName: string; classId: string } => r.classId !== null);
  }

  /** Lớp chứa từng khoá trong tập cho trước (khoá không thuộc lớp nào thì vắng khỏi kết quả). */
  async listClassesOfCourses(courseIds: string[]): Promise<{ courseId: string; classId: string; className: string; classStatus: string }[]> {
    if (!courseIds.length) return [];
    const rows = await this.handle
      .selectFrom('course')
      .innerJoin('classes', 'classes.id', 'course.class_id')
      .select(['course.id as courseId', 'course.class_id as classId', 'classes.name as className', 'classes.status as classStatus'])
      .where('course.id', 'in', courseIds)
      .execute();
    return rows.filter((r): r is { courseId: string; classId: string; className: string; classStatus: string } => r.classId !== null);
  }

  /** Tên hiển thị của một tập khoá (cho các nút khoá của cây). */
  async listCourseNames(courseIds: string[]): Promise<{ courseId: string; fullName: string }[]> {
    if (!courseIds.length) return [];
    return this.handle
      .selectFrom('course')
      .select(['id as courseId', 'full_name as fullName'])
      .where('id', 'in', courseIds)
      .execute();
  }

  /**
   * Các khoá trong tập cho trước mà user có gán vai archetype staff
   * TẠI context khoá (mức 50) — căn cứ vai "đang dạy" của nút khoá,
   * cùng định nghĩa "giáo viên của khoá" với roster.
   */
  async listTeachingCourseIds(userId: string, courseIds: string[]): Promise<string[]> {
    if (!courseIds.length) return [];
    const rows = await this.handle
      .selectFrom('role_assignments')
      .innerJoin('role', 'role.id', 'role_assignments.role_id')
      .innerJoin('context', 'context.id', 'role_assignments.context_id')
      .select('context.instance_id as courseId')
      .distinct()
      .where((eb) => eb.and([
        eb('role_assignments.user_id', '=', userId),
        eb('context.context_level', '=', 50),
        eb('context.instance_id', 'in', courseIds),
        eb('role.archetype', 'in', [...STAFF_ARCHETYPES]),
      ]))
      .execute();
    return rows.map((r) => r.courseId).filter((id): id is string => id !== null);
  }

  /** Tên của một tập course group (cho các nút nhóm con của cây). */
  async listGroupNames(groupIds: string[]): Promise<{ groupId: string; name: string; courseId: string }[]> {
    if (!groupIds.length) return [];
    return this.handle
      .selectFrom('course_groups')
      .select(['id as groupId', 'name', 'course_id as courseId'])
      .where('id', 'in', groupIds)
      // Nhóm cấu trúc "Cả lớp" (CLASS_WHOLE_GROUP_NAME của module
      // classes — kênh cả khoá do hệ tự tạo cho khoá thuộc lớp,
      // roster vật chất hoá vào đó) KHÔNG phải nhóm con do GV chia
      // nên không hiện ở mức nhóm con của cây.
      .where('name', '<>', 'Cả lớp')
      .execute();
  }

  /** Conversation CẤP KHOÁ của một tập khoá (itemType 'course') — tra "đã ensure hay chưa" cho nút cây. */
  async listCourseConversationsByCourseIds(courseIds: string[]): Promise<ConversationRow[]> {
    if (!courseIds.length) return [];
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_course')
      .where('item_type', '=', 'course')
      .where('item_id', 'in', courseIds)
      .execute() as Promise<ConversationRow[]>;
  }

  /** Conversation CẤP LỚP của một tập lớp (itemType 'class' — có từ MSG-T2; ở MSG-T1 thường rỗng). */
  async listClassConversations(classIds: string[]): Promise<ConversationRow[]> {
    if (!classIds.length) return [];
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_class')
      .where('item_type', '=', 'class')
      .where('item_id', 'in', classIds)
      .execute() as Promise<ConversationRow[]>;
  }

  /**
   * Mọi conversation gắn lớp/khoá (chat toàn khoá, chat cấp lớp) —
   * đầu vào cho hàng tổng hợp của quản trị có phạm vi nhưng chưa
   * từng mở (issue #592): service liệt kê chỉ ĐỌC tập này để tổng
   * hợp hàng, tuyệt đối không ghi dòng thành viên cho các
   * conversation đó.
   */
  async listCourseAndClassConversations(): Promise<ConversationRow[]> {
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where((eb) => eb.or([
        eb.and([eb('component', '=', 'core_course'), eb('item_type', '=', 'course')]),
        eb.and([eb('component', '=', 'core_class'), eb('item_type', '=', 'class')]),
      ]))
      .execute() as Promise<ConversationRow[]>;
  }

  /** Conversation NHÓM CON của một tập group (itemType 'groups'). */
  async listGroupConversationsByGroupIds(groupIds: string[]): Promise<ConversationRow[]> {
    if (!groupIds.length) return [];
    return this.handle
      .selectFrom('message_conversations')
      .select(CONVERSATION_COLUMNS)
      .where('component', '=', 'core_group')
      .where('item_type', '=', 'groups')
      .where('item_id', 'in', groupIds)
      .execute() as Promise<ConversationRow[]>;
  }

  // --- notification ------------------------------------------------------------
  // Phạm vi tenant của các đường ĐỌC/GHI phía user (TENANT-1, #196 —
  // lọc tầng ứng dụng, lớp phòng thủ thứ nhất; RLS fail-closed là lưới
  // cứng phía sau) do tầng service truyền tường minh qua tham số
  // `tenantId` cuối mỗi method: đang trong ngữ cảnh một tenant → chỉ
  // notification của tenant đó; ngữ cảnh platform hoặc đường nền
  // (consumer quét xuyên tenant) → undefined = không lọc thêm ở tầng
  // này. Repository không đọc ALS (xem ghi chú đầu file).

  /**
   * Chèn notification trong ứng dụng.
   */
  async insertNotification(v: NewNotification, tx?: MessagingDb): Promise<NotificationRow> {
    const db = tx ?? this.handle;
    return db
      .insertInto('notifications')
      .values(notificationInsertValues(v))
      .returning(NOTIFICATION_COLUMNS)
      .executeTakeFirstOrThrow() as Promise<NotificationRow>;
  }
  /**
   * Số notification chưa đọc (đếm bằng count(*) ở DB).
   */
  async countUnreadNotifications(userIdTo: string, tenantId?: string): Promise<number> {
    const row = await this.handle
      .selectFrom('notifications')
      .select(sql<number>`count(*)::int`.as('value'))
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('user_id_to', '=', userIdTo),
          eb('time_read', 'is', null),
        ];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .executeTakeFirst();
    return row?.value ?? 0;
  }
  /**
   * Đánh dấu một notification đã đọc.
   */
  async markNotificationRead(id: string, userIdTo: string, tenantId?: string): Promise<boolean> {
    const rows = await this.handle
      .updateTable('notifications')
      .set({ time_read: new Date() })
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('id', '=', id),
          eb('user_id_to', '=', userIdTo),
        ];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .returning('id')
      .execute();
    return rows.length > 0;
  }
  /**
   * Đánh dấu mọi notification đã đọc.
   */
  async markAllNotificationsRead(userIdTo: string, tenantId?: string): Promise<number> {
    const rows = await this.handle
      .updateTable('notifications')
      .set({ time_read: new Date() })
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('user_id_to', '=', userIdTo),
          eb('time_read', 'is', null),
        ];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .returning('id')
      .execute();
    return rows.length;
  }

  /**
   * Danh sách GỘP của trung tâm thông báo v2 (issue #51): tổng hợp
   * theo (loại × nguồn × ngày) ngay trong SQL — nguồn là `contextUrl`
   * chuẩn hoá ('' khi không có), ngày là ngày lịch Asia/Saigon. Sắp
   * xếp theo hoạt động mới nhất; phân trang keyset trên cặp
   * (max(created_at), max(id)) của dòng gộp qua mệnh đề HAVING, nên
   * không trang nào phải tải toàn bộ lịch sử về mới gộp được.
   *
   * Ba điểm ghép đoạn động (danh sách IN của `eventTypes`, mệnh đề
   * WHERE, mệnh đề HAVING) dùng `sql.join` của Kysely theo khuôn
   * T-11: tầng gọi chỉ đẩy đoạn khi danh sách tương ứng KHÔNG rỗng
   * (danh sách loại rỗng = không lọc; HAVING rỗng = không có mệnh
   * đề HAVING), và biểu thức con `latestIdExpr` mang tham số của
   * cursor nằm đúng vị trí của nó trong HAVING khi ghép.
   */
  async listNotificationGroups(userIdTo: string, opts: {
    eventTypes?: string[];
    unreadOnly?: boolean;
    cursor?: { latestAt: Date; latestId: string };
    limit: number;
  }, tenantId?: string): Promise<NotificationGroupAggregateRow[]> {
    const where: RawBuilder<unknown>[] = [sql`user_id_to = ${userIdTo}`];
    if (tenantId !== undefined) where.push(sql`tenant_id = ${tenantId}`);
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      where.push(sql`event_type in (${sql.join(opts.eventTypes.map((t) => sql`${t}`), sql`, `)})`);
    }
    // Postgres không có max(uuid): id của mục mới nhất lấy bằng
    // array_agg sắp xếp theo (created_at, id) giảm dần — cùng thứ tự
    // với neo keyset (max(created_at), id mới nhất).
    const latestIdExpr = sql`(array_agg(id order by created_at desc, id desc))[1]`;
    const having: RawBuilder<unknown>[] = [];
    if (opts.unreadOnly) having.push(sql`count(*) filter (where time_read is null) > 0`);
    if (opts.cursor) {
      having.push(sql`(max(created_at), ${latestIdExpr}) < (${opts.cursor.latestAt}::timestamptz, ${opts.cursor.latestId}::uuid)`);
    }
    const query = sql<NotificationGroupAggregateRow>`
      select
        event_type as "eventType",
        component as "component",
        coalesce(nullif(context_url, ''), '') as "sourceKey",
        to_char((created_at at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as "day",
        count(*)::int as "count",
        (count(*) filter (where time_read is null))::int as "unreadCount",
        max(created_at) as "latestAt",
        ${latestIdExpr}::text as "latestId"
      from notifications
      where ${sql.join(where, sql` and `)}
      group by event_type, component, coalesce(nullif(context_url, ''), ''), (created_at at time zone 'Asia/Ho_Chi_Minh')::date
      ${having.length > 0 ? sql`having ${sql.join(having, sql` and `)}` : sql``}
      order by max(created_at) desc, ${latestIdExpr} desc
      limit ${opts.limit}
    `;
    const res = await query.execute(this.handle);
    return res.rows;
  }

  /** Lấy các notification theo đúng tập id (điểm neo `latest` của các dòng gộp). */
  async listNotificationsByIds(ids: string[], tenantId?: string): Promise<NotificationRow[]> {
    if (ids.length === 0) return [];
    return this.handle
      .selectFrom('notifications')
      .select(NOTIFICATION_COLUMNS)
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [eb('id', 'in', ids)];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .execute() as Promise<NotificationRow[]>;
  }

  /**
   * Danh sách PHẲNG của trung tâm v2: phân trang keyset theo
   * (createdAt, id) giảm dần; bộ lọc (loại × nguồn × ngày) mở chi
   * tiết đúng một dòng gộp, `day` so theo ngày lịch Asia/Saigon như
   * khoá gộp để hai đường không bao giờ lệch nhau.
   */
  async listNotificationItems(userIdTo: string, opts: NotificationItemsOptions, tenantId?: string): Promise<NotificationRow[]> {
    return this.handle
      .selectFrom('notifications')
      .select(NOTIFICATION_COLUMNS)
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [eb('user_id_to', '=', userIdTo)];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        if (opts.eventType) conds.push(eb('event_type', '=', opts.eventType));
        if (opts.eventTypes && opts.eventTypes.length > 0) conds.push(eb('event_type', 'in', opts.eventTypes));
        if (opts.source === null) {
          conds.push(sql<SqlBool>`coalesce(nullif(context_url, ''), '') = ''`);
        } else if (typeof opts.source === 'string') {
          conds.push(eb('context_url', '=', opts.source));
        }
        if (opts.day) {
          conds.push(sql<SqlBool>`to_char((created_at at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') = ${opts.day}`);
        }
        if (opts.unreadOnly) conds.push(eb('time_read', 'is', null));
        if (opts.cursor) {
          conds.push(sql<SqlBool>`(created_at, id) < (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`);
        }
        return eb.and(conds);
      })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(opts.limit)
      .execute() as Promise<NotificationRow[]>;
  }

  /**
   * Đánh dấu đã đọc HÀNG LOẠT theo khoá gộp (loại × nguồn × ngày)
   * của trung tâm v2: chỉ các mục chưa đọc thuộc đúng khoá mới đổi.
   */
  async markNotificationGroupRead(userIdTo: string, key: { eventType: string; sourceKey: string; day: string }, tenantId?: string): Promise<number> {
    const rows = await this.handle
      .updateTable('notifications')
      .set({ time_read: new Date() })
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('user_id_to', '=', userIdTo),
          eb('event_type', '=', key.eventType),
          eb('time_read', 'is', null),
          sql<SqlBool>`coalesce(nullif(context_url, ''), '') = ${key.sourceKey}`,
          sql<SqlBool>`to_char((created_at at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') = ${key.day}`,
        ];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .returning('id')
      .execute();
    return rows.length;
  }

  /** Xoá MỘT notification của đúng chủ sở hữu; false khi không tồn tại hoặc không phải của họ. */
  async deleteNotification(id: string, userIdTo: string, tenantId?: string): Promise<boolean> {
    const rows = await this.handle
      .deleteFrom('notifications')
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('id', '=', id),
          eb('user_id_to', '=', userIdTo),
        ];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .returning('id')
      .execute();
    return rows.length > 0;
  }

  /** Dọn mọi notification ĐÃ ĐỌC của user (trung tâm v2); trả số mục đã xoá. */
  async deleteReadNotifications(userIdTo: string, tenantId?: string): Promise<number> {
    const rows = await this.handle
      .deleteFrom('notifications')
      .where((eb) => {
        const conds: Expression<SqlBool>[] = [
          eb('user_id_to', '=', userIdTo),
          eb('time_read', 'is not', null),
        ];
        if (tenantId !== undefined) conds.push(eb('tenant_id', '=', tenantId));
        return eb.and(conds);
      })
      .returning('id')
      .execute();
    return rows.length;
  }

  /**
   * Còn notification CHƯA ĐỌC của (user, loại sự kiện, ngữ cảnh) hay
   * không — căn cứ gộp thông báo tin nhắn mới theo conversation của
   * consumer thông báo sự kiện ở worker: còn một bản chưa đọc thì
   * các tin tiếp theo trong cùng conversation không sinh thêm bản
   * nữa.
   */
  async hasUnreadNotification(userIdTo: string, eventType: string, contextUrl: string): Promise<boolean> {
    const row = await this.handle
      .selectFrom('notifications')
      .select('id')
      .where('user_id_to', '=', userIdTo)
      .where('event_type', '=', eventType)
      .where('context_url', '=', contextUrl)
      .where('time_read', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Thông tin tối thiểu của một grade item để consumer thông báo điểm
   * mới quyết định có phát hay không (bỏ qua tổng khoá/tổng hạng mục/
   * item công thức và item bị ẩn) và dựng nội dung không chứa điểm số.
   */
  async getGradeItemNotifyInfo(itemId: string): Promise<{ itemType: string; itemName: string; hidden: boolean; courseId: string } | undefined> {
    return this.handle
      .selectFrom('grade_items')
      .select(['item_type as itemType', 'item_name as itemName', 'hidden', 'course_id as courseId'])
      .where('id', '=', itemId)
      .executeTakeFirst();
  }

  /**
   * Điểm của user trên item có đang bị ẩn với chính user đó không
   * (grade_grades.hidden — điểm bị giáo viên ẩn thì học sinh không
   * nhận thông báo điểm mới).
   */
  async isGradeHiddenForUser(itemId: string, userId: string): Promise<boolean> {
    const row = await this.handle
      .selectFrom('grade_grades')
      .select('hidden')
      .where('item_id', '=', itemId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return row?.hidden ?? false;
  }

  /** Tên đầy đủ của khoá học để dựng nội dung thông báo. */
  async getCourseFullName(courseId: string): Promise<string | undefined> {
    const row = await this.handle
      .selectFrom('course')
      .select('full_name as fullName')
      .where('id', '=', courseId)
      .executeTakeFirst();
    return row?.fullName;
  }

  // --- thông tin hoạt động cho consumer NB-1 (issue #174) ---------------------
  // Đọc thẳng bảng assignments/quizzes/course_modules/course qua barrel
  // schema, cùng kỷ luật "đọc bảng dùng chung, không import module
  // khác" như các helper phía trên. Trạng thái hiển thị của module
  // (visible/deletionInProgress) + của khoá là cổng phát: học sinh
  // không thấy hoạt động thì không nhận thông báo về nó — cùng ngữ
  // nghĩa worker nhắc hạn dùng cho quiz.

  /**
   * Thông tin tối thiểu của một bài tập để consumer quyết định phát
   * assignment_assigned/assignment_submitted/assignment_returned và
   * dựng nội dung: tên, khoá, trạng thái hiển thị của khoá + module.
   */
  async getAssignmentNotifyInfo(assignmentId: string): Promise<{
    name: string; courseId: string; courseVisible: boolean; cmVisible: boolean | null; cmDeletionInProgress: boolean | null;
  } | undefined> {
    return this.handle
      .selectFrom('assignments')
      .innerJoin('course', 'course.id', 'assignments.course')
      .leftJoin('course_modules', 'course_modules.id', 'assignments.cm_id')
      .select([
        'assignments.name as name',
        'assignments.course as courseId',
        'course.visible as courseVisible',
        'course_modules.visible as cmVisible',
        'course_modules.deletion_in_progress as cmDeletionInProgress',
      ])
      .where('assignments.id', '=', assignmentId)
      .executeTakeFirst();
  }

  /** Như trên cho một quiz (assignment → quiz_available / quiz_attempt_finished). */
  async getPinNotifyInfo(pinId: string): Promise<{
    name: string; courseId: string; courseVisible: boolean; cmVisible: boolean | null; cmDeletionInProgress: boolean | null;
  } | undefined> {
    return this.handle
      .selectFrom('exam_pins')
      .innerJoin('exam_versions', 'exam_versions.id', 'exam_pins.exam_version_id')
      .innerJoin('course', 'course.id', 'exam_pins.course_id')
      .leftJoin('course_modules', 'course_modules.id', 'exam_pins.cm_id')
      .select([
        sql<string>`coalesce(exam_pins.name, exam_versions.name)`.as('name'),
        'exam_pins.course_id as courseId',
        'course.visible as courseVisible',
        'course_modules.visible as cmVisible',
        'course_modules.deletion_in_progress as cmDeletionInProgress',
      ])
      .where('exam_pins.id', '=', pinId)
      .executeTakeFirst();
  }

  /**
   * Số bài nộp của một bài tập đang CHỜ CHẤM tại thời điểm gọi: bản
   * nộp ở trạng thái submitted mà gói chấm của đúng lần nộp đó chưa
   * được trả bài (assign_grades khớp attempt_number, status khác
   * 'released' hoặc chưa có gói chấm) — con số trong nội dung thông
   * báo gộp assignment_submitted cho giáo viên (P5, issue #174).
   */
  async countAssignmentSubmissionsAwaitingGrading(assignmentId: string): Promise<number> {
    const rows = await this.handle
      .selectFrom('assign_submissions')
      .leftJoin('assign_grades', (join) => join
        .onRef('assign_grades.assignment_id', '=', 'assign_submissions.assignment_id')
        .onRef('assign_grades.user_id', '=', 'assign_submissions.user_id')
        .onRef('assign_grades.attempt_number', '=', 'assign_submissions.attempt_number'))
      .select('assign_submissions.id as id')
      .where((eb) => eb.and([
        eb('assign_submissions.assignment_id', '=', assignmentId),
        eb('assign_submissions.status', '=', 'submitted'),
        eb.or([
          eb('assign_grades.id', 'is', null),
          eb('assign_grades.status', '<>', 'released'),
        ]),
      ]))
      .execute();
    return rows.length;
  }

  /** Số lượt làm của một lần ghim đang ở trạng thái cần chấm tay (không tính lượt preview của giáo viên). */
  async countPinAttemptsNeedingGrading(pinId: string): Promise<number> {
    const rows = await this.handle
      .selectFrom('exam_attempts')
      .select('id')
      .where('pin_id', '=', pinId)
      .where('state', '=', 'needsgrading')
      .where('preview', '=', false)
      .execute();
    return rows.length;
  }

  /**
   * Bản notification CHƯA ĐỌC đại diện cho một (user, loại, ngữ cảnh)
   * — căn cứ GỘP của NB-1 như hasUnreadNotification nhưng trả cả dòng
   * để consumer CẬP NHẬT nội dung (số lượng chờ chấm mới nhất) thay vì
   * sinh bản mới (P5: một thông báo gộp cập nhật số lượng).
   */
  async getUnreadNotification(userIdTo: string, eventType: string, contextUrl: string): Promise<NotificationRow | undefined> {
    return this.handle
      .selectFrom('notifications')
      .select(NOTIFICATION_COLUMNS)
      .where('user_id_to', '=', userIdTo)
      .where('event_type', '=', eventType)
      .where('context_url', '=', contextUrl)
      .where('time_read', 'is', null)
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst() as Promise<NotificationRow | undefined>;
  }

  /** Cập nhật nội dung một notification đang tồn tại (chỉ dùng cho bản gộp chưa đọc của NB-1). */
  async updateNotificationContent(id: string, subject: string, fullMessage: string): Promise<void> {
    await this.handle
      .updateTable('notifications')
      .set({ subject, full_message: fullMessage, small_message: fullMessage.slice(0, 200) })
      .where('id', '=', id)
      .execute();
  }

  /** Tenant sở hữu khoá học (TENANT-1, #196) — nguồn tenant cho notification/dữ liệu phát sinh từ khoá. */
  async getCourseTenantId(courseId: string): Promise<string | null> {
    const row = await this.handle
      .selectFrom('course')
      .select('tenant_id as tenantId')
      .where('id', '=', courseId)
      .executeTakeFirst();
    return row?.tenantId ?? null;
  }

  /**
   * Tenant của một conversation (TENANT-1, #196) — nguồn tenant cho
   * notification tin nhắn mới. Cài đặt truy vấn ở bề mặt đọc dùng
   * chung `@lms/messaging` — repository chỉ uỷ quyền (issue #521).
   */
  async getConversationTenantId(conversationId: string): Promise<string | null> {
    return this.store.getConversationTenantId(conversationId);
  }

  /**
   * Tenant mặc định của một user (TENANT-1, #196) — cùng luật với
   * `TenantsService.resolveDefaultTenant` (TENANT-0): membership active
   * duy nhất → tenant đó; nhiều tenant → tenant trường đầu tiên;
   * không có → tenant platform (Trang chính). Dùng làm nguồn tenant
   * cuối cùng cho notification khi nơi phát không gắn đối tượng nguồn
   * thuộc tenant nào (bảng users KHÔNG có cột tenant — tư cách thành
   * viên mới là nguồn sự thật).
   */
  async getUserDefaultTenantId(userId: string): Promise<string | null> {
    const rows = await this.handle
      .selectFrom('tenant_memberships')
      .innerJoin('tenants', 'tenants.id', 'tenant_memberships.tenant_id')
      .select(['tenant_memberships.tenant_id as tenantId', 'tenants.kind as kind'])
      .where('tenant_memberships.user_id', '=', userId)
      .where('tenant_memberships.status', '=', 'active')
      .where('tenants.status', '=', 'active')
      .execute();
    const distinct = [...new Map(rows.map((r) => [r.tenantId, r])).values()];
    if (distinct.length === 1) return distinct[0]!.tenantId;
    if (distinct.length > 1) {
      const nonPlatform = distinct.find((r) => r.kind !== 'platform');
      if (nonPlatform) return nonPlatform.tenantId;
    }
    const zero = await this.handle
      .selectFrom('tenants')
      .select('id')
      .where('kind', '=', 'platform')
      .executeTakeFirst();
    return zero?.id ?? null;
  }

  /**
   * Ghi nhật ký một lần dispatch notification qua kênh.
   */
  async insertDispatchLog(v: NewDispatchLog, tx?: MessagingDb): Promise<DispatchLogRow> {
    const db = tx ?? this.handle;
    const row = await db
      .insertInto('notification_dispatch_log')
      .values(dispatchLogInsertValues(v))
      .onConflict((oc) => oc.column('dedupe_key').doNothing())
      .returning(DISPATCH_LOG_COLUMNS)
      .executeTakeFirst();
    if (row) return row as DispatchLogRow;
    // Trùng dedupe_key: đọc lại dòng đã ghi của lần dispatch trước —
    // giữ đúng đường đọc của bản cũ (qua handle gốc, không qua tx).
    const existing = await this.handle
      .selectFrom('notification_dispatch_log')
      .select(DISPATCH_LOG_COLUMNS)
      .where('dedupe_key', '=', v.dedupeKey!)
      .executeTakeFirstOrThrow();
    return existing as DispatchLogRow;
  }
  /**
   * Nhật ký dispatch (kiểm chứng gửi).
   */
  async listDispatchLog(userId: string): Promise<DispatchLogRow[]> {
    return this.handle
      .selectFrom('notification_dispatch_log')
      .select(DISPATCH_LOG_COLUMNS)
      .where('user_id', '=', userId)
      .orderBy('id', 'asc')
      .execute() as Promise<DispatchLogRow[]>;
  }
}
