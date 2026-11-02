import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { parseIcs } from '../domain/ics';
import { tenantAls } from '../db/tenant-als';
import { SpaceDatabaseService } from '../db/routing/space-database.service';

export interface CalendarImportJobData { subscriptionId: string }
export interface CalendarImportResult { eventsimported: number; eventsskipped: number; eventsupdated: 0; eventsdeleted: 0 }

/**
 * Nhập lịch đăng ký (calendar subscription): phân tích payload ICS của subscription
 * ở mức cơ bản và vật chất hoá các VEVENT của nó thành calendar_events gắn với
 * subscription. Chạy lại có tính idempotent — một sự kiện mà
 * (subscriptionId, UID) của nó đã tồn tại sẽ bị bỏ qua, phản chiếu đúng hình dạng counts
 * của calendar_import_events_from_ical của Moodle (oracle: calendar/
 * tests/lib_test test_add_subscription).
 */
@Processor('calendar-import', { concurrency: 5 })
/**
 * Xử lý job nhập lịch subscription: tải .ics, phân tích bằng domain/ics và đồng bộ sự kiện (không trùng theo uuid).
 * Concurrency 5: job thuần I/O (tải tệp .ics từ xa) — concurrency mặc định 1 để một
 * nguồn lịch chậm chặn mọi subscription phía sau; việc nhập lại idempotent theo
 * (subscriptionId, UID) nên chạy song song an toàn.
 */
export class CalendarImportProcessor extends WorkerHost {
  constructor(private readonly spaceDb: SpaceDatabaseService) { super(); }

  /**
   * Xử lý một job của queue tương ứng.
   */
  async process(job: Job<CalendarImportJobData>): Promise<CalendarImportResult> {
    // TENANT-1 (#196): processor nền quét/xử lý xuyên tenant — bọc
    // ngữ cảnh platform tường minh để RLS fail-closed không làm mù
    // dữ liệu tenant (pool gắn GUC theo ALS ở mọi checkout).
    return tenantAls.run({ platform: true }, () => this.processInContext(job));
  }

  private async processInContext(job: Job<CalendarImportJobData>): Promise<CalendarImportResult> {
    const { subscriptionId } = job.data;
    const sub = await this.spaceDb.routedKysely
      .selectFrom('calendar_subscriptions')
      .select([
        'id', 'ics_data as icsData', 'event_type as eventType', 'course_id as courseId',
        'category_id as categoryId', 'user_id as userId',
      ])
      .where('id', '=', subscriptionId)
      .executeTakeFirst();
    if (!sub || !sub.icsData) return { eventsimported: 0, eventsskipped: 0, eventsupdated: 0, eventsdeleted: 0 };
    const parsed = parseIcs(sub.icsData);
    let imported = 0;
    let skipped = 0;
    for (const event of parsed) {
      const existing = await this.spaceDb.routedKysely
        .selectFrom('calendar_events')
        .select('id')
        .where('subscription_id', '=', subscriptionId)
        .where('uuid', '=', event.uid)
        .executeTakeFirst();
      if (existing) { skipped += 1; continue; }
      await this.spaceDb.routedKysely
        .insertInto('calendar_events')
        .values({
          name: event.summary, description: event.description, event_type: sub.eventType,
          course_id: sub.courseId, category_id: sub.categoryId, user_id: sub.userId,
          subscription_id: subscriptionId, uuid: event.uid, time_start: event.start,
          time_duration: event.end ? Math.max(0, Math.round((event.end.getTime() - event.start.getTime()) / 1000)) : 0,
        })
        .execute();
      imported += 1;
    }
    await this.spaceDb.routedKysely
      .updateTable('calendar_subscriptions')
      .set({ last_updated: new Date() })
      .where('id', '=', subscriptionId)
      .execute();
    return { eventsimported: imported, eventsskipped: skipped, eventsupdated: 0, eventsdeleted: 0 };
  }
}
