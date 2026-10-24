import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  courseGroups, enrol, groupsMembers,
  message, messageContacts, messageConversationMembers, messageConversations, messageUsersBlocked,
  notificationDispatchLog, notifications, userEnrolments,
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
}
export type NotificationRow = typeof notifications.$inferSelect;
export type DispatchLogRow = typeof notificationDispatchLog.$inferSelect;
export type ContactRow = typeof messageContacts.$inferSelect;
export type CourseGroupRow = typeof courseGroups.$inferSelect;
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
        c.enabled AS conversation_enabled, c.last_message_seq AS conversation_last_seq,
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
      ) u ON true
      LEFT JOIN LATERAL (
        SELECT to_jsonb(msg) AS last_message FROM message msg
        WHERE msg.conversation_id = c.id ORDER BY msg.seq DESC LIMIT 1
      ) lm ON true
      WHERE mine.user_id = ${userId}
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
    if (opts.afterSeq !== undefined) {
      where.push(gt(message.seq, opts.afterSeq));
      return this.db.select().from(message).where(and(...where)).orderBy(asc(message.seq)).limit(limit);
    }
    if (opts.beforeSeq !== undefined) where.push(lt(message.seq, opts.beforeSeq));
    const rows = await this.db.select().from(message).where(and(...where)).orderBy(desc(message.seq)).limit(limit);
    return rows.reverse();
  }
  /** Còn tin cũ hơn seq này trong conversation hay không (cho nút tải thêm). */
  async hasMessagesBefore(conversationId: string, seq: number): Promise<boolean> {
    const [row] = await this.db.select({ value: sql<number>`count(*)::int` }).from(message)
      .where(and(eq(message.conversationId, conversationId), lt(message.seq, seq)));
    return (row?.value ?? 0) > 0;
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
      .where(and(eq(message.conversationId, conversationId), gt(message.seq, lastReadSeq), ne(message.userIdFrom, userId)));
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

  // --- contacts -------------------------------------------------------------

  /**
   * Thêm một liên hệ vào danh bạ của user (trùng cặp thì bỏ qua).
   */
  async addContact(userId: string, contactId: string): Promise<void> {
    await this.db.insert(messageContacts).values({ userId, contactId }).onConflictDoNothing();
  }
  /**
   * Gỡ một liên hệ khỏi danh bạ của user.
   */
  async removeContact(userId: string, contactId: string): Promise<void> {
    await this.db.delete(messageContacts)
      .where(and(eq(messageContacts.userId, userId), eq(messageContacts.contactId, contactId)));
  }
  /**
   * Danh bạ của user (các contactId user đã thêm).
   */
  async listContacts(userId: string): Promise<string[]> {
    const rows = await this.db.select().from(messageContacts).where(eq(messageContacts.userId, userId));
    return rows.map((r) => r.contactId);
  }
  /**
   * Owner có contactId trong danh bạ hay không. Cổng liên lạc dùng hướng
   * (người nhận, người gửi): người nhận đã thêm người gửi làm liên hệ.
   */
  async isContact(ownerId: string, contactId: string): Promise<boolean> {
    const rows = await this.db.select().from(messageContacts)
      .where(and(eq(messageContacts.userId, ownerId), eq(messageContacts.contactId, contactId)));
    return rows.length > 0;
  }

  // --- cổng liên lạc: khoá học chung -----------------------------------------
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
  /**
   * Hai user có ít nhất một khoá học cùng ghi danh đang hiệu lực hay không.
   */
  async sharesActiveCourse(a: string, b: string): Promise<boolean> {
    const coursesA = await this.activeCourseIds(a);
    if (!coursesA.length) return false;
    const coursesB = new Set(await this.activeCourseIds(b));
    return coursesA.some((id) => coursesB.has(id));
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
   * Notification của user.
   */
  async listNotifications(userIdTo: string): Promise<NotificationRow[]> {
    return this.db.select().from(notifications).where(eq(notifications.userIdTo, userIdTo)).orderBy(desc(notifications.id));
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
