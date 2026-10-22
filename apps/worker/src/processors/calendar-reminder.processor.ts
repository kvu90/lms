import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { calendarEvents, notificationDispatchLog, notifications, userPreferences, users } from '../db/schema';

type Database = NodePgDatabase<typeof relations>;

export interface CalendarReminderJobData { eventId: number; userId: number; minutesBefore: number }
export interface CalendarReminderResult { status: 'notified' | 'duplicate' | 'skipped-suspended' | 'skipped-preference' | 'event-missing'; notificationId?: number }

/**
 * Calendar reminders (P4): the API schedules these as BullMQ DELAYED jobs;
 * at fire time the worker creates the reminder as a Messaging notification
 * via the 'calendar_reminder' provider — honouring the same delivery law
 * (no suspended recipients; popup preference off ⇒ nothing stored).
 * Idempotent: one reminder notification per (user, event) ever.
 */
@Processor('calendar-reminders')
export class CalendarReminderProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database) { super(); }

  async process(job: Job<CalendarReminderJobData>): Promise<CalendarReminderResult> {
    const { eventId, userId } = job.data;
    const [event] = await this.db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId));
    if (!event) return { status: 'event-missing' };
    const contexturl = `/calendar/events/${eventId}`;
    const [existing] = await this.db.select().from(notifications).where(and(
      eq(notifications.useridto, userId), eq(notifications.eventtype, 'calendar_reminder'),
      eq(notifications.contexturl, contexturl),
    ));
    if (existing) return { status: 'duplicate', notificationId: existing.id };
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.suspended || user.deleted) return { status: 'skipped-suspended' };
    const [pref] = await this.db.select().from(userPreferences).where(and(
      eq(userPreferences.userid, userId),
      eq(userPreferences.name, 'message_provider_calendar_reminder_popup_loggedin'),
    ));
    if (pref?.value === '0') return { status: 'skipped-preference' };
    const subject = `Reminder: ${event.name}`;
    const [notification] = await this.db.insert(notifications).values({
      useridto: userId, subject,
      fullmessage: `The event "${event.name}" starts at ${event.timestart.toISOString()}.`,
      smallmessage: subject, component: 'core_calendar', eventtype: 'calendar_reminder',
      contexturl,
    }).returning();
    await this.db.insert(notificationDispatchLog).values({
      notificationid: notification!.id, userid: userId, provider: 'calendar_reminder',
      channel: 'popup', status: 'delivered', subject, dedupekey: `popup-${notification!.id}`,
    }).onConflictDoNothing();
    return { status: 'notified', notificationId: notification!.id };
  }
}
