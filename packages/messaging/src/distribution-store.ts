import { sql, type SqlBool } from '@lms/db';
import type { CentreDb, CentreTx } from '@lms/db';
import type {
  ConversationRow,
  MessageRow,
  MessageWindowOptions,
  MessageWithQuoteRow,
  MessagingStorePort,
} from '@lms/db/repositories/messaging';
import { messageQuoteOf } from './message-wire.js';

/**
 * Bề mặt ĐỌC dữ kiện messaging dùng chung giữa hai tiến trình
 * (issue #521): repository phía API (đường đọc REST/sync) và consumer
 * phân phối realtime phía worker cùng chạy MỘT cài đặt truy vấn ở
 * package này — luật đọc (lọc tin đã xoá, đếm chưa đọc theo mốc của
 * chính người nhận, dựng trích dẫn theo quyền người xem...) không
 * được phép có hai bản cài đặt lệch nhau giữa nơi hiển thị và nơi
 * phân phối.
 *
 * Các hàm thuần nhận `db` làm tham số đầu: mỗi app truyền handle
 * Kysely của chính nó (kèm ngữ cảnh tenant/RLS của app đó); package
 * không giữ kết nối và không phụ thuộc framework nào. Handle là
 * handle kho trung tâm của `@lms/db` (`CentreDb` hoặc handle giao
 * dịch `CentreTx`). Package không khai phụ thuộc trực tiếp vào
 * `kysely` (đóng băng ở nền của chiến dịch): hàm `sql` của Kysely
 * được lấy qua kênh re-export chính thức ở barrel của `@lms/db`
 * dành cho phía tiêu thụ, còn kiểu dòng và cổng store lấy type-only
 * từ `@lms/db/repositories/messaging` — chiều phụ thuộc giữ là DAG
 * vì `@lms/db` không import package này ở bất kỳ dạng nào
 * (issue #658: gỡ vòng phụ thuộc `@lms/db` ↔ `@lms/messaging`).
 */
export type MessagingDatabase = CentreDb | CentreTx;

/** Hình dạng cửa sổ tin được khai tại `@lms/db/repositories/messaging` — re-export để bề mặt package giữ nguyên. */
export type { MessageWindowOptions } from '@lms/db/repositories/messaging';

// Danh sách cột đọc tường minh kèm bí danh camelCase — cùng hình
// dạng với danh sách cột của repository tại `@lms/db` (khai cục bộ
// ở đây để tầng store không phải import module repository).

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

