import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DrizzleModule } from '@nestjs/drizzle';
import { ScheduleModule } from '@nestjs/schedule';
import { drizzle } from 'drizzle-orm/node-postgres';
import { redisConnectionFromUrl, validateEnv } from './config/env';
import { relations } from './db/relations';
import { CacheInfraModule } from './infra/cache/cache-infra.module';
import { EventsModule } from './infra/events/events.module';
import { TasksModule } from './infra/tasks/tasks.module';
import { AccessModule } from './modules/access/access.module';
import { AuthModule } from './modules/auth/auth.module';
import { AvailabilityModule } from './modules/availability/availability.module';
import { BadgesModule } from './modules/badges/badges.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { CompetenciesModule } from './modules/competencies/competencies.module';
import { CompletionModule } from './modules/completion/completion.module';
import { CoursesModule } from './modules/courses/courses.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { EnrolModule } from './modules/enrol/enrol.module';
import { GradesModule } from './modules/grades/grades.module';
import { GroupsModule } from './modules/groups/groups.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { SocialModule } from './modules/social/social.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.module';
import { SeedModule } from './modules/seed/seed.module';
import { UsersModule } from './modules/users/users.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { BackupModule } from './modules/backup/backup.module';
import { ContentBankModule } from './modules/content-bank/content-bank.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SearchModule } from './modules/search/search.module';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { I18nStandardSchemaValidationPipe } from '@nestjs/i18n';
import { I18nFoundationModule } from './i18n/i18n.config';
import { CapabilityGuard } from './common/capability.guard';
import { JwtAuthGuard } from './common/jwt-auth.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    I18nFoundationModule,
    DrizzleModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        drizzle,
        connection: config.getOrThrow<string>('DATABASE_URL'),
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
    ScheduleModule.forRoot(),
    CacheInfraModule,
    EventsModule,
    TasksModule,
    HealthModule,
    AccessModule,
    CustomFieldsModule,
    UsersModule,
    AuthModule,
    FilesModule,
    AvailabilityModule,
    CoursesModule,
    GroupsModule,
    EnrolModule,
    CompletionModule,
    GradesModule,
    QuestionsModule,
    MessagingModule,
    CalendarModule,
    CompetenciesModule,
    BadgesModule,
    SocialModule,
    SearchModule,
    IntegrationsModule,
    PaymentsModule,
    BackupModule,
    AnalyticsModule,
    ReportsModule,
    ContentBankModule,
    PrivacyModule,
    SeedModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    /**
     * Pipe validation Standard Schema có dịch thông điệp theo catalog i18n
     * (chương Validation của docs Nest + trang i18n chính thức): thay cho
     * `StandardSchemaValidationPipe` thuần; KHÔNG dùng `I18nValidationPipe`
     * (đường class-validator) vì dự án validate 100% bằng Zod.
     */
    { provide: APP_PIPE, useValue: new I18nStandardSchemaValidationPipe() },
  ],
})
export class AppModule {}
