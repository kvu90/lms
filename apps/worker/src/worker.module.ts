import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { drizzle } from 'drizzle-orm/node-postgres';
import { I18nWorkerModule } from './i18n/i18n.config';
import { databaseConnectionFromEnv, redisConnectionFromUrl, validateEnv } from './config/env';
import { relations } from './db/relations';
import { TenantAwarePool } from './db/tenant-pool';
import { EnrolExpiryScheduler } from './enrol-expiry.scheduler';
import { ClassEnrolReconcileScheduler } from './class-enrol-reconcile.scheduler';
import { ClassEnrolReconcileProcessor } from './processors/class-enrol-reconcile.processor';
import { ActivityDueReminderScheduler } from './activity-due-reminder.scheduler';
import { NotificationRetentionScheduler } from './notification-retention.scheduler';
import { NotificationDeliveryService } from './notification-delivery.service';
import { GuardianDigestScheduler } from './guardian-digest.scheduler';
import { GuardianDigestProcessor } from './processors/guardian-digest.processor';
import { GuardianDigestEventsProcessor } from './processors/guardian-digest-events.processor';
import { GuardianDigestHandlerService } from './guardian-digest-handler.service';
import { NotificationEventsProcessor } from './processors/notification-events.processor';
import { NotificationEventsHandlerService } from './notification-events-handler.service';
import { NotificationEventsMarker } from './notification-events-marker.service';
import { NotificationEventsCatchupService } from './notification-events-catchup.service';
import { MessagingRealtimeProcessor, MESSAGING_DISTRIBUTED_REDIS, MESSAGING_DISTRIBUTION_SERVICE } from './processors/messaging-realtime.processor';
import { MessagingRealtimeRuntime } from './messaging-realtime.runtime';
import { CohortSyncService } from './cohort-sync.service';
import { CohortSyncEventsProcessor } from './processors/cohort-sync-events.processor';
import { CohortSyncCatchupService } from './cohort-sync-catchup.service';
import { EventLogWriter } from './event-log-writer.service';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import {
  OUTBOX_EVENT_QUEUE_ROUTES,
  OUTBOX_EVENT_QUEUES,
  OUTBOX_EVENT_ROUTES,
  allQueueNamesOfRoutes,
  type OutboxEventQueues,
} from './outbox-event-routes';
import { TaskLogService } from './task-log.service';
import { BadgeAwardProcessor } from './processors/badge-award.processor';
import { CalendarImportProcessor } from './processors/calendar-import.processor';
import { CalendarReminderProcessor } from './processors/calendar-reminder.processor';
import { CompletionRecalculateProcessor } from './processors/completion-recalculate.processor';
import { NotificationDispatchProcessor } from './processors/notification-dispatch.processor';
import { NotificationDigestProcessor } from './processors/notification-digest.processor';
import { NotificationDigestScheduler } from './notification-digest.scheduler';
import { ResendMailService } from './resend-mail.service';
import { NotificationRetentionProcessor } from './processors/notification-retention.processor';
import { EnrolExpiryProcessor } from './processors/enrol-expiry.processor';
import { ActivityDueReminderProcessor } from './processors/activity-due-reminder.processor';
import { FileCleanupProcessor } from './processors/file-cleanup.processor';
import {
  AUTH_MAIL_SENT_MARKER, AuthMailProcessor, RedisAuthMailSentMarker,
} from './processors/auth-mail.processor';
import {
  AnalyticsRunProcessor, BackupProcessor, PaymentReconciliationProcessor, PrivacyProcessor,
  ReportScheduleProcessor, RestoreProcessor, SearchReindexProcessor,
} from './processors/platform-services.processors';

/**
 * Tên các hàng đợi phát sự kiện outbox, suy ra từ bảng định tuyến
 * {@link OUTBOX_EVENT_QUEUE_ROUTES}: mỗi loại sự kiện đã định tuyến
 * đóng góp mọi hàng đợi đích của nó một lần (một loại fan-out nhiều
 * đích đóng góp đủ các đích). Đăng ký hàng đợi và bản đồ hàng đợi
 * cấp cho relay đều suy ra từ danh sách này nên hai nơi không thể
 * lệch nhau khi bảng định tuyến được mở rộng.
 */