/** Lấy conversation theo id. */
export async function getConversationById(db: MessagingDatabase, id: string): Promise<ConversationRow | undefined> {
  return db
    .selectFrom('message_conversations')
    .select(CONVERSATION_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst() as Promise<ConversationRow | undefined>;
}

/** Thành viên của conversation. */
export async function listConversationMemberIds(db: MessagingDatabase, conversationId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('message_conversation_members')
    .select('user_id as userId')
    .where('conversation_id', '=', conversationId)
    .execute();
  return rows.map((r) => r.userId);
}

/** Tenant của một conversation (TENANT-1, #196) — nguồn tenant cho notification tin nhắn mới. */
export async function getConversationTenantId(db: MessagingDatabase, conversationId: string): Promise<string | null> {
  const row = await db
    .selectFrom('message_conversations')
    .select('tenant_id as tenantId')
    .where('id', '=', conversationId)
    .executeTakeFirst();
  return row?.tenantId ?? null;
}

/** Lấy tin nhắn theo id. */
export async function getMessageById(db: MessagingDatabase, id: string): Promise<MessageRow | undefined> {
  return db
    .selectFrom('message')
    .select(MESSAGE_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst() as Promise<MessageRow | undefined>;
}

/** Lấy nhiều dòng tin theo id (kiểm tra thẩm quyền hàng loạt trước khi gỡ). */
export async function getMessagesByIds(db: MessagingDatabase, ids: string[]): Promise<MessageRow[]> {
  if (ids.length === 0) return [];
  return db
    .selectFrom('message')
    .select(MESSAGE_COLUMNS)
    .where('id', 'in', ids)
    .execute() as Promise<MessageRow[]>;
}

/**
 * Một cửa sổ tin của conversation theo cursor seq, luôn trả tăng dần
 * theo seq. Không cursor: cửa sổ MỚI NHẤT (limit tin cuối). beforeSeq:
 * cửa sổ ngay trước mốc. afterSeq: các tin sau mốc (đồng bộ thiếu hụt).
 */
export async function listMessagesPage(db: MessagingDatabase, conversationId: string, opts: MessageWindowOptions = {}): Promise<MessageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  let base = db
    .selectFrom('message')
    .select(MESSAGE_COLUMNS)
    .where('conversation_id', '=', conversationId);
  // Mặc định: tin đã xoá mềm bị lọc khỏi MỌI cửa sổ đọc — chỉ cửa sổ
  // truy vết của người có thẩm quyền mới truyền includeDeleted.
  if (!opts.includeDeleted) base = base.where('deleted_at', 'is', null);
  // Cờ xoá-phía-mình của người xem (vòng đời theo vai): chỉ áp ở
  // đường đọc thường — chế độ truy vết phải thấy đầy đủ dấu vết.
  if (opts.viewerId && !opts.includeDeleted) {
    const viewerId = opts.viewerId;
    base = base.where(sql<SqlBool>`not exists (select 1 from message_user_deletions d where d.message_id = message.id and d.user_id = ${viewerId})`);
  }
  if (opts.afterSeq !== undefined) {
    return base
      .where('seq', '>', opts.afterSeq)
      .orderBy('seq', 'asc')
      .limit(limit)
      .execute() as Promise<MessageRow[]>;
  }
  if (opts.beforeSeq !== undefined) base = base.where('seq', '<', opts.beforeSeq);
  const rows = await base.orderBy('seq', 'desc').limit(limit).execute();
  return (rows as MessageRow[]).reverse();
}

/** Trong tập id này, các tin user đã đặt cờ xoá-phía-mình (lọc cá nhân của vòng đời tin nhắn). */
export async function listDeletedForUserIds(db: MessagingDatabase, messageIds: string[], userId: string): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .selectFrom('message_user_deletions')
    .select('message_id as messageId')
    .where('message_id', 'in', messageIds)
    .where('user_id', '=', userId)
    .execute();
  return new Set(rows.map((r) => r.messageId));
}

/**
 * Gắn khối trích dẫn (lát M3, issue #229) cho một lô tin: tra lô
 * các tin gốc một lần (không N+1), dựng quote theo quyền của người
 * nhận bằng {@link messageQuoteOf}. Tin gốc tra không thấy (chỉ
 * còn xảy ra khi khoá ngoại chưa kịp set null sau xoá cứng) hoặc
 * thuộc conversation khác (dữ liệu không thể sinh qua đường gửi —
 * gác ở service) thì `replyTo = null`: hiển thị như tin thường,
 * không dựng khối trích dẫn rỗng.
 *
 * `viewerId` chỉ áp khi KHÔNG privileged: tin gốc bị chính người
 * xem xoá-phía-mình thì quote thành unavailable như đã xoá. Đường
 * realtime phân phối theo room dùng privileged=false và KHÔNG
 * truyền viewerId (khối trích dẫn là dữ kiện chung của room; việc
 * cá nhân hoá xoá-phía-mình chốt ở các đường đọc REST/sync vốn có
 * viewerId — người đã ẩn tin gốc vốn đã thấy nó khi còn là thành
 * viên nên đây không phải kênh lộ nội dung mới).
 */
