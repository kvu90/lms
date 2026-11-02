import { Processor, WorkerHost } from '@nestjs/bullmq';
import { I18nService } from '@nestjs/i18n';
import type { Job } from 'bullmq';
import { NotificationDeliveryService } from '../notification-delivery.service';
import { tenantAls } from '../db/tenant-als';
import { resolveDefaultTenantId } from '../db/default-tenant';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

export interface CalendarReminderJobData { eventId: string; userId: string; minutesBefore: number }
export interface CalendarReminderResult { status: 'notified' | 'duplicate' | 'skipped-suspended' | 'skipped-preference' | 'skipped-admin-disabled' | 'event-missing'; notificationId?: string }

/**
 * Nhắc lịch (calendar reminders): API lập lịch các nhắc này dưới dạng job BullMQ DELAYED;
 * khi đến thời điểm kích hoạt, worker tạo nhắc dưới dạng thông báo Messaging
 * qua provider 'calendar_reminder'. Việc phân phối đi qua luật phân phối dùng chung của worker
 * ({@link NotificationDeliveryService}, NB-6) — cùng
 * luật với `notify()` phía API cho kênh trong-app: không gửi cho người nhận bị đình chỉ,
 * tuỳ chọn v2 hiệu lực (các khoá legacy vẫn được tôn trọng qua
 * suy diễn), dispatch log, và tín hiệu huy hiệu chưa đọc tức thì.
 * Idempotent: mỗi (user, event) chỉ có đúng một thông báo nhắc.
 */
@Processor('calendar-reminders')
/**
 * Xử lý job nhắc lịch: gửi notification nhắc sự kiện; nội dung lấy từ catalog i18n (locale mặc định vi cho người nhận — xem recipientLocale).
 */
export class CalendarReminderProcessor extends WorkerHost {
  constructor(
    private readonly i18n: I18nService,
    private readonly delivery: NotificationDeliveryService,
    private readonly spaceDb: SpaceDatabaseService,
  ) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<CalendarReminderJobData>): Promise<CalendarReminderResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<CalendarReminderJobData>): Promise<CalendarReminderResult> {
    const { eventId, userId } = job.data;
    const event = await this.spaceDb.routedKysely
      .selectFrom('calendar_events')
      .select(['name', 'course_id as courseId', 'time_start as timeStart'])
      .where('id', '=', eventId)
      .executeTakeFirst();
    if (!event) return { status: 'event-missing' };
    const contextUrl = `/calendar/events/${eventId}`;
    const existing = await this.spaceDb.routedKysely
      .selectFrom('notifications')
      .select('id')
      .where('user_id_to', '=', userId)
      .where('event_type', '=', 'calendar_reminder')
      .where('context_url', '=', contextUrl)
      .executeTakeFirst();
    if (existing) return { status: 'duplicate', notificationId: existing.id };
    // Text nhắc nhở tra catalog i18n; worker ngoài request context nên
    // truyền locale tường minh (mặc định 'vi' như các processor nền tảng).
    const recipientLocale = 'vi';
    const subject = this.i18n.t('platform.calendarReminderSubject', { locale: recipientLocale, args: { name: event.name } });
    // TENANT-1 (#196): tenant của notification = tenant của khoá chứa
    // sự kiện; sự kiện cá nhân/platform thì lấy tenant mặc định của
    // người nhận theo membership. Truyền xuống hàm luật dùng chung để
    // dòng thông báo + dispatch log mang đúng tenant (thiếu là thông
    // báo thành "không gắn tenant", user trong tenant không thấy).
    let tenantId: string | null = null;
    if (event.courseId) {
      const courseRow = await this.spaceDb.routedKysely
        .selectFrom('course')
        .select('tenant_id as tenantId')
        .where('id', '=', event.courseId)
        .executeTakeFirst();
      tenantId = courseRow?.tenantId ?? null;
    }
    if (!tenantId) tenantId = await resolveDefaultTenantId(this.spaceDb.routedKysely, userId);
    const delivered = await this.delivery.deliverInApp(userId, 'calendar_reminder', {
      subject,
      body: this.i18n.t('platform.calendarReminderBody', { locale: recipientLocale, args: { name: event.name, time: event.timeStart.toISOString() } }),
      smallMessage: subject,
      contextUrl,
      tenantId,
    });
    if (delivered.status === 'delivered') return { status: 'notified', notificationId: delivered.notificationId };
    if (delivered.status === 'skipped-suspended') return { status: 'skipped-suspended' };
    if (delivered.status === 'skipped-admin-disabled') return { status: 'skipped-admin-disabled' };
    // 'skipped-preference' là trạng thái duy nhất còn lại cho provider đã
    // đăng ký này (deliverInApp chỉ trả unknown-provider khi provider
    // không nằm trong sổ worker — calendar_reminder luôn có mặt).
    return { status: 'skipped-preference' };
  }
}
