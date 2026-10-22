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
  async addMember(conversationid: string, userid: string, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(messageConversationMembers).values({ conversationid, userid }).onConflictDoNothing();
  }
  /**
   * Gỡ một thành viên khỏi conversation (dùng cho đồng bộ group conversation:
   * người rời group thì rời conversation, tin nhắn cũ giữ nguyên).
   */
  async removeMember(conversationid: string, userid: string): Promise<void> {
    await this.db.delete(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationid, conversationid), eq(messageConversationMembers.userid, userid)));
  }
  /**
   * Thành viên của conversation.
   */
  async listMembers(conversationid: string): Promise<string[]> {
    const rows = await this.db.select().from(messageConversationMembers).where(eq(messageConversationMembers.conversationid, conversationid));
    return rows.map((r) => r.userid);
  }
  /**
   * User có thuộc conversation hay không.
   */
  async isMember(conversationid: string, userid: string): Promise<boolean> {
    const rows = await this.db.select().from(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationid, conversationid), eq(messageConversationMembers.userid, userid)));
    return rows.length > 0;
  }
  /**
   * Conversation của user, mới nhất trước.
   */
  async listConversationsForUser(userid: string): Promise<ConversationRow[]> {
    const memberships = await this.db.select().from(messageConversationMembers).where(eq(messageConversationMembers.userid, userid));
    if (!memberships.length) return [];
    const rows: ConversationRow[] = [];
    for (const m of memberships) {
      const c = await this.getConversation(m.conversationid);
      if (c) rows.push(c);
    }
    return rows.sort((a, b) => b.timemodified.getTime() - a.timemodified.getTime());
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
    await (tx ?? this.db).update(messageConversations).set({ timemodified: new Date() }).where(eq(messageConversations.id, id));
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
  async listMessages(conversationid: string): Promise<MessageRow[]> {
    return this.db.select().from(message).where(eq(message.conversationid, conversationid)).orderBy(asc(message.id));
  }
  /**
   * Đánh dấu user đã đọc conversation tới thời điểm hiện tại.
   */
  async markConversationRead(conversationid: string, readerId: string): Promise<number> {
    const rows = await this.db.update(message).set({ timeread: new Date() })
      .where(and(eq(message.conversationid, conversationid), ne(message.useridfrom, readerId), isNull(message.timeread)))
      .returning();
    return rows.length;
  }
  /** Unread conversations for a user (Moodle count_unread_conversations): conversations with ≥1 unread message from others. */
  /**
   * Số conversation có tin chưa đọc của user.
   */
  async countUnreadConversations(userid: string): Promise<number> {
    const convs = await this.listConversationsForUser(userid);
    let count = 0;
    for (const c of convs) {
      const unread = await this.db.select().from(message)
        .where(and(eq(message.conversationid, c.id), ne(message.useridfrom, userid), isNull(message.timeread)));
      if (unread.length) count += 1;
    }
    return count;
  }

  /**
   * Chặn liên lạc từ một user.
   */
  async block(userid: string, blockeduserid: string): Promise<void> {
    await this.db.insert(messageUsersBlocked).values({ userid, blockeduserid }).onConflictDoNothing();
  }
  /**
   * Bỏ chặn.
   */
  async unblock(userid: string, blockeduserid: string): Promise<void> {
    await this.db.delete(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userid, userid), eq(messageUsersBlocked.blockeduserid, blockeduserid)));
  }
  /**
   * A có chặn B hay không.
   */
  async isBlocked(userid: string, blockeduserid: string): Promise<boolean> {
    const rows = await this.db.select().from(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userid, userid), eq(messageUsersBlocked.blockeduserid, blockeduserid)));
    return rows.length > 0;
  }
  /**
   * Danh sách user bị chặn.
   */
  async listBlocked(userid: string): Promise<string[]> {
    const rows = await this.db.select().from(messageUsersBlocked).where(eq(messageUsersBlocked.userid, userid));
    return rows.map((r) => r.blockeduserid);
  }

  // --- contacts -------------------------------------------------------------

  /**
   * Thêm một liên hệ vào danh bạ của user (trùng cặp thì bỏ qua).
   */
  async addContact(userid: string, contactid: string): Promise<void> {
    await this.db.insert(messageContacts).values({ userid, contactid }).onConflictDoNothing();
  }
  /**
   * Gỡ một liên hệ khỏi danh bạ của user.
   */
  async removeContact(userid: string, contactid: string): Promise<void> {
    await this.db.delete(messageContacts)
      .where(and(eq(messageContacts.userid, userid), eq(messageContacts.contactid, contactid)));
  }
  /**
   * Danh bạ của user (các contactid user đã thêm).
   */
  async listContacts(userid: string): Promise<string[]> {
    const rows = await this.db.select().from(messageContacts).where(eq(messageContacts.userid, userid));
    return rows.map((r) => r.contactid);
  }
  /**
   * Owner có contactid trong danh bạ hay không. Cổng liên lạc dùng hướng
   * (người nhận, người gửi): người nhận đã thêm người gửi làm liên hệ.
   */
  async isContact(ownerId: string, contactId: string): Promise<boolean> {
    const rows = await this.db.select().from(messageContacts)
      .where(and(eq(messageContacts.userid, ownerId), eq(messageContacts.contactid, contactId)));
    return rows.length > 0;
  }

  // --- cổng liên lạc: khoá học chung -----------------------------------------
  // Đọc trực tiếp bảng enrol/user_enrolments qua định nghĩa bảng dùng chung
  // (barrel schema) — Messaging KHÔNG import EnrolModule để tránh vòng lặp
  // module; ngữ nghĩa "đang active" chép đúng EnrolService.isEnrolled
  // (instance enabled, ghi danh ACTIVE, now trong [timestart, timeend]).

  /**
   * Các khoá mà user có ghi danh đang hiệu lực (instance enabled + ghi danh
   * ACTIVE + trong cửa sổ thời gian).
   */
  async activeCourseIds(userid: string): Promise<string[]> {
    const now = new Date();
    const rows = await this.db.select({ courseid: enrol.courseid }).from(userEnrolments)
      .innerJoin(enrol, eq(userEnrolments.enrolid, enrol.id))
      .where(and(
        eq(userEnrolments.userid, userid),
        eq(userEnrolments.status, 0),
        eq(enrol.status, 0),
        lte(userEnrolments.timestart, now),
        or(isNull(userEnrolments.timeend), gte(userEnrolments.timeend, now)),
      ));
    return rows.map((r) => r.courseid);
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
   * Lấy một course group theo id (kèm courseid để resolve context/staff).
   */
  async getCourseGroup(groupId: string): Promise<CourseGroupRow | undefined> {
    const [row] = await this.db.select().from(courseGroups).where(eq(courseGroups.id, groupId));
    return row;
  }
  /**
   * Thành viên hiện tại của một course group.
   */
  async listGroupMemberIds(groupId: string): Promise<string[]> {
    const rows = await this.db.select().from(groupsMembers).where(eq(groupsMembers.groupid, groupId));
    return rows.map((r) => r.userid);
  }
  /**
   * Conversation gắn với một course group qua (component, itemtype, itemid).
   */
  async findGroupConversation(groupId: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db.select().from(messageConversations).where(and(
      eq(messageConversations.component, 'core_group'),
      eq(messageConversations.itemtype, 'groups'),
      eq(messageConversations.itemid, groupId),
    ));
    return row;
  }
  /**
   * Mọi conversation gắn group mà user là thành viên của group tương ứng —
   * để thao tác liệt kê cũng kích hoạt đồng bộ (người mới vào group thấy
   * conversation ngay cả khi chưa từng là thành viên conversation).
   */
  async listGroupConversationsForGroupMember(userid: string): Promise<ConversationRow[]> {
    const memberships = await this.db.select().from(groupsMembers).where(eq(groupsMembers.userid, userid));
    if (!memberships.length) return [];
    return this.db.select().from(messageConversations).where(and(
      eq(messageConversations.component, 'core_group'),
      eq(messageConversations.itemtype, 'groups'),
      inArray(messageConversations.itemid, memberships.map((m) => m.groupid)),
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
  async listNotifications(useridto: string): Promise<NotificationRow[]> {
    return this.db.select().from(notifications).where(eq(notifications.useridto, useridto)).orderBy(desc(notifications.id));
  }
  /**
   * Số notification chưa đọc.
   */
  async countUnreadNotifications(useridto: string): Promise<number> {
    const rows = await this.db.select().from(notifications)
      .where(and(eq(notifications.useridto, useridto), isNull(notifications.timeread)));
    return rows.length;
  }
  /**
   * Đánh dấu một notification đã đọc.
   */
  async markNotificationRead(id: string, useridto: string): Promise<boolean> {
    const rows = await this.db.update(notifications).set({ timeread: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.useridto, useridto))).returning();
    return rows.length > 0;
  }
  /**
   * Đánh dấu mọi notification đã đọc.
   */
  async markAllNotificationsRead(useridto: string): Promise<number> {
    const rows = await this.db.update(notifications).set({ timeread: new Date() })
      .where(and(eq(notifications.useridto, useridto), isNull(notifications.timeread))).returning();
    return rows.length;
  }

  /**
   * Ghi nhật ký một lần dispatch notification qua kênh.
   */
  async insertDispatchLog(v: typeof notificationDispatchLog.$inferInsert, tx?: DbTx): Promise<DispatchLogRow> {
    const [row] = await (tx ?? this.db).insert(notificationDispatchLog).values(v)
      .onConflictDoNothing({ target: notificationDispatchLog.dedupekey }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupekey, v.dedupekey!));
    return existing!;
  }
  /**
   * Nhật ký dispatch (kiểm chứng gửi).
   */
  async listDispatchLog(userid: string): Promise<DispatchLogRow[]> {
    return this.db.select().from(notificationDispatchLog).where(eq(notificationDispatchLog.userid, userid)).orderBy(asc(notificationDispatchLog.id));
  }
}
