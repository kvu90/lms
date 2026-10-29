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
import { EventLogWriter } from './event-log-writer.service';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import {
  OUTBOX_EVENT_QUEUE_ROUTES,
  OUTBOX_EVENT_QUEUES,
  OUTBOX_EVENT_ROUTES,
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
 * đóng góp hàng đợi của nó một lần. Đăng ký hàng đợi và bản đồ hàng
 * đợi cấp cho relay đều suy ra từ danh sách này nên hai nơi không
 * thể lệch nhau khi bảng định tuyến được mở rộng.
 */
const outboxRouteQueueNames: string[] = [
  ...new Set(Object.values(OUTBOX_EVENT_QUEUE_ROUTES)),
];

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
    FileCleanupProcessor, OutboxRelayScheduler, EventLogWriter, TaskLogService, EnrolExpiryProcessor, ClassEnrolReconcileProcessor, ClassEnrolReconcileScheduler, ActivityDueReminderProcessor, ActivityDueReminderScheduler, GuardianDigestProcessor, GuardianDigestScheduler, CompletionRecalculateProcessor, EnrolExpiryScheduler, NotificationDispatchProcessor, ResendMailService, NotificationDigestProcessor, NotificationDigestScheduler, NotificationDeliveryService, NotificationRetentionProcessor, NotificationRetentionScheduler, CalendarReminderProcessor, CalendarImportProcessor, BadgeAwardProcessor, BackupProcessor, RestoreProcessor, SearchReindexProcessor, AnalyticsRunProcessor, ReportScheduleProcessor, PrivacyProcessor, PaymentReconciliationProcessor,
    // Consumer mail auth trên hàng đợi (issue #517): processor của
    // hàng đợi `auth-mail` (đăng ký hàng đợi tự suy ra từ bảng định
    // tuyến outbox ở trên) + dấu đã xử lý theo outboxId trên Redis
    // làm hàng rào idempotent cho processor.
    AuthMailProcessor, { provide: AUTH_MAIL_SENT_MARKER, useClass: RedisAuthMailSentMarker }],})
export class WorkerModule {}
