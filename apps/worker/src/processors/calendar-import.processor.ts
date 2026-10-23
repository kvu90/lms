import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { calendarEvents, calendarSubscriptions } from '../db/schema';
import { parseIcs } from '../domain/ics';

type Database = NodePgDatabase<typeof relations>;

export interface CalendarImportJobData { subscriptionId: string }
export interface CalendarImportResult { eventsimported: number; eventsskipped: number; eventsupdated: 0; eventsdeleted: 0 }

/**
 * Calendar subscription import: parses the subscription's ICS payload
 * at a basic level and materialises its VEVENTs as calendar_events bound to
 * the subscription. Re-running is idempotent — an event whose
 * (subscriptionId, UID) already exists is skipped, mirroring the counts
 * shape of Moodle's calendar_import_events_from_ical (oracle: calendar/
 * tests/lib_test test_add_subscription).
 */
@Processor('calendar-import')
/**
 * Xử lý job nhập lịch subscription: tải .ics, phân tích bằng domain/ics và đồng bộ sự kiện (không trùng theo uuid).
 */
export class CalendarImportProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<CalendarImportJobData>): Promise<CalendarImportResult> {
    const { subscriptionId } = job.data;
    const [sub] = await this.db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, subscriptionId));
    if (!sub || !sub.icsData) return { eventsimported: 0, eventsskipped: 0, eventsupdated: 0, eventsdeleted: 0 };
    const parsed = parseIcs(sub.icsData);
    let imported = 0;
    let skipped = 0;
    for (const event of parsed) {
      const [existing] = await this.db.select().from(calendarEvents).where(and(
        eq(calendarEvents.subscriptionId, subscriptionId), eq(calendarEvents.uuid, event.uid),
      ));
      if (existing) { skipped += 1; continue; }
      await this.db.insert(calendarEvents).values({
        name: event.summary, description: event.description, eventType: sub.eventType,
        courseId: sub.courseId, categoryId: sub.categoryId, userId: sub.userId,
        subscriptionId: subscriptionId, uuid: event.uid, timeStart: event.start,
        timeDuration: event.end ? Math.max(0, Math.round((event.end.getTime() - event.start.getTime()) / 1000)) : 0,
      });
      imported += 1;
    }
    await this.db.update(calendarSubscriptions).set({ lastUpdated: new Date() }).where(eq(calendarSubscriptions.id, subscriptionId));
    return { eventsimported: imported, eventsskipped: skipped, eventsupdated: 0, eventsdeleted: 0 };
  }
}
