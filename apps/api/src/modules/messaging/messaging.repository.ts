import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../../db/database';
import {
  message, messageConversationMembers, messageConversations, messageUsersBlocked,
  notificationDispatchLog, notifications,
} from '../../db/schema';

export type ConversationRow = typeof messageConversations.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type DispatchLogRow = typeof notificationDispatchLog.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class MessagingRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async insertConversation(v: typeof messageConversations.$inferInsert, tx?: DbTx): Promise<ConversationRow> {
    const [row] = await (tx ?? this.db).insert(messageConversations).values(v).returning(); return row!;
  }
  async getConversation(id: number): Promise<ConversationRow | undefined> {
    const [row] = await this.db.select().from(messageConversations).where(eq(messageConversations.id, id)); return row;
  }
  async addMember(conversationid: number, userid: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).insert(messageConversationMembers).values({ conversationid, userid }).onConflictDoNothing();
  }
  async listMembers(conversationid: number): Promise<number[]> {
    const rows = await this.db.select().from(messageConversationMembers).where(eq(messageConversationMembers.conversationid, conversationid));
    return rows.map((r) => r.userid);
  }
  async isMember(conversationid: number, userid: number): Promise<boolean> {
    const rows = await this.db.select().from(messageConversationMembers)
      .where(and(eq(messageConversationMembers.conversationid, conversationid), eq(messageConversationMembers.userid, userid)));
    return rows.length > 0;
  }
  async listConversationsForUser(userid: number): Promise<ConversationRow[]> {
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
  async findIndividualConversation(a: number, b: number): Promise<ConversationRow | undefined> {
    const mine = await this.listConversationsForUser(a);
    for (const c of mine) {
      if (c.type !== 1) continue;
      const members = await this.listMembers(c.id);
      if (members.length === 2 && members.includes(b)) return c;
    }
    return undefined;
  }
  async touchConversation(id: number, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(messageConversations).set({ timemodified: new Date() }).where(eq(messageConversations.id, id));
  }

  async insertMessage(v: typeof message.$inferInsert, tx?: DbTx): Promise<MessageRow> {
    const [row] = await (tx ?? this.db).insert(message).values(v).returning(); return row!;
  }
  async getMessage(id: number): Promise<MessageRow | undefined> {
    const [row] = await this.db.select().from(message).where(eq(message.id, id)); return row;
  }
  async listMessages(conversationid: number): Promise<MessageRow[]> {
    return this.db.select().from(message).where(eq(message.conversationid, conversationid)).orderBy(asc(message.id));
  }
  async markConversationRead(conversationid: number, readerId: number): Promise<number> {
    const rows = await this.db.update(message).set({ timeread: new Date() })
      .where(and(eq(message.conversationid, conversationid), ne(message.useridfrom, readerId), isNull(message.timeread)))
      .returning();
    return rows.length;
  }
  /** Unread conversations for a user (Moodle count_unread_conversations): conversations with ≥1 unread message from others. */
  async countUnreadConversations(userid: number): Promise<number> {
    const convs = await this.listConversationsForUser(userid);
    let count = 0;
    for (const c of convs) {
      const unread = await this.db.select().from(message)
        .where(and(eq(message.conversationid, c.id), ne(message.useridfrom, userid), isNull(message.timeread)));
      if (unread.length) count += 1;
    }
    return count;
  }

  async block(userid: number, blockeduserid: number): Promise<void> {
    await this.db.insert(messageUsersBlocked).values({ userid, blockeduserid }).onConflictDoNothing();
  }
  async unblock(userid: number, blockeduserid: number): Promise<void> {
    await this.db.delete(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userid, userid), eq(messageUsersBlocked.blockeduserid, blockeduserid)));
  }
  async isBlocked(userid: number, blockeduserid: number): Promise<boolean> {
    const rows = await this.db.select().from(messageUsersBlocked)
      .where(and(eq(messageUsersBlocked.userid, userid), eq(messageUsersBlocked.blockeduserid, blockeduserid)));
    return rows.length > 0;
  }
  async listBlocked(userid: number): Promise<number[]> {
    const rows = await this.db.select().from(messageUsersBlocked).where(eq(messageUsersBlocked.userid, userid));
    return rows.map((r) => r.blockeduserid);
  }

  async insertNotification(v: typeof notifications.$inferInsert, tx?: DbTx): Promise<NotificationRow> {
    const [row] = await (tx ?? this.db).insert(notifications).values(v).returning(); return row!;
  }
  async listNotifications(useridto: number): Promise<NotificationRow[]> {
    return this.db.select().from(notifications).where(eq(notifications.useridto, useridto)).orderBy(desc(notifications.id));
  }
  async countUnreadNotifications(useridto: number): Promise<number> {
    const rows = await this.db.select().from(notifications)
      .where(and(eq(notifications.useridto, useridto), isNull(notifications.timeread)));
    return rows.length;
  }
  async markNotificationRead(id: number, useridto: number): Promise<boolean> {
    const rows = await this.db.update(notifications).set({ timeread: new Date() })
      .where(and(eq(notifications.id, id), eq(notifications.useridto, useridto))).returning();
    return rows.length > 0;
  }
  async markAllNotificationsRead(useridto: number): Promise<number> {
    const rows = await this.db.update(notifications).set({ timeread: new Date() })
      .where(and(eq(notifications.useridto, useridto), isNull(notifications.timeread))).returning();
    return rows.length;
  }

  async insertDispatchLog(v: typeof notificationDispatchLog.$inferInsert, tx?: DbTx): Promise<DispatchLogRow> {
    const [row] = await (tx ?? this.db).insert(notificationDispatchLog).values(v)
      .onConflictDoNothing({ target: notificationDispatchLog.dedupekey }).returning();
    if (row) return row;
    const [existing] = await this.db.select().from(notificationDispatchLog)
      .where(eq(notificationDispatchLog.dedupekey, v.dedupekey!));
    return existing!;
  }
  async listDispatchLog(userid: number): Promise<DispatchLogRow[]> {
    return this.db.select().from(notificationDispatchLog).where(eq(notificationDispatchLog.userid, userid)).orderBy(asc(notificationDispatchLog.id));
  }
}
