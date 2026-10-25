import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
import { BetterAuthModule } from '../auth/better-auth/better-auth.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { QuestionsModule } from '../questions/questions.module';
import { UsersModule } from '../users/users.module';
import { McpDepsService } from './mcp-deps.service';
import { McpIdempotencyRepository } from './mcp-idempotency.repository';

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
  imports: [QuestionsModule, UsersModule, EventsModule, BetterAuthModule, CurriculumModule],
  providers: [McpIdempotencyRepository, McpDepsService],
  exports: [McpDepsService],
})
export class McpModule {}
