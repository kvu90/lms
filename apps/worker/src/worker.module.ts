import { BullModule } from '@nestjs/bullmq';
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
  AnalyticsRunProcessor, BackupProcessor, PaymentReconciliationProcessor, PrivacyProcessor,
  ReportScheduleProcessor, RestoreProcessor, SearchReindexProcessor,
} from './processors/platform-services.processors';

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
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
  ],
  providers: [FileCleanupProcessor, OutboxRelayScheduler, EventLogWriter, TaskLogService, EnrolExpiryProcessor, ClassEnrolReconcileProcessor, ClassEnrolReconcileScheduler, ActivityDueReminderProcessor, ActivityDueReminderScheduler, GuardianDigestProcessor, GuardianDigestScheduler, CompletionRecalculateProcessor, EnrolExpiryScheduler, NotificationDispatchProcessor, ResendMailService, NotificationDigestProcessor, NotificationDigestScheduler, NotificationDeliveryService, NotificationRetentionProcessor, NotificationRetentionScheduler, CalendarReminderProcessor, CalendarImportProcessor, BadgeAwardProcessor, BackupProcessor, RestoreProcessor, SearchReindexProcessor, AnalyticsRunProcessor, ReportScheduleProcessor, PrivacyProcessor, PaymentReconciliationProcessor],})
export class WorkerModule {}