const outboxRouteQueueNames: string[] = allQueueNamesOfRoutes(OUTBOX_EVENT_QUEUE_ROUTES);

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    I18nWorkerModule,
    DrizzleModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const connection = databaseConnectionFromEnv(
          config.getOrThrow<string>('DATABASE_URL'),
          config.get<boolean>('DATABASE_SSL') ?? false,
        );
        const pool = new TenantAwarePool(
          typeof connection === 'string' ? { connectionString: connection } : connection,
        );
        return {
          // TENANT-1 (#196): pool tự dựng có gắn GUC tenant theo ngữ
          // cảnh ALS ở mọi checkout — cùng cơ chế với phía API (xem
          // apps/api/src/app.module.ts): scheduler/processor tự bọc
          // ngữ cảnh platform/tenant, ngoài ngữ cảnh là fail-closed.
          db: drizzle({ client: pool, relations }),
        };
      },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
        // Chính sách job mặc định thống nhất toàn hệ (bản sao đúng
        // cùng bộ giá trị ở BullModule.forRoot của apps/api — hai app
        // dùng chung một Redis và cùng các hàng đợi): thử lại tối đa
        // 3 lần với giãn cách hàm mũ từ 1 giây; job đã xong/lỗi chỉ
        // giữ 1.000 bản gần nhất để Redis không tăng vô hạn (mặc định
        // của BullMQ là giữ vô hạn). Job lặp theo lịch do scheduler
        // đăng ký cũng chịu chính sách này; processor đều idempotent
        // nên thử lại an toàn.
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      }),
    }),
    BullModule.registerQueue({ name: 'file-cleanup' }),
    BullModule.registerQueue({ name: 'enrol-expiry' }),
    BullModule.registerQueue({ name: 'class-enrol-reconcile' }),
    BullModule.registerQueue({ name: 'activity-due-reminders' }),
    BullModule.registerQueue({ name: 'guardian-digests' }),
    BullModule.registerQueue({ name: 'completion-recalculate' }),
    BullModule.registerQueue({ name: 'notification-dispatch' }),
    BullModule.registerQueue({ name: 'notification-digests' }),
    BullModule.registerQueue({ name: 'notification-retention' }),
    BullModule.registerQueue({ name: 'calendar-reminders' }),
    BullModule.registerQueue({ name: 'calendar-import' }),
    BullModule.registerQueue({ name: 'badge-award' }),
    BullModule.registerQueue({ name: 'backup' }),
    BullModule.registerQueue({ name: 'restore' }),
    BullModule.registerQueue({ name: 'search-reindex' }),
    BullModule.registerQueue({ name: 'analytics-run' }),
    BullModule.registerQueue({ name: 'report-schedule' }),
    BullModule.registerQueue({ name: 'privacy' }),
    BullModule.registerQueue({ name: 'payment-reconciliation' }),
    // Hàng đợi phát sự kiện outbox của relay duy nhất: một đăng ký
    // cho mỗi hàng đợi có mặt trong bảng định tuyến phát job.
    ...outboxRouteQueueNames.map((name) => BullModule.registerQueue({ name })),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
  ],
  providers: [
    // Đường phát job của relay outbox duy nhất: bảng định tuyến và
    // bản đồ hàng đợi tra theo tên, cả hai suy ra từ
    // OUTBOX_EVENT_QUEUE_ROUTES để nơi đăng ký và nơi tiêu thụ dùng
    // chung một nguồn.
    { provide: OUTBOX_EVENT_ROUTES, useValue: OUTBOX_EVENT_QUEUE_ROUTES },
    {
      provide: OUTBOX_EVENT_QUEUES,
      inject: outboxRouteQueueNames.map((name) => getQueueToken(name)),
      useFactory: (...queues: Queue[]): OutboxEventQueues =>
        new Map(outboxRouteQueueNames.map((name, index) => [name, queues[index]!] as const)),
    },
    FileCleanupProcessor, OutboxRelayScheduler, EventLogWriter, TaskLogService, EnrolExpiryProcessor, ClassEnrolReconcileProcessor, ClassEnrolReconcileScheduler, ActivityDueReminderProcessor, ActivityDueReminderScheduler, GuardianDigestProcessor, GuardianDigestScheduler, GuardianDigestEventsProcessor, GuardianDigestHandlerService, CompletionRecalculateProcessor, EnrolExpiryScheduler, NotificationDispatchProcessor, ResendMailService, NotificationDigestProcessor, NotificationDigestScheduler, NotificationDeliveryService, NotificationRetentionProcessor, NotificationRetentionScheduler, CalendarReminderProcessor, CalendarImportProcessor, BadgeAwardProcessor, BackupProcessor, RestoreProcessor, SearchReindexProcessor, AnalyticsRunProcessor, ReportScheduleProcessor, PrivacyProcessor, PaymentReconciliationProcessor,
    // Consumer phân phối realtime messaging (issue #521): runtime
    // giữ tầng phân phối dùng chung + Redis dấu đã-phân-phối + cổng
    // phát qua Redis adapter; processor chỉ tiêu thụ job.
    MessagingRealtimeRuntime,
    {
      provide: MESSAGING_DISTRIBUTION_SERVICE,
      inject: [MessagingRealtimeRuntime],
      useFactory: (runtime: MessagingRealtimeRuntime) => runtime.distribution,
    },
    {
      provide: MESSAGING_DISTRIBUTED_REDIS,
      inject: [MessagingRealtimeRuntime],
      useFactory: (runtime: MessagingRealtimeRuntime) => runtime.redis,
    },
    MessagingRealtimeProcessor,
    // Consumer mail auth trên hàng đợi (issue #517): processor của
    // hàng đợi `auth-mail` (đăng ký hàng đợi tự suy ra từ bảng định
    // tuyến outbox ở trên) + dấu chiếm/đã xử lý theo outboxId trên
    // Redis làm hàng rào idempotent cho processor.
    AuthMailProcessor, { provide: AUTH_MAIL_SENT_MARKER, useClass: RedisAuthMailSentMarker },
    // Consumer thông báo sự kiện trên hàng đợi (issue con #520 của
    // #491): processor của hàng đợi `notification-events` (đăng ký
    // hàng đợi tự suy ra từ bảng định tuyến outbox ở trên) + handler
    // nghiệp vụ + dấu đã xử lý/lease theo outboxId trên Redis làm
    // hàng rào idempotent cho processor + dịch vụ phát bù tồn đọng
    // một lần theo watermark của consumer polling cũ khi chuyển
    // đổi (chỉ chạy khi còn khoá watermark cũ, tự xoá khoá khi rút
    // cạn xong).
    NotificationEventsProcessor, NotificationEventsHandlerService, NotificationEventsMarker, NotificationEventsCatchupService,
    // Consumer đồng bộ cohort trên hàng đợi (issue con #528 của
    // #519): processor của hàng đợi `cohort-sync-events` (đăng ký
    // hàng đợi tự suy ra từ bảng định tuyến outbox ở trên) + host
    // bề mặt vật chất hoá cohort dùng chung của issue con #527.
    // Processor không mang watermark riêng: idempotent hai tầng
    // (chống trùng job của relay + guard trạng thái của bề mặt).
    // Dịch vụ phát bù tồn đọng một lần theo watermark của consumer
    // polling cũ khi chuyển đổi (chỉ chạy khi còn khoá watermark
    // cũ, tự xoá khoá khi rút cạn xong; xem phân xử trên PR #550).
    CohortSyncService, CohortSyncEventsProcessor, CohortSyncCatchupService],})
export class WorkerModule {}
