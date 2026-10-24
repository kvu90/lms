import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  context, course, courseGroups, enrol, gradeGrades, gradeItems, groupsMembers,
  message, messageContacts, messageContactRequests, messageConversationMembers, messageConversationReports, messageConversations, messageUsersBlocked,
  notificationDispatchLog, notifications, role, roleAssignments, userEnrolments, users,
} from '../../db/schema';

export type ConversationRow = typeof messageConversations.$inferSelect;
export type MessageRow = typeof message.$inferSelect;

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
}

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
}
export type NotificationRow = typeof notifications.$inferSelect;

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
export type DispatchLogRow = typeof notificationDispatchLog.$inferSelect;
export type ContactRow = typeof messageContacts.$inferSelect;
export type ContactRequestRow = typeof messageContactRequests.$inferSelect;
export type ReportRow = typeof messageConversationReports.$inferSelect;
export type CourseGroupRow = typeof courseGroups.$inferSelect;

/**
 * Các archetype vai trò được coi là "staff" cho các cổng nghiệp vụ của
 * Lớp B (tạo nhóm tự do, quản lý conversation): quản lý, người tạo
 * khoá, giáo viên có/không quyền sửa. Học sinh (archetype student) và
 * các vai trò mặc định (user/guest) KHÔNG nằm trong tập này.
 */
export const STAFF_ARCHETYPES = ['manager', 'coursecreator', 'editingteacher', 'teacher'] as const;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu nhắn tin và thông báo: conversation, thành viên, message, block, notification, tuỳ chọn kênh và nhật ký dispatch.
 */
