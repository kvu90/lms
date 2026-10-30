import { BullModule } from '@nestjs/bullmq';
import { Module, type ExecutionContext, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DrizzleModule } from '@nestjs/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';
import { databaseConnectionFromEnv, redisConnectionFromUrl, validateEnv } from './config/env';
import { relations } from './db/relations';
import { SpaceDatabaseService } from './db/routing/space-database.service';
import { SpaceRoutingModule } from './db/routing/space-routing.module';
import { TenantAwarePool } from './db/tenant-pool';
import { CacheInfraModule } from './infra/cache/cache-infra.module';
import { EventsModule } from './infra/events/events.module';
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
import { GuardiansModule } from './modules/guardians/guardians.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { GroupsModule } from './modules/groups/groups.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { McpModule } from './modules/mcp/mcp.module';
import { ExamsModule } from './modules/exams/exams.module';
import { QuizModule } from './modules/quiz/quiz.module';
import { PaperGradingModule } from './modules/paper-grading/paper-grading.module';
import { AssignmentsModule } from './modules/assignments/assignments.module';
import { ContentModule } from './modules/content/content.module';
import { CurriculumModule } from './modules/curriculum/curriculum.module';
import { BooksModule } from './modules/books/books.module';
import { SocialModule } from './modules/social/social.module';
import { FilesModule } from './modules/files/files.module';
import { HealthModule } from './modules/health/health.module';
import { SeedModule } from './modules/seed/seed.module';
import { UsersModule } from './modules/users/users.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { BackupModule } from './modules/backup/backup.module';
import { ContentBankModule } from './modules/content-bank/content-bank.module';
import { ControlPlaneModule } from './modules/control-plane/control-plane.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PrivacyModule } from './modules/privacy/privacy.module';
import { ReportsModule } from './modules/reports/reports.module';
import { EventLogModule } from './modules/event-log/event-log.module';
import { SearchModule } from './modules/search/search.module';
import { SiteConfigModule } from './modules/site-config/site-config.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ClassesModule } from './modules/classes/classes.module';
import { TenantGuard } from './modules/tenants/tenant.guard';
import { TenantContextInterceptor } from './modules/tenants/tenant-context.interceptor';
import { APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
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
      imports: [ConfigModule, SpaceRoutingModule],
      inject: [ConfigService, SpaceDatabaseService],
      useFactory: (config: ConfigService, spaceDatabase: SpaceDatabaseService) => {
        const connection = databaseConnectionFromEnv(
          config.getOrThrow<string>('DATABASE_URL'),
          config.get<boolean>('DATABASE_SSL') ?? false,
        );
        const poolConfig = typeof connection === 'string' ? { connectionString: connection } : connection;
        // Ngân sách kết nối (issue #586): trần `DATABASE_POOL_MAX`
        // khi được cấu hình; chưa cấu hình thì giữ nguyên cấu hình
        // pool như trước.
        const poolMax = config.get<number>('DATABASE_POOL_MAX');
        const pool = new TenantAwarePool(poolMax ? { ...poolConfig, max: poolMax } : poolConfig);
        const sharedDb = drizzle({ client: pool, relations });
        // Khung định tuyến theo trung tâm (issue #581): handle kho
        // chung vừa dựng được gắn vào khung làm đích mặc định, và
        // handle mà mọi điểm inject nhận là handle ĐỊNH TUYẾN của
        // khung — uỷ thác về kho chung cho mọi ngữ cảnh chưa mang
        // trung tâm ở kho riêng (toàn bộ đường hiện hành), và về
        // kho của trung tâm khi ngữ cảnh đã được chuẩn bị theo
        // trung tâm đó. Các điểm inject vì vậy không đổi cách gọi.
        spaceDatabase.bindSharedDatabase(sharedDb);
        return {
          // TENANT-1 (#196): pool tự dựng có gắn GUC tenant theo ngữ
          // cảnh ALS ở mọi checkout. Kiểu options của @nestjs/drizzle
          // chỉ mô hình hoá biến thể `connection` (driver tự tạo pool
          // thường — sai ý đồ), nên dùng biến thể `db`: tự gọi
          // drizzle() với chính pool này, hành vi tương đương đường
          // `client` mà runtime của module vốn chuyển thẳng vào
          // drizzle(config).
          db: spaceDatabase.routedDatabase,
        };
      },
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: redisConnectionFromUrl(config.getOrThrow<string>('REDIS_URL')),
        // Chính sách job mặc định thống nhất toàn hệ (bản sao đúng
        // cùng bộ giá trị ở BullModule.forRoot của apps/worker — hai
        // app dùng chung một Redis và cùng các hàng đợi): thử lại tối
        // đa 3 lần với giãn cách hàm mũ từ 1 giây thay vì dội lại tức
        // thì khi dịch vụ ngoài/cơ sở dữ liệu lỗi tạm thời; job đã
        // xong/lỗi chỉ giữ 1.000 bản gần nhất để Redis không tăng vô
        // hạn (mặc định của BullMQ là giữ vô hạn). Producer vẫn khai
        // riêng jobId dedupe và có thể ghi đè từng tuỳ chọn khi cần.
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      }),
    }),
    /**
     * Giới hạn tốc độ hai lớp theo IP (gói chính thức @nestjs/throttler):
     * hạn mức chung cho mọi route và hạn mức chặt chỉ áp cho các route
     * xác thực có kiểm chứng mật khẩu. Lưu trữ mặc định trong bộ nhớ của
     * tiến trình — đủ cho mô hình modular monolith một instance; khi
     * scale nhiều instance API phải chuyển sang storage dùng chung.
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
    GuardiansModule,
    DashboardModule,
    QuestionsModule,
    McpModule,
    ExamsModule,
    QuizModule,
    PaperGradingModule,
    AssignmentsModule,
    ContentModule,
    CurriculumModule,
    BooksModule,
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
    ControlPlaneModule,
    SpaceRoutingModule,
    PrivacyModule,
    SiteConfigModule,
    TenantsModule,
    ClassesModule,
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
    // TenantGuard chạy ngay sau xác thực: phân giải tenant hiệu lực từ
    // claim `tid` (kiểm chứng với DB) và nạp ngữ cảnh tenant (ALS) cho
    // mọi bề mặt đã phủ tenant (TENANT-0, #168).
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: CapabilityGuard },
    // Interceptor bọc ALS tenant quanh handler (guard chỉ ghim tenant
    // lên request — enterWith không qua được biên guard→handler).
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
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
