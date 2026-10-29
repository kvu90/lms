import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  message,
  messageConversationMembers,
  messageConversations,
  messageUserDeletions,
  messageUsersBlocked,
} from '@lms/db';
import {
  messageQuoteOf,
  type ConversationRow,
  type MessageRow,
  type MessageWithQuoteRow,
} from './message-wire.js';

/**
 * Bề mặt ĐỌC dữ kiện messaging dùng chung giữa hai tiến trình
 * (issue #521): repository phía API (đường đọc REST/sync) và consumer
 * phân phối realtime phía worker cùng chạy MỘT cài đặt truy vấn ở
 * package này — luật đọc (lọc tin đã xoá, đếm chưa đọc theo mốc của
 * chính người nhận, dựng trích dẫn theo quyền người xem...) không
 * được phép có hai bản cài đặt lệch nhau giữa nơi hiển thị và nơi
 * phân phối.
 *
 * Các hàm thuần nhận `db` làm tham số đầu: mỗi app truyền kết nối
 * Drizzle của chính nó (kèm ngữ cảnh tenant/RLS của app đó); package
 * không giữ kết nối và không phụ thuộc framework nào.
 */
export type MessagingDatabase = NodePgDatabase;

/** Tuỳ chọn cửa sổ tin theo cursor seq. */
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

/** Lấy conversation theo id. */
export async function getConversationById(db: MessagingDatabase, id: string): Promise<ConversationRow | undefined> {
  const [row] = await db.select().from(messageConversations).where(eq(messageConversations.id, id));
  return row;
}

/** Thành viên của conversation. */
export async function listConversationMemberIds(db: MessagingDatabase, conversationId: string): Promise<string[]> {
  const rows = await db.select().from(messageConversationMembers).where(eq(messageConversationMembers.conversationId, conversationId));
  return rows.map((r) => r.userId);
}

/** Tenant của một conversation (TENANT-1, #196) — nguồn tenant cho notification tin nhắn mới. */
export async function getConversationTenantId(db: MessagingDatabase, conversationId: string): Promise<string | null> {
  const [row] = await db.select({ tenantId: messageConversations.tenantId }).from(messageConversations)
    .where(eq(messageConversations.id, conversationId));
  return row?.tenantId ?? null;
}

/** Lấy tin nhắn theo id. */
export async function getMessageById(db: MessagingDatabase, id: string): Promise<MessageRow | undefined> {
  const [row] = await db.select().from(message).where(eq(message.id, id));
  return row;
}

/** Lấy nhiều dòng tin theo id (kiểm tra thẩm quyền hàng loạt trước khi gỡ). */
export async function getMessagesByIds(db: MessagingDatabase, ids: string[]): Promise<MessageRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(message).where(inArray(message.id, ids));
}

/**
 * Một cửa sổ tin của conversation theo cursor seq, luôn trả tăng dần
 * theo seq. Không cursor: cửa sổ MỚI NHẤT (limit tin cuối). beforeSeq:
 * cửa sổ ngay trước mốc. afterSeq: các tin sau mốc (đồng bộ thiếu hụt).
 */
export async function listMessagesPage(db: MessagingDatabase, conversationId: string, opts: MessageWindowOptions = {}): Promise<MessageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const where = [eq(message.conversationId, conversationId)];
  // Mặc định: tin đã xoá mềm bị lọc khỏi MỌI cửa sổ đọc — chỉ cửa sổ
  // truy vết của người có thẩm quyền mới truyền includeDeleted.
  if (!opts.includeDeleted) where.push(isNull(message.deletedAt));
  // Cờ xoá-phía-mình của người xem (vòng đời theo vai): chỉ áp ở
  // đường đọc thường — chế độ truy vết phải thấy đầy đủ dấu vết.
  if (opts.viewerId && !opts.includeDeleted) {
    where.push(sql`not exists (select 1 from ${messageUserDeletions} d where d.message_id = ${message.id} and d.user_id = ${opts.viewerId})`);
  }
  if (opts.afterSeq !== undefined) {
    where.push(gt(message.seq, opts.afterSeq));
    return db.select().from(message).where(and(...where)).orderBy(asc(message.seq)).limit(limit);
  }
  if (opts.beforeSeq !== undefined) where.push(lt(message.seq, opts.beforeSeq));
  const rows = await db.select().from(message).where(and(...where)).orderBy(desc(message.seq)).limit(limit);
  return rows.reverse();
}

/** Trong tập id này, các tin user đã đặt cờ xoá-phía-mình (lọc cá nhân của vòng đời tin nhắn). */
export async function listDeletedForUserIds(db: MessagingDatabase, messageIds: string[], userId: string): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db.select({ messageId: messageUserDeletions.messageId })
    .from(messageUserDeletions)
    .where(and(inArray(messageUserDeletions.messageId, messageIds), eq(messageUserDeletions.userId, userId)));
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
  const [row] = await db.select({ lastReadSeq: messageConversationMembers.lastReadSeq })
    .from(messageConversationMembers)
    .where(and(eq(messageConversationMembers.conversationId, conversationId), eq(messageConversationMembers.userId, userId)));
  return row?.lastReadSeq;
}

/**
 * Số tin chưa đọc của MỘT user trong MỘT conversation (đếm bằng
 * count(*) theo mốc đã đọc của chính user — consumer realtime dùng
 * để gửi kèm sự kiện cập nhật cho từng người nhận).
 */
export async function countUnreadForConversation(db: MessagingDatabase, conversationId: string, userId: string): Promise<number> {
  const lastReadSeq = await getMemberLastReadSeq(db, conversationId, userId);
  if (lastReadSeq === undefined) return 0;
  const [row] = await db.select({ value: sql<number>`count(*)::int` }).from(message)
    .where(and(
      eq(message.conversationId, conversationId),
      gt(message.seq, lastReadSeq),
      ne(message.userIdFrom, userId),
      isNull(message.deletedAt),
      // Tin đã thu hồi không còn gì để đọc; tin user đã xoá-phía-mình
      // không thuộc tầm nhìn của họ — cả hai đều không đếm chưa đọc.
      isNull(message.recalledAt),
      sql`not exists (select 1 from ${messageUserDeletions} d where d.message_id = ${message.id} and d.user_id = ${userId})`,
    ));
  return row?.value ?? 0;
}

/** Danh sách user bị chặn. */
export async function listBlockedUserIds(db: MessagingDatabase, userId: string): Promise<string[]> {
  const rows = await db.select().from(messageUsersBlocked).where(eq(messageUsersBlocked.userId, userId));
  return rows.map((r) => r.blockedUserId);
}

/**
 * Danh sách user ĐÃ CHẶN user này (chiều ngược của listBlockedUserIds) —
 * danh sách thành viên khoá dùng để giấu phía chặn khỏi roster của
 * phía bị chặn, khớp ngữ nghĩa chặn hiện có.
 */
export async function listBlockerUserIds(db: MessagingDatabase, userId: string): Promise<string[]> {
  const rows = await db.select().from(messageUsersBlocked).where(eq(messageUsersBlocked.blockedUserId, userId));
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

/** Dựng bề mặt đọc phân phối trên một kết nối Drizzle của app gọi. */
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