export async function attachQuotesToRows(
  db: MessagingDatabase,
  rows: MessageRow[],
  opts: { privileged: boolean; viewerId?: string },
): Promise<MessageWithQuoteRow[]> {
  const originalIds = [...new Set(rows.map((r) => r.replyToMessageId).filter((id): id is string => id !== null))];
  if (originalIds.length === 0) return rows.map((r) => ({ ...r, replyTo: null }));
  const originals = await getMessagesByIds(db, originalIds);
  const byId = new Map(originals.map((o) => [o.id, o]));
  const deletedForViewer = !opts.privileged && opts.viewerId
    ? await listDeletedForUserIds(db, originalIds, opts.viewerId)
    : new Set<string>();
  return rows.map((r) => {
    if (!r.replyToMessageId) return { ...r, replyTo: null };
    const original = byId.get(r.replyToMessageId);
    if (!original || original.conversationId !== r.conversationId) return { ...r, replyTo: null };
    return {
      ...r,
      replyTo: messageQuoteOf(original, {
        privileged: opts.privileged,
        deletedForViewer: deletedForViewer.has(original.id),
      }),
    };
  });
}

/** Mốc đã đọc của một thành viên (undefined nếu không phải thành viên). */
export async function getMemberLastReadSeq(db: MessagingDatabase, conversationId: string, userId: string): Promise<number | undefined> {
  const row = await db
    .selectFrom('message_conversation_members')
    .select('last_read_seq as lastReadSeq')
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return row?.lastReadSeq;
}

/**
 * Số tin chưa đọc của MỘT user trong MỘT conversation (đếm bằng
 * count(*) theo mốc đã đọc của chính user — consumer realtime dùng
 * để gửi kèm sự kiện cập nhật cho từng người nhận).
 *
 * Vũ trụ đếm chuẩn (issue #592): hội thoại đã TẮT TIẾNG không đóng
 * góp số chưa đọc cho bất kỳ bề mặt nào — kể cả số kèm sự kiện
 * realtime — nên hàm trả 0 ngay khi dòng thành viên mang cờ tắt
 * tiếng, dù tin chưa đọc vẫn còn trong hộp thư. Tin vẫn tới và mốc
 * đã đọc vẫn cập nhật bình thường; chỉ số đếm hiển thị là 0 cho
 * tới khi bật tiếng lại.
 */
export async function countUnreadForConversation(db: MessagingDatabase, conversationId: string, userId: string): Promise<number> {
  const member = await db
    .selectFrom('message_conversation_members')
    .select(['last_read_seq as lastReadSeq', 'muted'])
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (!member || member.muted) return 0;
  const lastReadSeq = member.lastReadSeq;
  const row = await db
    .selectFrom('message')
    .select(sql<number>`count(*)::int`.as('value'))
    .where((eb) => eb.and([
      eb('conversation_id', '=', conversationId),
      eb('seq', '>', lastReadSeq),
      eb('user_id_from', '<>', userId),
      eb('deleted_at', 'is', null),
      // Tin đã thu hồi không còn gì để đọc; tin user đã xoá-phía-mình
      // không thuộc tầm nhìn của họ — cả hai đều không đếm chưa đọc.
      eb('recalled_at', 'is', null),
      sql<SqlBool>`not exists (select 1 from message_user_deletions d where d.message_id = message.id and d.user_id = ${userId})`,
    ]))
    .executeTakeFirst();
  return row?.value ?? 0;
}

/** Danh sách user bị chặn. */
export async function listBlockedUserIds(db: MessagingDatabase, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('message_users_blocked')
    .select('blocked_user_id as blockedUserId')
    .where('user_id', '=', userId)
    .execute();
  return rows.map((r) => r.blockedUserId);
}

/**
 * Danh sách user ĐÃ CHẶN user này (chiều ngược của listBlockedUserIds) —
 * danh sách thành viên khoá dùng để giấu phía chặn khỏi roster của
 * phía bị chặn, khớp ngữ nghĩa chặn hiện có.
 */
export async function listBlockerUserIds(db: MessagingDatabase, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('message_users_blocked')
    .select('user_id as userId')
    .where('blocked_user_id', '=', userId)
    .execute();
  return rows.map((r) => r.userId);
}