export class MessagingRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn conversation.
   */
  async insertConversation(v: typeof messageConversations.$inferInsert, tx?: DbTx): Promise<ConversationRow> {
    const [row] = await (tx ?? this.db).insert(messageConversations).values(v).returning(); return row!;
  }
  /**
   * Lấy conversation theo id.
   */
  async getConversation(id: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db.select().from(messageConversations).where(eq(messageConversations.id, id)); return row;
  }
  /**
   * Thêm thành viên conversation.
   */
  async addMember(conversationId: string, userId: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(messageConversationMembers).values({ conversationId, userId }).onConflictDoNothing();
  }
  /**
   * Gỡ một thành viên khỏi conversation (dùng cho đồng bộ group conversation:
   * người rời group thì rời conversation, tin nhắn cũ giữ nguyên).
   */
  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.db.delete(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationId, conversationId), eq(messageConversationMembers.userId, userId)));
  }
  /**
   * Thành viên của conversation.
   */
  async listMembers(conversationId: string): Promise<string[]> {
    const rows = await this.db.select().from(messageConversationMembers).where(eq(messageConversationMembers.conversationId, conversationId));
    return rows.map((r) => r.userId);
  }
  /**
   * User có thuộc conversation hay không.
   */
  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const rows = await this.db.select().from(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationId, conversationId), eq(messageConversationMembers.userId, userId)));
    return rows.length > 0;
  }
  /**
   * Conversation của user, mới nhất trước (một truy vấn join).
   */
  async listConversationsForUser(userId: string): Promise<ConversationRow[]> {
    return this.db.select({ conversation: messageConversations })
      .from(messageConversationMembers)
      .innerJoin(messageConversations, eq(messageConversations.id, messageConversationMembers.conversationId))
      .where(eq(messageConversationMembers.userId, userId))
      .orderBy(desc(messageConversations.updatedAt))
      .then((rows) => rows.map((r) => r.conversation));
  }
  /**
   * Danh sách conversation kèm số chưa đọc + tin cuối cho một user —
   * MỘT truy vấn duy nhất: unread đếm bằng count(*) theo mốc last-read
   * của chính user, tin cuối lấy bằng lateral theo seq.
   */
  async listConversationSummaries(userId: string): Promise<ConversationSummaryRow[]> {
    const executed = await this.db.execute(sql`
      SELECT c.id AS conversation_id, c.type AS conversation_type, c.name AS conversation_name,
        c.component AS conversation_component, c.item_type AS conversation_item_type,
        c.item_id AS conversation_item_id, c.context_id AS conversation_context_id,
        c.enabled AS conversation_enabled, c.created_by AS conversation_created_by,
        c.last_message_seq AS conversation_last_seq,
        c.created_at AS conversation_created_at, c.updated_at AS conversation_updated_at,
        mine.last_read_seq AS last_read_seq,
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
        SELECT count(*) AS unread FROM message msg
        WHERE msg.conversation_id = c.id AND msg.seq > mine.last_read_seq AND msg.user_id_from <> mine.user_id
          AND msg.deleted_at IS NULL
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT to_jsonb(msg) AS last_message FROM message msg
        WHERE msg.conversation_id = c.id AND msg.deleted_at IS NULL ORDER BY msg.seq DESC LIMIT 1
      ) lm ON true
      WHERE mine.user_id = ${userId}
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
      ORDER BY c.updated_at DESC
    `);
    // drizzle trả QueryResult (hoặc mảng QueryResult với nhiều câu lệnh).
    const rows = (Array.isArray(executed) ? executed[0] : executed)?.rows ?? [];
    return rows.map((r) => {
      const raw = r as Record<string, unknown>;
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
          lastMessageSeq: raw.conversation_last_seq as number,
          createdAt: new Date(raw.conversation_created_at as string),
          updatedAt: new Date(raw.conversation_updated_at as string),
        },
        members: (raw.members as string[]) ?? [],
        lastReadSeq: raw.last_read_seq as number,
        unreadCount: raw.unread_count as number,
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
              deletedAt: lastMessageRaw.deleted_at ? new Date(lastMessageRaw.deleted_at as string) : null,
              deletedBy: (lastMessageRaw.deleted_by as string | null) ?? null,
              createdAt: new Date(lastMessageRaw.created_at as string),
            }
          : null,
      };
    });
  }
  /** Find the individual conversation whose member set is exactly {a, b}. */
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
  async allocateNextSeq(conversationId: string, tx: DbTx): Promise<number> {
    const [row] = await tx.update(messageConversations)
      .set({ lastMessageSeq: sql`${messageConversations.lastMessageSeq} + 1`, updatedAt: new Date() })
      .where(eq(messageConversations.id, conversationId))
      .returning({ seq: messageConversations.lastMessageSeq });
    return row!.seq;
  }

  /**
   * Chèn tin nhắn.
   */
  async insertMessage(v: typeof message.$inferInsert, tx?: DbTx): Promise<MessageRow> {
    const [row] = await (tx ?? this.db).insert(message).values(v).returning(); return row!;
  }
  /**
   * Lấy tin nhắn theo id.
   */
  async getMessage(id: string): Promise<MessageRow | undefined> {
    const [row] = await this.db.select().from(message).where(eq(message.id, id)); return row;
  }
  /**
   * Tin đã lưu với khoá chống trùng (conversation, người gửi,
   * clientMessageId) — đường tra cứu cho gửi lại idempotent.
   */
  async getMessageByClientId(conversationId: string, userIdFrom: string, clientMessageId: string): Promise<MessageRow | undefined> {
    const [row] = await this.db.select().from(message).where(and(
      eq(message.conversationId, conversationId),
      eq(message.userIdFrom, userIdFrom),
      eq(message.clientMessageId, clientMessageId),
    ));
    return row;
  }
  /**
   * Một cửa sổ tin của conversation theo cursor seq, luôn trả tăng dần
   * theo seq. Không cursor: cửa sổ MỚI NHẤT (limit tin cuối). beforeSeq:
   * cửa sổ ngay trước mốc. afterSeq: các tin sau mốc (đồng bộ thiếu hụt).
   */
  async listMessages(conversationId: string, opts: MessageWindowOptions = {}): Promise<MessageRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const where = [eq(message.conversationId, conversationId)];
    // Mặc định: tin đã xoá mềm bị lọc khỏi MỌI cửa sổ đọc — chỉ cửa sổ
    // truy vết của người có thẩm quyền mới truyền includeDeleted.
    if (!opts.includeDeleted) where.push(isNull(message.deletedAt));
    if (opts.afterSeq !== undefined) {
      where.push(gt(message.seq, opts.afterSeq));
      return this.db.select().from(message).where(and(...where)).orderBy(asc(message.seq)).limit(limit);
    }
    if (opts.beforeSeq !== undefined) where.push(lt(message.seq, opts.beforeSeq));
    const rows = await this.db.select().from(message).where(and(...where)).orderBy(desc(message.seq)).limit(limit);
    return rows.reverse();
  }
  /** Còn tin cũ hơn seq này trong conversation hay không (cho nút tải thêm). */
  async hasMessagesBefore(conversationId: string, seq: number, includeDeleted = false): Promise<boolean> {
    const conditions = [eq(message.conversationId, conversationId), lt(message.seq, seq)];
    if (!includeDeleted) conditions.push(isNull(message.deletedAt));
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(message)
      .where(and(...conditions));
    return (row?.value ?? 0) > 0;
  }
  /**
   * Xoá mềm một tin: chỉ đánh dấu `deleted_at`/`deleted_by`, dòng tin
   * giữ nguyên nội dung phục vụ truy vết của người có thẩm quyền.
   * Tin đã xoá rồi thì giữ nguyên dấu vết lần xoá đầu (idempotent ở
   * tầng service).
   */
  async softDeleteMessage(id: string, deletedBy: string): Promise<MessageRow | undefined> {
    const [row] = await this.db.update(message)
      .set({ deletedAt: new Date(), deletedBy })
      .where(eq(message.id, id))
      .returning();
    return row;
  }
  /** Bật/tắt chat của một conversation (giáo viên phụ trách tắt chat nhóm lớp). */
  async setConversationEnabled(id: string, enabled: boolean): Promise<ConversationRow | undefined> {
    const [row] = await this.db.update(messageConversations)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(messageConversations.id, id))
      .returning();
    return row;
  }
  /**
   * Mốc đã đọc của một thành viên (undefined nếu không phải thành viên).
   */
  async getMemberLastReadSeq(conversationId: string, userId: string): Promise<number | undefined> {
    const [row] = await this.db.select({ lastReadSeq: messageConversationMembers.lastReadSeq })
      .from(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationId, conversationId), eq(messageConversationMembers.userId, userId)));
    return row?.lastReadSeq;
  }
  /**
   * Mốc đã đọc của mọi thành viên — cho client hiển thị biên "đã xem".
   */
  async listMemberReadMarkers(conversationId: string): Promise<{ userId: string; lastReadSeq: number }[]> {
    return this.db.select({ userId: messageConversationMembers.userId, lastReadSeq: messageConversationMembers.lastReadSeq })
      .from(messageConversationMembers)
      .where(eq(messageConversationMembers.conversationId, conversationId));
  }
  /**
   * Đánh dấu một thành viên đã đọc tới tin mới nhất hiện có: nâng mốc
   * last-read của RIÊNG thành viên đó lên last_message_seq của
   * conversation. Trả số tin vừa được đánh dấu (tin của người khác nằm
   * trên mốc cũ) và mốc mới.
   */
  async markConversationRead(conversationId: string, readerId: string): Promise<{ marked: number; lastReadSeq: number }> {
    const [member] = await this.db.select().from(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationId, conversationId), eq(messageConversationMembers.userId, readerId)));
    if (!member) return { marked: 0, lastReadSeq: 0 };
    const [conversation] = await this.db.select({ lastMessageSeq: messageConversations.lastMessageSeq })
      .from(messageConversations).where(eq(messageConversations.id, conversationId));
    const target = conversation?.lastMessageSeq ?? member.lastReadSeq;
    const [unread] = await this.db.select({ value: sql<number>`count(*)::int` }).from(message)
      .where(and(
        eq(message.conversationId, conversationId),
        gt(message.seq, member.lastReadSeq),
        lte(message.seq, target),
        ne(message.userIdFrom, readerId),
        isNull(message.deletedAt),
      ));
    if (target > member.lastReadSeq) {
      await this.db.update(messageConversationMembers)
        .set({ lastReadSeq: target })
        .where(and(eq(messageConversationMembers.conversationId, conversationId), eq(messageConversationMembers.userId, readerId)));
    }
    return { marked: unread?.value ?? 0, lastReadSeq: target };
  }
  /**
   * Số tin chưa đọc của MỘT user trong MỘT conversation (đếm bằng
   * count(*) theo mốc đã đọc của chính user — consumer realtime dùng
   * để gửi kèm sự kiện cập nhật cho từng người nhận).
   */
  async countUnreadForConversation(conversationId: string, userId: string): Promise<number> {
    const lastReadSeq = await this.getMemberLastReadSeq(conversationId, userId);
    if (lastReadSeq === undefined) return 0;
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(message)
      .where(and(eq(message.conversationId, conversationId), gt(message.seq, lastReadSeq), ne(message.userIdFrom, userId), isNull(message.deletedAt)));
    return row?.value ?? 0;
  }
  /** Unread conversations for a user (Moodle count_unread_conversations): conversations with ≥1 unread message from others. */
  /**
   * Số conversation có tin chưa đọc của user — một truy vấn EXISTS theo
   * mốc đã đọc của từng thành viên, không tải lịch sử về đếm.
   */
  async countUnreadConversations(userId: string): Promise<number> {
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` })
      .from(messageConversationMembers)
      .where(and(
        eq(messageConversationMembers.userId, userId),
        sql`exists (
          select 1 from ${message} msg
          where msg.conversation_id = ${messageConversationMembers.conversationId}
            and msg.seq > ${messageConversationMembers.lastReadSeq}
            and msg.user_id_from <> ${userId}
            and msg.deleted_at is null
        )`,
        // Conversation 1–1 đang bị ẩn vì quan hệ chặn (xem
        // listConversationSummaries) cũng không đếm vào huy hiệu chưa
        // đọc — danh sách không thấy thì huy hiệu không được lộ.
        sql`not exists (
          select 1 from ${messageConversations} c
          join ${messageConversationMembers} other_m
            on other_m.conversation_id = c.id and other_m.user_id <> ${userId}
          join ${messageUsersBlocked} b
            on (b.user_id = ${userId} and b.blocked_user_id = other_m.user_id)
            or (b.user_id = other_m.user_id and b.blocked_user_id = ${userId})
          where c.id = ${messageConversationMembers.conversationId} and c.type = 1
        )`,
      ));
    return row?.value ?? 0;
  }

  /**
   * Chặn liên lạc từ một user.
   */
  async block(userId: string, blockedUserId: string): Promise<void> {
    await this.db.insert(messageUsersBlocked).values({ userId, blockedUserId }).onConflictDoNothing();
  }
  /**
   * Bỏ chặn.
   */
  async unblock(userId: string, blockedUserId: string): Promise<void> {
    await this.db.delete(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userId, userId), eq(messageUsersBlocked.blockedUserId, blockedUserId)));
  }
  /**
   * A có chặn B hay không.
   */
  async isBlocked(userId: string, blockedUserId: string): Promise<boolean> {
    const rows = await this.db.select().from(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userId, userId), eq(messageUsersBlocked.blockedUserId, blockedUserId)));
    return rows.length > 0;
  }
  /**
   * Danh sách user bị chặn.
   */
  async listBlocked(userId: string): Promise<string[]> {
    const rows = await this.db.select().from(messageUsersBlocked).where(eq(messageUsersBlocked.userId, userId));
    return rows.map((r) => r.blockedUserId);
  }
  /**
   * Danh sách user ĐÃ CHẶN user này (chiều ngược của listBlocked) —
   * danh sách thành viên khoá dùng để giấu phía chặn khỏi roster của
   * phía bị chặn, khớp ngữ nghĩa chặn hiện có.
   */
  async listBlockerIds(userId: string): Promise<string[]> {
    const rows = await this.db.select().from(messageUsersBlocked).where(eq(messageUsersBlocked.blockedUserId, userId));
    return rows.map((r) => r.userId);
  }
  /**
   * Mọi user đang có quan hệ chặn với user này ở BẤT KỲ chiều nào
   * (người mình chặn ∪ người chặn mình) — tập "đối tác bị chặn" dùng
   * cho các luật ẩn bề mặt 1–1 (presence, mốc đã đọc).
   */
  async listBlockedCounterpartIds(userId: string): Promise<string[]> {
    const [blocked, blockers] = await Promise.all([this.listBlocked(userId), this.listBlockerIds(userId)]);
    return [...new Set([...blocked, ...blockers])];
  }

  // --- contacts (quan hệ đã duyệt) + yêu cầu kết bạn -------------------------

  /**
   * Ghi quan hệ liên hệ ĐÃ DUYỆT ở cả hai chiều (a→b và b→a) — một
   * quan hệ được chấp nhận là hai phía theo đúng mô hình Moodle.
   */
  async addContactPair(a: string, b: string): Promise<void> {
    await this.db.insert(messageContacts).values([
      { userId: a, contactId: b },
      { userId: b, contactId: a },
    ]).onConflictDoNothing();
  }
  /**
   * Gỡ quan hệ liên hệ ở cả hai chiều, đồng thời dọn mọi yêu cầu đang
   * chờ giữa hai người (quan hệ đã chấm dứt thì hàng chờ cũng hết nghĩa).
   */
  async removeContactPair(a: string, b: string): Promise<void> {
    await this.db.delete(messageContacts).where(or(
      and(eq(messageContacts.userId, a), eq(messageContacts.contactId, b)),
      and(eq(messageContacts.userId, b), eq(messageContacts.contactId, a)),
    ));
    await this.deleteContactRequestsBetween(a, b);
  }
  /**
   * Danh bạ của user (các liên hệ đã được duyệt — quan hệ hai chiều nên
   * một hướng truy vấn là đủ). Quan hệ chặn đang hiệu lực (bất kỳ
   * chiều nào) thì hai người ẨN khỏi danh bạ của nhau theo chuẩn app
   * nhắn tin; hàng quan hệ trong DB giữ nguyên — bỏ chặn là hiện lại.
   */
  async listContacts(userId: string): Promise<string[]> {
    const rows = await this.db.select().from(messageContacts).where(and(
      eq(messageContacts.userId, userId),
      sql`not exists (
        select 1 from ${messageUsersBlocked} b
        where (b.user_id = ${userId} and b.blocked_user_id = ${messageContacts.contactId})
           or (b.user_id = ${messageContacts.contactId} and b.blocked_user_id = ${userId})
      )`,
    ));
    return rows.map((r) => r.contactId);
  }
  /**
   * Owner có contactId trong danh bạ đã duyệt hay không. Cổng liên lạc
   * dùng hướng (người nhận, người gửi) — vì quan hệ được duyệt tồn tại
   * ở cả hai chiều nên hướng này đúng khi và chỉ khi hai người là liên
   * hệ đã chấp nhận của nhau. Yêu cầu đang chờ KHÔNG nằm ở bảng này.
   */
  async isContact(ownerId: string, contactId: string): Promise<boolean> {
    const rows = await this.db.select().from(messageContacts)
      .where(and(eq(messageContacts.userId, ownerId), eq(messageContacts.contactId, contactId)));
    return rows.length > 0;
  }
  /** Tạo một yêu cầu kết bạn (trùng cặp thì bỏ qua). */
  async createContactRequest(fromId: string, toId: string): Promise<void> {
    await this.db.insert(messageContactRequests).values({ userIdFrom: fromId, userIdTo: toId }).onConflictDoNothing();
  }
  /** Một yêu cầu kết bạn theo đúng hướng (from → to), nếu đang chờ. */
  async getContactRequest(fromId: string, toId: string): Promise<ContactRequestRow | undefined> {
    const [row] = await this.db.select().from(messageContactRequests)
      .where(and(eq(messageContactRequests.userIdFrom, fromId), eq(messageContactRequests.userIdTo, toId)));
    return row;
  }
  /** Xoá một yêu cầu theo hướng (from → to): chấp nhận/từ chối đều qua đây. */
  async deleteContactRequest(fromId: string, toId: string): Promise<void> {
    await this.db.delete(messageContactRequests)
      .where(and(eq(messageContactRequests.userIdFrom, fromId), eq(messageContactRequests.userIdTo, toId)));
  }
  /** Xoá mọi yêu cầu đang chờ giữa hai người (cả hai hướng). */
  async deleteContactRequestsBetween(a: string, b: string): Promise<void> {
    await this.db.delete(messageContactRequests).where(or(
      and(eq(messageContactRequests.userIdFrom, a), eq(messageContactRequests.userIdTo, b)),
      and(eq(messageContactRequests.userIdFrom, b), eq(messageContactRequests.userIdTo, a)),
    ));
  }
  /** Các yêu cầu ĐẾN user này đang chờ (người gửi → chờ user duyệt). */
  async listIncomingContactRequests(userId: string): Promise<ContactRequestRow[]> {
    return this.db.select().from(messageContactRequests)
      .where(eq(messageContactRequests.userIdTo, userId))
      .orderBy(asc(messageContactRequests.createdAt));
  }
  /** Các yêu cầu user này ĐÃ GỬI đang chờ phía kia duyệt. */
  async listOutgoingContactRequests(userId: string): Promise<ContactRequestRow[]> {
    return this.db.select().from(messageContactRequests)
      .where(eq(messageContactRequests.userIdFrom, userId))
      .orderBy(asc(messageContactRequests.createdAt));
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
    const rows = await this.db.select({ id: roleAssignments.id })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .where(and(eq(roleAssignments.userId, userId), inArray(role.archetype, [...STAFF_ARCHETYPES])))
      .limit(1);
    return rows.length > 0;
  }
  /**
   * Mọi user mang vai trò staff tại context của khoá hoặc một context
   * tổ tiên của nó (kế thừa theo đường path của context, khớp ngữ
   * nghĩa evaluator) — tập "giáo viên phụ trách" nhận báo cáo và thông
   * báo về conversation của khoá.
   */
  async listCourseStaffUserIds(courseId: string): Promise<string[]> {
    const [courseCtx] = await this.db.select().from(context)
      .where(and(eq(context.contextLevel, 50), eq(context.instanceId, courseId)));
    if (!courseCtx) return [];
    // path của context là chuỗi id các context từ gốc tới chính nó
    // (định dạng '/<id>/.../<id>'): các id trong path là đúng tập
    // context mà gán vai trò tại đó kế thừa xuống khoá này.
    const pathIds = courseCtx.path.split('/').filter((part) => part.length > 0);
    if (!pathIds.length) return [];
    const rows = await this.db.selectDistinct({ userId: roleAssignments.userId })
      .from(roleAssignments)
      .innerJoin(role, eq(role.id, roleAssignments.roleId))
      .where(and(
        inArray(role.archetype, [...STAFF_ARCHETYPES]),
        inArray(roleAssignments.contextId, pathIds),
      ));
    return rows.map((r) => r.userId);
  }

  // --- báo cáo conversation ---------------------------------------------------

  /** Ghi một báo cáo conversation mới (trạng thái open). */
  async insertReport(v: typeof messageConversationReports.$inferInsert): Promise<ReportRow> {
    const [row] = await this.db.insert(messageConversationReports).values(v).returning();
    return row!;
  }
  /** Một báo cáo theo id. */
  async getReport(id: string): Promise<ReportRow | undefined> {
    const [row] = await this.db.select().from(messageConversationReports).where(eq(messageConversationReports.id, id));
    return row;
  }
  /** Các báo cáo mới nhất trước (hàng đợi xử lý lọc theo thẩm quyền ở tầng service). */
  async listReports(limit = 200): Promise<ReportRow[]> {
    return this.db.select().from(messageConversationReports)
      .orderBy(desc(messageConversationReports.createdAt))
      .limit(limit);
  }
  /** Đổi trạng thái xử lý của báo cáo; resolved/dismissed ghi người xử lý + mốc, mở lại thì xoá hai dấu đó. */
  async updateReportStatus(id: string, status: string, resolvedBy: string | null): Promise<ReportRow | undefined> {
    const closing = status !== 'open';
    const [row] = await this.db.update(messageConversationReports)
      .set({
        status,
        resolvedBy: closing ? resolvedBy : null,
        resolvedAt: closing ? new Date() : null,
      })
      .where(eq(messageConversationReports.id, id))
      .returning();
    return row;
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
    const rows = await this.db.select({ courseId: enrol.courseId }).from(userEnrolments)
      .innerJoin(enrol, eq(userEnrolments.enrolId, enrol.id))
      .where(and(
        eq(userEnrolments.userId, userId),
        eq(userEnrolments.status, 0),
        eq(enrol.status, 0),
        lte(userEnrolments.timeStart, now),
        or(isNull(userEnrolments.timeEnd), gte(userEnrolments.timeEnd, now)),
      ));
    return rows.map((r) => r.courseId);
  }
  /** Tóm tắt một khoá (cho danh sách "khoá của tôi" của luồng tìm bạn theo khoá). */
  async getCourseSummary(courseId: string): Promise<{ courseId: string; fullName: string; shortName: string } | undefined> {
    const [row] = await this.db.select({ courseId: course.id, fullName: course.fullName, shortName: course.shortName })
      .from(course).where(eq(course.id, courseId));
    return row;
  }
  /**
   * Các khoá mà user là THÀNH VIÊN theo định nghĩa roster đã chốt:
   * ghi danh đang hiệu lực ∪ có gán vai tại context của khoá (mọi
   * archetype — gán vai học viên tại context khoá cũng là thành viên).
   */
  async listMembershipCourseIds(userId: string): Promise<string[]> {
    const enrolled = await this.activeCourseIds(userId);
    const assigned = await this.db.selectDistinct({ courseId: context.instanceId })
      .from(roleAssignments)
      .innerJoin(context, eq(context.id, roleAssignments.contextId))
      .where(and(eq(roleAssignments.userId, userId), eq(context.contextLevel, 50)));
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
    const [enrolled] = await this.db.select({ userId: userEnrolments.userId }).from(userEnrolments)
      .innerJoin(enrol, eq(userEnrolments.enrolId, enrol.id))
      .where(and(
        eq(enrol.courseId, courseId),
        eq(userEnrolments.userId, userId),
        eq(userEnrolments.status, 0),
        eq(enrol.status, 0),
        lte(userEnrolments.timeStart, now),
        or(isNull(userEnrolments.timeEnd), gte(userEnrolments.timeEnd, now)),
      )).limit(1);
    if (enrolled) return true;
    const [courseCtx] = await this.db.select({ id: context.id }).from(context)
      .where(and(eq(context.contextLevel, 50), eq(context.instanceId, courseId)));
    if (!courseCtx) return false;
    const [assigned] = await this.db.select({ id: roleAssignments.id }).from(roleAssignments)
      .where(and(eq(roleAssignments.contextId, courseCtx.id), eq(roleAssignments.userId, userId)))
      .limit(1);
    return Boolean(assigned);
  }
  /**
   * Một trang roster của khoá, sắp tăng dần theo (displayName,
   * username, id); `cursor` là mốc của dòng cuối trang trước (null =
   * trang đầu) — phân trang con trỏ ngay tại SQL, không nạp tập thành
   * viên về app (số đo của đội kiểm tra trên issue #33: roster 50.000
   * thành viên trả hết là ~6,3 MB JSON; OFFSET sâu chậm hơn hẳn).
   * Tập thành viên = ghi danh hiệu lực ∪ gán vai tại context khoá;
   * cờ `staff` = có gán vai archetype staff tại context khoá. Tài
   * khoản đã xoá/tạm ngưng/khách, chính người xem, và người có quan
   * hệ chặn với người xem (CẢ hai chiều) bị loại ngay tại SQL. Chỉ
   * các trường trong whitelist của hợp đồng roster được chọn ra.
   */
  async listCourseRosterPage(courseId: string, actorId: string, cursor: { displayName: string; username: string; userId: string } | null, limit: number): Promise<{
    userId: string; username: string; firstName: string; lastName: string; displayName: string; staff: boolean;
  }[]> {
    const cursorCond = cursor
      ? sql`and ((case when btrim(u.first_name || ' ' || u.last_name) = '' then u.username else btrim(u.first_name || ' ' || u.last_name) end), u.username, u.id) > (${cursor.displayName}, ${cursor.username}, ${cursor.userId}::uuid)`
      : sql``;
    const executed = await this.db.execute(sql`
      with course_ctx as (
        select id from ${context} where context_level = 50 and instance_id = ${courseId}
      ),
      member_flags as (
        select ue.user_id as user_id, false as staff
        from ${userEnrolments} ue
        join ${enrol} e on e.id = ue.enrol_id
        where e.course_id = ${courseId}
          and ue.status = 0 and e.status = 0
          and ue.time_start <= now() and (ue.time_end is null or ue.time_end >= now())
        union all
        select ra.user_id as user_id, (r.archetype in ('manager', 'coursecreator', 'editingteacher', 'teacher')) as staff
        from ${roleAssignments} ra
        join ${role} r on r.id = ra.role_id
        where ra.context_id = (select id from course_ctx)
      ),
      members as (
        select user_id, bool_or(staff) as staff from member_flags group by user_id
      )
      select u.id as user_id, u.username as username, u.first_name as first_name, u.last_name as last_name,
        (case when btrim(u.first_name || ' ' || u.last_name) = '' then u.username else btrim(u.first_name || ' ' || u.last_name) end) as display_name,
        m.staff as staff
      from members m
      join ${users} u on u.id = m.user_id
      where u.deleted = false and u.suspended = false and u.is_guest = false
        and u.id <> ${actorId}
        and not exists (
          select 1 from ${messageUsersBlocked} b
          where (b.user_id = ${actorId} and b.blocked_user_id = u.id)
             or (b.user_id = u.id and b.blocked_user_id = ${actorId})
        )
        ${cursorCond}
      order by display_name asc, u.username asc, u.id asc
      limit ${limit}
    `);
    const rows = (Array.isArray(executed) ? executed[0] : executed)?.rows ?? [];
    return rows.map((r) => {
      const raw = r as Record<string, unknown>;
      return {
        userId: raw.user_id as string,
        username: raw.username as string,
        firstName: raw.first_name as string,
        lastName: raw.last_name as string,
        displayName: raw.display_name as string,
        staff: Boolean(raw.staff),
      };
    });
  }

  // --- group conversation sync ------------------------------------------------
  // Đọc trực tiếp bảng groups/groups_members qua barrel schema (không import
  // GroupsModule): đồng bộ lười phía messaging, không cần hook bên groups.

  /**
   * Lấy một course group theo id (kèm courseId để resolve context/staff).
   */
  async getCourseGroup(groupId: string): Promise<CourseGroupRow | undefined> {
    const [row] = await this.db.select().from(courseGroups).where(eq(courseGroups.id, groupId));
    return row;
  }
  /**
   * Thành viên hiện tại của một course group.
   */
  async listGroupMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.db.select().from(groupsMembers).where(eq(groupsMembers.groupId, groupId));
    return rows.map((r) => r.userId);
  }
  /**
   * Mọi group mà user hiện là thành viên (để tầng service phát hiện
   * membership conversation đã cũ so với group).
   */
  async listGroupIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.db.select({ groupId: groupsMembers.groupId }).from(groupsMembers)
      .where(eq(groupsMembers.userId, userId));
    return rows.map((r) => r.groupId);
  }
  /**
   * Conversation gắn với một course group qua (component, itemType, itemId).
   */
  async findGroupConversation(groupId: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db.select().from(messageConversations).where(and(
      eq(messageConversations.component, 'core_group'),
      eq(messageConversations.itemType, 'groups'),
      eq(messageConversations.itemId, groupId),
    ));
    return row;
  }
  /**
   * Mọi conversation gắn group mà user là thành viên của group tương ứng —
   * để thao tác liệt kê cũng kích hoạt đồng bộ (người mới vào group thấy
   * conversation ngay cả khi chưa từng là thành viên conversation).
   */
  async listGroupConversationsForGroupMember(userId: string): Promise<ConversationRow[]> {
    const memberships = await this.db.select().from(groupsMembers).where(eq(groupsMembers.userId, userId));
    if (!memberships.length) return [];
    return this.db.select().from(messageConversations).where(and(
      eq(messageConversations.component, 'core_group'),
      eq(messageConversations.itemType, 'groups'),
      inArray(messageConversations.itemId, memberships.map((m) => m.groupId)),
    ));
  }

  /**
   * Chèn notification trong ứng dụng.
   */
  async insertNotification(v: typeof notifications.$inferInsert, tx?: DbTx): Promise<NotificationRow> {
    const [row] = await (tx ?? this.db).insert(notifications).values(v).returning(); return row!;
  }
  /**
   * Số notification chưa đọc (đếm bằng count(*) ở DB).
   */
  async countUnreadNotifications(userIdTo: string): Promise<number> {
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.userIdTo, userIdTo), isNull(notifications.timeRead)));
    return row?.value ?? 0;
  }
  /**
   * Đánh dấu một notification đã đọc.
   */
  async markNotificationRead(id: string, userIdTo: string): Promise<boolean> {
    const rows = await this.db.update(notifications).set({ timeRead: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.userIdTo, userIdTo))).returning();
    return rows.length > 0;
  }
  /**
   * Đánh dấu mọi notification đã đọc.
   */
  async markAllNotificationsRead(userIdTo: string): Promise<number> {
    const rows = await this.db.update(notifications).set({ timeRead: new Date() })
      .where(and(eq(notifications.userIdTo, userIdTo), isNull(notifications.timeRead))).returning();
    return rows.length;
  }

  /**
   * Danh sách GỘP của trung tâm thông báo v2 (issue #51): tổng hợp
   * theo (loại × nguồn × ngày) ngay trong SQL — nguồn là `contextUrl`
   * chuẩn hoá ('' khi không có), ngày là ngày lịch Asia/Saigon. Sắp
   * xếp theo hoạt động mới nhất; phân trang keyset trên cặp
   * (max(created_at), max(id)) của dòng gộp qua mệnh đề HAVING, nên
   * không trang nào phải tải toàn bộ lịch sử về mới gộp được.
   */
  async listNotificationGroups(userIdTo: string, opts: {
    eventTypes?: string[];
    unreadOnly?: boolean;
    cursor?: { latestAt: Date; latestId: string };
    limit: number;
  }): Promise<NotificationGroupAggregateRow[]> {
    const where = [sql`user_id_to = ${userIdTo}`];
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      where.push(sql`event_type in (${sql.join(opts.eventTypes.map((t) => sql`${t}`), sql`, `)})`);
    }
    // Postgres không có max(uuid): id của mục mới nhất lấy bằng
    // array_agg sắp xếp theo (created_at, id) giảm dần — cùng thứ tự
    // với neo keyset (max(created_at), id mới nhất).
    const latestIdExpr = sql`(array_agg(id order by created_at desc, id desc))[1]`;
    const having: ReturnType<typeof sql>[] = [];
    if (opts.unreadOnly) having.push(sql`count(*) filter (where time_read is null) > 0`);
    if (opts.cursor) {
      having.push(sql`(max(created_at), ${latestIdExpr}) < (${opts.cursor.latestAt}::timestamptz, ${opts.cursor.latestId}::uuid)`);
    }
    const query = sql`
      select
        event_type as "eventType",
        component as "component",
        coalesce(nullif(context_url, ''), '') as "sourceKey",
        to_char((created_at at time zone 'Asia/Saigon')::date, 'YYYY-MM-DD') as "day",
        count(*)::int as "count",
        (count(*) filter (where time_read is null))::int as "unreadCount",
        max(created_at) as "latestAt",
        ${latestIdExpr}::text as "latestId"
      from notifications
      where ${sql.join(where, sql` and `)}
      group by event_type, component, coalesce(nullif(context_url, ''), ''), (created_at at time zone 'Asia/Saigon')::date
      ${having.length > 0 ? sql`having ${sql.join(having, sql` and `)}` : sql``}
      order by max(created_at) desc, ${latestIdExpr} desc
      limit ${opts.limit}
    `;
    const res = (await this.db.execute(query)) as unknown as { rows: NotificationGroupAggregateRow[] };
    return res.rows;
  }

  /** Lấy các notification theo đúng tập id (điểm neo `latest` của các dòng gộp). */
  async listNotificationsByIds(ids: string[]): Promise<NotificationRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(notifications).where(inArray(notifications.id, ids));
  }

  /**
   * Danh sách PHẲNG của trung tâm v2: phân trang keyset theo
   * (createdAt, id) giảm dần; bộ lọc (loại × nguồn × ngày) mở chi
   * tiết đúng một dòng gộp, `day` so theo ngày lịch Asia/Saigon như
   * khoá gộp để hai đường không bao giờ lệch nhau.
   */
  async listNotificationItems(userIdTo: string, opts: NotificationItemsOptions): Promise<NotificationRow[]> {
    const conditions = [eq(notifications.userIdTo, userIdTo)];
    if (opts.eventType) conditions.push(eq(notifications.eventType, opts.eventType));
    if (opts.eventTypes && opts.eventTypes.length > 0) conditions.push(inArray(notifications.eventType, opts.eventTypes));
    if (opts.source === null) {
      conditions.push(sql`coalesce(nullif(${notifications.contextUrl}, ''), '') = ''`);
    } else if (typeof opts.source === 'string') {
      conditions.push(eq(notifications.contextUrl, opts.source));
    }
    if (opts.day) {
      conditions.push(sql`to_char(((${notifications.createdAt}) at time zone 'Asia/Saigon')::date, 'YYYY-MM-DD') = ${opts.day}`);
    }
    if (opts.unreadOnly) conditions.push(isNull(notifications.timeRead));
    if (opts.cursor) {
      conditions.push(sql`(${notifications.createdAt}, ${notifications.id}) < (${opts.cursor.createdAt}::timestamptz, ${opts.cursor.id}::uuid)`);
    }
    return this.db.select().from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(opts.limit);
  }

  /**
   * Đánh dấu đã đọc HÀNG LOẠT theo khoá gộp (loại × nguồn × ngày)
   * của trung tâm v2: chỉ các mục chưa đọc thuộc đúng khoá mới đổi.
   */
  async markNotificationGroupRead(userIdTo: string, key: { eventType: string; sourceKey: string; day: string }): Promise<number> {
    const rows = await this.db.update(notifications).set({ timeRead: new Date() })
      .where(and(
        eq(notifications.userIdTo, userIdTo),
        eq(notifications.eventType, key.eventType),
        isNull(notifications.timeRead),
        sql`coalesce(nullif(${notifications.contextUrl}, ''), '') = ${key.sourceKey}`,
        sql`to_char(((${notifications.createdAt}) at time zone 'Asia/Saigon')::date, 'YYYY-MM-DD') = ${key.day}`,
      )).returning();
    return rows.length;
  }

  /** Xoá MỘT notification của đúng chủ sở hữu; false khi không tồn tại hoặc không phải của họ. */
  async deleteNotification(id: string, userIdTo: string): Promise<boolean> {
    const rows = await this.db.delete(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userIdTo, userIdTo))).returning();
    return rows.length > 0;
  }

  /** Dọn mọi notification ĐÃ ĐỌC của user (trung tâm v2); trả số mục đã xoá. */
  async deleteReadNotifications(userIdTo: string): Promise<number> {
    const rows = await this.db.delete(notifications)
      .where(and(eq(notifications.userIdTo, userIdTo), isNotNull(notifications.timeRead))).returning();
    return rows.length;
  }

  /**
   * Còn notification CHƯA ĐỌC của (user, loại sự kiện, ngữ cảnh) hay
   * không — căn cứ gộp thông báo tin nhắn mới theo conversation của
   * NotificationEventsConsumer: còn một bản chưa đọc thì các tin tiếp
   * theo trong cùng conversation không sinh thêm bản nữa.
   */
  async hasUnreadNotification(userIdTo: string, eventType: string, contextUrl: string): Promise<boolean> {
    const [row] = await this.db.select({ id: notifications.id }).from(notifications)
      .where(and(
        eq(notifications.userIdTo, userIdTo), eq(notifications.eventType, eventType),
        eq(notifications.contextUrl, contextUrl), isNull(notifications.timeRead),
      ))
      .limit(1);
    return row !== undefined;
  }

  /**
   * Thông tin tối thiểu của một grade item để consumer thông báo điểm
   * mới quyết định có phát hay không (bỏ qua tổng khoá/tổng hạng mục/
   * item công thức và item bị ẩn) và dựng nội dung không chứa điểm số.
   */
  async getGradeItemNotifyInfo(itemId: string): Promise<{ itemType: string; itemName: string; hidden: boolean; courseId: string } | undefined> {
    const [row] = await this.db.select({
      itemType: gradeItems.itemType, itemName: gradeItems.itemName,
      hidden: gradeItems.hidden, courseId: gradeItems.courseId,
    }).from(gradeItems).where(eq(gradeItems.id, itemId));
    return row;
  }

  /**
   * Điểm của user trên item có đang bị ẩn với chính user đó không
   * (grade_grades.hidden — điểm bị giáo viên ẩn thì học sinh không
   * nhận thông báo điểm mới).
   */
  async isGradeHiddenForUser(itemId: string, userId: string): Promise<boolean> {
    const [row] = await this.db.select({ hidden: gradeGrades.hidden }).from(gradeGrades)
      .where(and(eq(gradeGrades.itemId, itemId), eq(gradeGrades.userId, userId)));
    return row?.hidden ?? false;
  }

  /** Tên đầy đủ của khoá học để dựng nội dung thông báo. */
  async getCourseFullName(courseId: string): Promise<string | undefined> {
    const [row] = await this.db.select({ fullName: course.fullName }).from(course).where(eq(course.id, courseId));
    return row?.fullName;
  }

  /**
   * Ghi nhật ký một lần dispatch notification qua kênh.
   */
  async insertDispatchLog(v: typeof notificationDispatchLog.$inferInsert, tx?: DbTx): Promise<DispatchLogRow> {
    const [row] = await (tx ?? this.db).insert(notificationDispatchLog).values(v)
      .onConflictDoNothing({ target: notificationDispatchLog.dedupeKey }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupeKey, v.dedupeKey!));
    return existing!;
  }
  /**
   * Nhật ký dispatch (kiểm chứng gửi).
   */
  async listDispatchLog(userId: string): Promise<DispatchLogRow[]> {
    return this.db.select().from(notificationDispatchLog).where(eq(notificationDispatchLog.userId, userId)).orderBy(asc(notificationDispatchLog.id));
  }
}
