import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  courseGroups, enrol, groupsMembers,
  message, messageContacts, messageConversationMembers, messageConversations, messageUsersBlocked,
  notificationDispatchLog, notifications, userEnrolments,
} from '../../db/schema';

export type ConversationRow = typeof messageConversations.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
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
   * Conversation của user, mới nhất trước.
   */
  async listConversationsForUser(userId: string): Promise<ConversationRow[]> {
    const memberships = await this.db.select().from(messageConversationMembers).where(eq(messageConversationMembers.userId, userId));
    if (!memberships.length) return [];
    const rows: ConversationRow[] = [];
    for (const m of memberships) {
      const c = await this.getConversation(m.conversationId);
      if (c) rows.push(c);
    }
    return rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
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
   * Cập nhật mốc hoạt động của conversation khi có tin mới.
   */
  async touchConversation(id: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(messageConversations).set({ updatedAt: new Date() }).where(eq(messageConversations.id, id));
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
   * Tin nhắn của conversation.
   */
  async listMessages(conversationId: string): Promise<MessageRow[]> {
    return this.db.select().from(message).where(eq(message.conversationId, conversationId)).orderBy(asc(message.id));
  }
  /**
   * Đánh dấu user đã đọc conversation tới thời điểm hiện tại.
   */
  async markConversationRead(conversationId: string, readerId: string): Promise<number> {
    const rows = await this.db.update(message).set({ timeRead: new Date() })
      .where(and(eq(message.conversationId, conversationId), ne(message.userIdFrom, readerId), isNull(message.timeRead)))
      .returning();
    return rows.length;
  }
  /** Unread conversations for a user (Moodle count_unread_conversations): conversations with ≥1 unread message from others. */
  /**
   * Số conversation có tin chưa đọc của user.
   */
  async countUnreadConversations(userId: string): Promise<number> {
    const convs = await this.listConversationsForUser(userId);
    let count = 0;
    for (const c of convs) {
      const unread = await this.db.select().from(message)
        .where(and(eq(message.conversationId, c.id), ne(message.userIdFrom, userId), isNull(message.timeRead)));
      if (unread.length) count += 1;
    }
    return count;
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
   * Số notification chưa đọc.
   */
  async countUnreadNotifications(userIdTo: string): Promise<number> {
    const rows = await this.db.select().from(notifications)
      .where(and(eq(notifications.userIdTo, userIdTo), isNull(notifications.timeRead)));
    return rows.length;
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