/**
 * Mọi user đang có quan hệ chặn với user này ở BẤT KỲ chiều nào
 * (người mình chặn ∪ người chặn mình) — tập "đối tác bị chặn" dùng
 * cho các luật ẩn bề mặt 1–1 (presence, mốc đã đọc).
 */
export async function listBlockedCounterpartIds(db: MessagingDatabase, userId: string): Promise<string[]> {
  const [blocked, blockers] = await Promise.all([listBlockedUserIds(db, userId), listBlockerUserIds(db, userId)]);
  return [...new Set([...blocked, ...blockers])];
}

/**
 * Dựng cài đặt của cổng store dùng chung {@link MessagingStorePort}
 * (khai tại `@lms/db/repositories/messaging`) trên một handle
 * Kysely của app gọi: phía API gắn cài đặt này vào
 * `MessagingRepository` — repository uỷ quyền mọi phép đọc dùng
 * chung qua cổng này thay vì import trực tiếp các hàm ở đây.
 */
export function createMessagingStore(db: MessagingDatabase): MessagingStorePort {
  return {
    getConversationById: (id) => getConversationById(db, id),
    listConversationMemberIds: (conversationId) => listConversationMemberIds(db, conversationId),
    getConversationTenantId: (conversationId) => getConversationTenantId(db, conversationId),
    getMessageById: (id) => getMessageById(db, id),
    getMessagesByIds: (ids) => getMessagesByIds(db, ids),
    listDeletedForUserIds: (messageIds, userId) => listDeletedForUserIds(db, messageIds, userId),
    attachQuotesToRows: (rows, opts) => attachQuotesToRows(db, rows, opts),
    getMemberLastReadSeq: (conversationId, userId) => getMemberLastReadSeq(db, conversationId, userId),
    countUnreadForConversation: (conversationId, userId) => countUnreadForConversation(db, conversationId, userId),
    listMessagesPage: (conversationId, opts) => listMessagesPage(db, conversationId, opts),
    listBlockedUserIds: (userId) => listBlockedUserIds(db, userId),
    listBlockerUserIds: (userId) => listBlockerUserIds(db, userId),
    listBlockedCounterpartIds: (userId) => listBlockedCounterpartIds(db, userId),
  };
}

/**
 * Bề mặt đọc mà tầng phân phối realtime cần — đúng các phép đọc của
 * luật phân phối, không hơn: consumer phía worker chỉ được chạm dữ
 * kiện qua bề mặt này (cùng cài đặt với đường đọc phía API).
 */
export interface MessagingDistributionStore {
  getMessage(id: string): Promise<MessageRow | undefined>;
  listMembers(conversationId: string): Promise<string[]>;
  getConversation(id: string): Promise<ConversationRow | undefined>;
  getConversationTenantId(conversationId: string): Promise<string | null>;
  listBlockedCounterpartIds(userId: string): Promise<string[]>;
  attachQuotes(rows: MessageRow[], opts: { privileged: boolean; viewerId?: string }): Promise<MessageWithQuoteRow[]>;
  countUnreadForConversation(conversationId: string, userId: string): Promise<number>;
  listMessages(conversationId: string, opts?: MessageWindowOptions): Promise<MessageRow[]>;
}

/** Dựng bề mặt đọc phân phối trên một handle Kysely của app gọi. */
export function createMessagingDistributionStore(db: MessagingDatabase): MessagingDistributionStore {
  return {
    getMessage: (id) => getMessageById(db, id),
    listMembers: (conversationId) => listConversationMemberIds(db, conversationId),
    getConversation: (id) => getConversationById(db, id),
    getConversationTenantId: (conversationId) => getConversationTenantId(db, conversationId),
    listBlockedCounterpartIds: (userId) => listBlockedCounterpartIds(db, userId),
    attachQuotes: (rows, opts) => attachQuotesToRows(db, rows, opts),
    countUnreadForConversation: (conversationId, userId) => countUnreadForConversation(db, conversationId, userId),
    listMessages: (conversationId, opts) => listMessagesPage(db, conversationId, opts),
  };
}
