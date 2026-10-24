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
import { EnrolExpiryScheduler } from './enrol-expiry.scheduler';
import { ActivityDueReminderScheduler } from './activity-due-reminder.scheduler';
import { EventLogWriter } from './event-log-writer.service';
import { OutboxRelayScheduler } from './outbox-relay.scheduler';
import { TaskLogService } from './task-log.service';
import { BadgeAwardProcessor } from './processors/badge-award.processor';
import { CalendarImportProcessor } from './processors/calendar-import.processor';
import { CalendarReminderProcessor } from './processors/calendar-reminder.processor';
import { CompletionRecalculateProcessor } from './processors/completion-recalculate.processor';
import { GradeRegradeProcessor } from './processors/grade-regrade.processor';
import { NotificationDispatchProcessor } from './processors/notification-dispatch.processor';
import { EnrolExpiryProcessor } from './processors/enrol-expiry.processor';
import { ActivityDueReminderProcessor } from './processors/activity-due-reminder.processor';
import { FileCleanupProcessor } from './processors/file-cleanup.processor';
import { SampleProcessor } from './processors/sample.processor';
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
      useFactory: (config: ConfigService) => ({
        drizzle,
        connection: databaseConnectionFromEnv(
          config.getOrThrow<string>('DATABASE_URL'),
          config.get<boolean>('DATABASE_SSL') ?? false,
        ),
        relations,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
      }),
    }),
    BullModule.registerQueue({ name: 'sample' }),
    BullModule.registerQueue({ name: 'file-cleanup' }),
    BullModule.registerQueue({ name: 'enrol-expiry' }),
    BullModule.registerQueue({ name: 'activity-due-reminders' }),
    BullModule.registerQueue({ name: 'completion-recalculate' }),
    BullModule.registerQueue({ name: 'grade-regrade' }),
    BullModule.registerQueue({ name: 'notification-dispatch' }),
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
  providers: [SampleProcessor, FileCleanupProcessor, OutboxRelayScheduler, EventLogWriter, TaskLogService, EnrolExpiryProcessor, ActivityDueReminderProcessor, ActivityDueReminderScheduler, CompletionRecalculateProcessor, GradeRegradeProcessor, EnrolExpiryScheduler, NotificationDispatchProcessor, CalendarReminderProcessor, CalendarImportProcessor, BadgeAwardProcessor, BackupProcessor, RestoreProcessor, SearchReindexProcessor, AnalyticsRunProcessor, ReportScheduleProcessor, PrivacyProcessor, PaymentReconciliationProcessor],
})
export class WorkerModule {}
