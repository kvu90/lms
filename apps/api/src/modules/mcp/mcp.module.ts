import { Module } from '@nestjs/common';
import { McpIdempotencyRepository } from '@lms/db/repositories/mcp-idempotency';
import { SpaceRoutingModule } from '../../db/routing/space-routing.module';
import { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { EventsModule } from '../../infra/events/events.module';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { ExamsModule } from '../exams/exams.module';
import { QuestionsModule } from '../questions/questions.module';
import { QuizModule } from '../quiz/quiz.module';
import { TenantsModule } from '../tenants/tenants.module';
import { UsersModule } from '../users/users.module';
import { McpDepsService } from './mcp-deps.service';

/**
 * McpModule (issue #138, mục 8.1 của #134): MCP mount tay lên express ở
 * bootstrap (thứ tự mount là yêu cầu của tầng vận chuyển — xem
 * mcp.mount.ts), nhưng DEPENDENCY của nó đi đúng hệ module như mọi
 * module khác: chỉ import các module sở hữu và dùng đúng thứ chúng
 * export (QuestionsService/QuestionBanksService của QuestionsModule,
 * UsersService của UsersModule, OutboxService của EventsModule).
 * Repository của module khác KHÔNG bao giờ bị lấy thẳng; repository
 * riêng của MCP (idempotency) là provider của chính module này.
 * Export duy nhất là facade McpDepsService để bootstrap dựng mount deps.
 */
@Module({
  // BetterAuthModule (MCP-1): McpDepsService đọc trạng thái AS từ
  // BetterAuthService để dựng verifier RS. CurriculumModule (MCP-1):
  // tool tra YCCĐ dùng CurriculumService như REST vẫn dùng.
  // TenantsModule (TENANT-1, #196): McpDepsService dùng TenantsService
  // phân giải tenant mặc định của actor cho phiên MCP đường OAuth.
  // ExamsModule + QuizModule (issue #228): tool submit_contribution
  // mở đối xứng cho đề (ExamsService) và ma trận (MatrixBanksService)
  // — hai module này không import ngược McpModule nên không sinh
  // vòng phụ thuộc.
  imports: [QuestionsModule, UsersModule, EventsModule, BetterAuthModule, CurriculumModule, TenantsModule, ExamsModule, QuizModule, SpaceRoutingModule],
  providers: [
    // Repository của package @lms/db chạy trên handle Kysely đã định
    // tuyến theo không gian (issue #648).
    {
      provide: McpIdempotencyRepository,
      useFactory: (spaceDatabase: SpaceDatabaseService) => new McpIdempotencyRepository(spaceDatabase.routedKysely),
      inject: [SpaceDatabaseService],
    },
    McpDepsService,
  ],
  exports: [McpDepsService],
})
export class McpModule {}
