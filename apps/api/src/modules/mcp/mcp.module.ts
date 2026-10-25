import { Module } from '@nestjs/common';
import { EventsModule } from '../../infra/events/events.module';
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
  imports: [QuestionsModule, UsersModule, EventsModule],
  providers: [McpIdempotencyRepository, McpDepsService],
  exports: [McpDepsService],
})
export class McpModule {}
