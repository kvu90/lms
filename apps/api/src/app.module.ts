import { BullModule } from '@nestjs/bullmq';
import { Module, type ExecutionContext, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DrizzleModule } from '@nestjs/drizzle';
import { ScheduleModule } from '@nestjs/schedule';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseConnectionFromEnv, redisConnectionFromUrl, validateEnv } from './config/env';
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
import { QuizModule } from './modules/quiz/quiz.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
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
import { EventLogModule } from './modules/event-log/event-log.module';
import { SearchModule } from './modules/search/search.module';
import { SiteConfigModule } from './modules/site-config/site-config.module';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { I18nStandardSchemaValidationPipe } from '@nestjs/i18n';
import { I18nFoundationModule } from './i18n/i18n.config';
import { BetterAuthSessionGuard } from './common/better-auth-session.guard';
import { CapabilityGuard } from './common/capability.guard';
import { JwtAuthGuard } from './common/jwt-auth.guard';
import { BetterAuthModule } from './modules/auth/better-auth/better-auth.module';
import { SecurityHeadersMiddleware } from './common/security-headers.middleware';

/**
 * Các route xác thực có kiểm chứng mật khẩu — nhận hạn mức chặt riêng
 * (`auth`) trong ThrottlerModule bên dưới.
 */
const CREDENTIAL_ROUTES = /^\/api\/v\d+\/auth\/(token|login|session\/login|change-password)$/;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    I18nFoundationModule,
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
    ScheduleModule.forRoot(),
    /**
     * Giới hạn tốc độ hai lớp theo IP (gói chính thức @nestjs/throttler):
     * hạn mức chung cho mọi route và hạn mức chặt chỉ áp cho các route
     * xác thực có kiểm chứng mật khẩu. Lưu trữ mặc định trong bộ nhớ của
     * tiến trình — đủ cho mô hình modular monolith một instance; khi
     * scale nhiều instance API phải chuyển sang storage dùng chung
     * (xem runbook vận hành).
     */
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          { name: 'default', ttl: 60_000, limit: config.get<number>('RATE_LIMIT_PER_MINUTE') ?? 3000 },
          {
            name: 'auth',
            ttl: 60_000,
            limit: config.get<number>('RATE_LIMIT_AUTH_PER_MINUTE') ?? 300,
            skipIf: (context: ExecutionContext) => {
              const req = context.switchToHttp().getRequest<{ method?: string; path?: string; url?: string }>();
              const path = req.path ?? req.url ?? '';
              return !(req.method === 'POST' && CREDENTIAL_ROUTES.test(path));
            },
          },
        ],
      }),
    }),
    CacheInfraModule,
    EventsModule,
    TasksModule,
    HealthModule,
    AccessModule,
    CustomFieldsModule,
    UsersModule,
    AuthModule,
    BetterAuthModule,
    FilesModule,
    AvailabilityModule,
    CoursesModule,
    GroupsModule,
    EnrolModule,
    CompletionModule,
    GradesModule,
    QuestionsModule,
    QuizModule,
    CurriculumModule,
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
    EventLogModule,
    ContentBankModule,
    PrivacyModule,
    SiteConfigModule,
    SeedModule,
  ],
  providers: [
    // ThrottlerGuard chạy đầu tiên: từ chối sớm request vượt hạn mức
    // trước mọi guard tốn kém hơn (xác thực JWT, đánh giá capability).
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Guard mỏng của Better Auth chạy ngay trước JwtAuthGuard: chỉ dịch
    // cookie phiên Better Auth (khi cờ bật và cookie có mặt) thành danh
    // tính cho JwtAuthGuard bỏ qua; mọi request còn lại nó không chạm.
    { provide: APP_GUARD, useClass: BetterAuthSessionGuard },
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
export class AppModule implements NestModule {
  /** Header bảo mật cho mọi phản hồi HTTP (xem SecurityHeadersMiddleware). */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SecurityHeadersMiddleware).forRoutes('*');
  }
}
