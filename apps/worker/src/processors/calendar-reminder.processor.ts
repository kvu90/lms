import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { relations } from '../db/relations';
import { calendarEvents, notifications } from '@lms/db-schema';
import { NotificationDeliveryService } from '../notification-delivery.service';

type Database = NodePgDatabase<typeof relations>;

export interface CalendarReminderJobData { eventId: string; userId: string; minutesBefore: number }
export interface CalendarReminderResult { status: 'notified' | 'duplicate' | 'skipped-suspended' | 'skipped-preference' | 'event-missing'; notificationId?: string }

/**
 * Calendar reminders: the API schedules these as BullMQ DELAYED jobs;
 * at fire time the worker creates the reminder as a Messaging notification
 * via the 'calendar_reminder' provider. Delivery goes through the shared
 * worker delivery law ({@link NotificationDeliveryService}, NB-6) — the
 * same law as the API's `notify()` for the in-app channel: no suspended
 * recipients, effective v2 preference (legacy keys still honoured via
 * derivation), dispatch log, and an immediate unread-badge signal.
 * Idempotent: one reminder notification per (user, event) ever.
 */
@Processor('calendar-reminders')
/**
 * Xử lý job nhắc lịch: gửi notification nhắc sự kiện; nội dung lấy từ catalog i18n (locale mặc định vi cho người nhận — xem recipientLocale).
 */
export class CalendarReminderProcessor extends WorkerHost {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly i18n: I18nService,
    private readonly delivery: NotificationDeliveryService,
  ) { super(); }

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
    // Text nhắc nhở tra catalog i18n; worker ngoài request context nên
    // truyền locale tường minh (mặc định 'vi' như các processor nền tảng).
    const recipientLocale = 'vi';
    const subject = this.i18n.t('platform.calendarReminderSubject', { locale: recipientLocale, args: { name: event.name } });
    const delivered = await this.delivery.deliverInApp(userId, 'calendar_reminder', {
      subject,
      body: this.i18n.t('platform.calendarReminderBody', { locale: recipientLocale, args: { name: event.name, time: event.timeStart.toISOString() } }),
      smallMessage: subject,
      contextUrl,
    });
    if (delivered.status === 'delivered') return { status: 'notified', notificationId: delivered.notificationId };
    if (delivered.status === 'skipped-suspended') return { status: 'skipped-suspended' };
    // 'skipped-preference' là trạng thái duy nhất còn lại cho provider đã
    // đăng ký này (deliverInApp chỉ trả unknown-provider khi provider
    // không nằm trong sổ worker — calendar_reminder luôn có mặt).
    return { status: 'skipped-preference' };
  }
}
