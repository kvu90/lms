import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { calendarEvents, calendarExportTokens, calendarSubscriptions } from '../../db/schema';

export type CalendarEventRow = typeof calendarEvents.$inferSelect;
export type CalendarSubscriptionRow = typeof calendarSubscriptions.$inferSelect;
export type CalendarExportTokenRow = typeof calendarExportTokens.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
/**
 * Kho dữ liệu lịch: sự kiện (kèm chuỗi lặp và exception), đăng ký lịch ngoài (subscription).
 */
export class CalendarRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  /**
   * Chèn sự kiện.
   */
  async insertEvent(v: typeof calendarEvents.$inferInsert, tx?: DbTx): Promise<CalendarEventRow> {
    const [row] = await (tx ?? this.db).insert(calendarEvents).values(v).returning(); return row!;
  }
  /**
   * Lấy sự kiện theo id.
   */
  async getEvent(id: string): Promise<CalendarEventRow | undefined> {
    const [row] = await this.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)); return row;
  }
  /**
   * Cập nhật sự kiện.
   */
  async updateEvent(id: string, patch: Partial<CalendarEventRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(calendarEvents).set({ ...patch, timemodified: new Date() }).where(eq(calendarEvents.id, id));
  }
  /**
   * Xoá sự kiện.
   */
  async deleteEvent(id: string): Promise<void> {
    await this.db.delete(calendarEvents).where(eq(calendarEvents.id, id));
  }
  /**
   * Mọi sự kiện của một phạm vi (cho quản trị).
   */
  async listAllEvents(): Promise<CalendarEventRow[]> {
    return this.db.select().from(calendarEvents).orderBy(asc(calendarEvents.timestart));
  }
  /**
   * Sự kiện có mốc trong khoảng thời gian (trước khi mở rộng chuỗi lặp).
   */
  async listEventsInRange(from: Date, to: Date): Promise<CalendarEventRow[]> {
    return this.db.select().from(calendarEvents)
      .where(and(gte(calendarEvents.timestart, from), lte(calendarEvents.timestart, to)))
      .orderBy(asc(calendarEvents.timestart));
  }
  /**
   * Các sự kiện thuộc cùng một chuỗi lặp.
   */
  async listSeries(repeatid: string): Promise<CalendarEventRow[]> {
    return this.db.select().from(calendarEvents).where(eq(calendarEvents.repeatid, repeatid)).orderBy(asc(calendarEvents.timestart));
  }
  /**
   * Tìm sự kiện đã nhập theo uuid của subscription (để đồng bộ không trùng).
   */
  async findBySubscriptionUuid(subscriptionid: string, uuid: string): Promise<CalendarEventRow | undefined> {
    const [row] = await this.db.select().from(calendarEvents)
      .where(and(eq(calendarEvents.subscriptionid, subscriptionid), eq(calendarEvents.uuid, uuid)));
    return row;
  }

  /**
   * Chèn đăng ký lịch ngoài.
   */
  async insertSubscription(v: typeof calendarSubscriptions.$inferInsert): Promise<CalendarSubscriptionRow> {
    const [row] = await this.db.insert(calendarSubscriptions).values(v).returning(); return row!;
  }
  /**
   * Lấy subscription theo id.
   */
  async getSubscription(id: string): Promise<CalendarSubscriptionRow | undefined> {
    const [row] = await this.db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, id)); return row;
  }
  /**
   * Subscription của user.
   */
  async listSubscriptions(): Promise<CalendarSubscriptionRow[]> {
    return this.db.select().from(calendarSubscriptions).orderBy(asc(calendarSubscriptions.id));
  }
  /**
   * Token xuất lịch đang hiệu lực của một user (chỉ chứa hash), nếu có.
   */
  async getExportTokenByUser(userid: string): Promise<CalendarExportTokenRow | undefined> {
    const [row] = await this.db.select().from(calendarExportTokens).where(eq(calendarExportTokens.userid, userid)); return row;
  }
  /**
   * Tìm token xuất lịch theo hash của token thô — đường tra cứu duy nhất của
   * URL xuất công khai; không bao giờ tra theo token thô.
   */
  async getExportTokenByHash(tokenhash: string): Promise<CalendarExportTokenRow | undefined> {
    const [row] = await this.db.select().from(calendarExportTokens).where(eq(calendarExportTokens.tokenhash, tokenhash)); return row;
  }
  /**
   * Tạo mới hoặc thay thế token xuất lịch của user (một user một token):
   * ghi đè hash cũ khiến URL xuất cũ chết ngay khi đổi token.
   */
  async upsertExportToken(userid: string, tokenhash: string): Promise<CalendarExportTokenRow> {
    const [row] = await this.db.insert(calendarExportTokens).values({ userid, tokenhash })
      .onConflictDoUpdate({
        target: calendarExportTokens.userid,
        set: { tokenhash, timemodified: new Date(), lastaccess: null },
      }).returning();
    return row!;
  }
  /**
   * Thu hồi token xuất lịch của user: xoá hẳn bản ghi hash để URL cũ chết;
   * trả về true khi thật sự có token đã bị thu hồi.
   */
  async deleteExportToken(userid: string): Promise<boolean> {
    const deleted = await this.db.delete(calendarExportTokens).where(eq(calendarExportTokens.userid, userid)).returning();
    return deleted.length > 0;
  }
  /**
   * Ghi nhận lần dùng URL xuất công khai gần nhất.
   */
  async touchExportToken(id: string): Promise<void> {
    await this.db.update(calendarExportTokens).set({ lastaccess: new Date() }).where(eq(calendarExportTokens.id, id));
  }

  /**
   * Cập nhật mốc đồng bộ gần nhất của subscription.
   */
  async touchSubscription(id: string): Promise<void> {
    await this.db.update(calendarSubscriptions).set({ lastupdated: new Date() }).where(eq(calendarSubscriptions.id, id));
  }
}
