import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { calendarEvents, calendarSubscriptions } from '../db/schema';
import { parseIcs } from '../domain/ics';

type Database = NodePgDatabase<typeof relations>;

export interface CalendarImportJobData { subscriptionId: number }
export interface CalendarImportResult { eventsimported: number; eventsskipped: number; eventsupdated: 0; eventsdeleted: 0 }

/**
 * Calendar subscription import: parses the subscription's ICS payload
 * at a basic level and materialises its VEVENTs as calendar_events bound to
 * the subscription. Re-running is idempotent — an event whose
 * (subscriptionid, UID) already exists is skipped, mirroring the counts
 * shape of Moodle's calendar_import_events_from_ical (oracle: calendar/
 * tests/lib_test test_add_subscription).
 */
@Processor('calendar-import')
export class CalendarImportProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  async process(job: Job<CalendarImportJobData>): Promise<CalendarImportResult> {
    const { subscriptionId } = job.data;
    const [sub] = await this.db.select().from(calendarSubscriptions).where(eq(calendarSubscriptions.id, subscriptionId));
    if (!sub || !sub.icsdata) return { eventsimported: 0, eventsskipped: 0, eventsupdated: 0, eventsdeleted: 0 };
    const parsed = parseIcs(sub.icsdata);
    let imported = 0;
    let skipped = 0;
    for (const event of parsed) {
      const [existing] = await this.db.select().from(calendarEvents).where(and(
        eq(calendarEvents.subscriptionid, subscriptionId), eq(calendarEvents.uuid, event.uid),
      ));
      if (existing) { skipped += 1; continue; }
      await this.db.insert(calendarEvents).values({
        name: event.summary, description: event.description, eventtype: sub.eventtype,
        courseid: sub.courseid, categoryid: sub.categoryid, userid: sub.userid,
        subscriptionid: subscriptionId, uuid: event.uid, timestart: event.start,
        timeduration: event.end ? Math.max(0, Math.round((event.end.getTime() - event.start.getTime()) / 1000)) : 0,
      });
      imported += 1;
    }
    await this.db.update(calendarSubscriptions).set({ lastupdated: new Date() }).where(eq(calendarSubscriptions.id, subscriptionId));
    return { eventsimported: imported, eventsskipped: skipped, eventsupdated: 0, eventsdeleted: 0 };
  }
}
