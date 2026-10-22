import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '../../db/database';
import { calendarEvents, calendarSubscriptions } from '../../db/schema';

export type CalendarEventRow = typeof calendarEvents.$inferSelect;
export type CalendarSubscriptionRow = typeof calendarSubscriptions.$inferSelect;
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

@Injectable()
export class CalendarRepository {
  constructor(@InjectDrizzle() private readonly db: Database) {}
  get dbHandle(): Database { return this.db; }

  async insertEvent(v: typeof calendarEvents.$inferInsert, tx?: DbTx): Promise<CalendarEventRow> {
    const [row] = await (tx ?? this.db).insert(calendarEvents).values(v).returning(); return row!;
  }
  async getEvent(id: number): Promise<CalendarEventRow | undefined> {
    const [row] = await this.db.select().from(calendarEvents).where(eq(calendarEvents.id, id)); return row;
  }
  async updateEvent(id: number, patch: Partial<CalendarEventRow>, tx?: DbTx): Promise<void> {
    await (tx ?? this.db).update(calendarEvents).set({ ...patch, timemodified: new Date() }).where(eq(calendarEvents.id, id));
  }
  async deleteEvent(id: number): Promise<void> {
    await this.db.delete(calendarEvents).where(eq(calendarEvents.id, id));
  }
  async listAllEvents(): Promise<CalendarEventRow[]> {
    return this.db.select().from(calendarEvents).orderBy(asc(calendarEvents.timestart));
  }
  async listEventsInRange(from: Date, to: Date): Promise<CalendarEventRow[]> {
    return this.db.select().from(calendarEvents)
      .where(and(gte(calendarEvents.timestart, from), lte(calendarEvents.timestart, to)))
      .orderBy(asc(calendarEvents.timestart));
  }
  async listSeries(repeatid: number): Promise<CalendarEventRow[]> {
    return this.db.select().from(calendarEvents).where(eq(calendarEvents.repeatid, repeatid)).orderBy(asc(calendarEvents.timestart));
  }
  async findBySubscriptionUuid(subscriptionid: number, uuid: string): Promise<CalendarEventRow | undefined> {
    const [row] = await this.db.select().from(calendarEvents)
      .where(and(eq(calendarEvents.subscriptionid, subscriptionid), eq(calendarEvents.uuid, uuid)));
    return row;
  }

  async insertSubscription(v: typeof calendarSubscriptions.$inferInsert): Promise<CalendarSubscriptionRow> {
    const [row] = await this.db.insert(calendarSubscriptions).values(v).returning(); return row!;
  }
  async getSubscription(id: number): Promise<CalendarSubscriptionRow | undefined> {
    const [row] = await this.db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, id)); return row;
  }
  async listSubscriptions(): Promise<CalendarSubscriptionRow[]> {
    return this.db.select().from(calendarSubscriptions).orderBy(asc(calendarSubscriptions.id));
  }
  async touchSubscription(id: number): Promise<void> {
    await this.db.update(calendarSubscriptions).set({ lastupdated: new Date() }).where(eq(calendarSubscriptions.id, id));
  }
}
