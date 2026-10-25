import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { calendarEvents, notificationDispatchLog, notifications, userPreferences, users } from '@lms/db-schema';

type Database = NodePgDatabase<typeof relations>;

export interface CalendarReminderJobData { eventId: string; userId: string; minutesBefore: number }
export interface CalendarReminderResult { status: 'notified' | 'duplicate' | 'skipped-suspended' | 'skipped-preference' | 'event-missing'; notificationId?: string }

/**
 * Calendar reminders: the API schedules these as BullMQ DELAYED jobs;
 * at fire time the worker creates the reminder as a Messaging notification
 * via the 'calendar_reminder' provider — honouring the same delivery law
 * (no suspended recipients; popup preference off ⇒ nothing stored).
 * Idempotent: one reminder notification per (user, event) ever.
 */
@Processor('calendar-reminders')
/**
 * Xử lý job nhắc lịch: gửi notification nhắc sự kiện; nội dung lấy từ catalog i18n (locale mặc định vi cho người nhận — xem recipientLocale).
 */
export class CalendarReminderProcessor extends WorkerHost {
  constructor(@InjectDrizzle() private readonly db: Database, private readonly i18n: I18nService) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<CalendarReminderJobData>): Promise<CalendarReminderResult> {
    const { eventId, userId } = job.data;
    const [event] = await this.db.select().from(calendarEvents).where(eq(calendarEvents.id, eventId));
    if (!event) return { status: 'event-missing' };
    const contextUrl = `/calendar/events/${eventId}`;
    const [existing] = await this.db.select().from(notifications).where(and(
      eq(notifications.userIdTo, userId), eq(notifications.eventType, 'calendar_reminder'),
      eq(notifications.contextUrl, contextUrl),
    ));
    if (existing) return { status: 'duplicate', notificationId: existing.id };
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.suspended || user.deleted) return { status: 'skipped-suspended' };
    const [pref] = await this.db.select().from(userPreferences).where(and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.name, 'message_provider_calendar_reminder_popup_loggedin'),
    ));
    if (pref?.value === '0') return { status: 'skipped-preference' };
    // Text nhắc nhở tra catalog i18n; worker ngoài request context nên
    // truyền locale tường minh (mặc định 'vi' như các processor nền tảng).
    const recipientLocale = 'vi';
    const subject = this.i18n.t('platform.calendarReminderSubject', { locale: recipientLocale, args: { name: event.name } });
    const [notification] = await this.db.insert(notifications).values({
      userIdTo: userId, subject,
      fullMessage: this.i18n.t('platform.calendarReminderBody', { locale: recipientLocale, args: { name: event.name, time: event.timeStart.toISOString() } }),
      smallMessage: subject, component: 'core_calendar', eventType: 'calendar_reminder',
      contextUrl,
    }).returning();
    await this.db.insert(notificationDispatchLog).values({
      notificationId: notification!.id, userId: userId, provider: 'calendar_reminder',
      channel: 'popup', status: 'delivered', subject, dedupeKey: `popup-${notification!.id}`,
    }).onConflictDoNothing();
    return { status: 'notified', notificationId: notification!.id };
  }
}
