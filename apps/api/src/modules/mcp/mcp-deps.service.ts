import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from '../../infra/events/outbox.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { QuestionsService } from '../questions/questions.service';
import { UsersService } from '../users/users.service';
import { McpBridgeAuth } from './mcp-bridge-auth';
import { McpIdempotencyRepository } from './mcp-idempotency.repository';
import type { McpMountDeps } from './mcp.mount';
import { McpRateLimiter } from './mcp-rate-limit';

/**
 * Facade dựng deps cho tầng mount MCP (issue #138, mục 8.1 của #134).
 *
 * Trước đây deps của mount được dựng trong mcp.mount.ts bằng cách lấy
 * provider nới phạm vi khỏi container — vòng qua hệ module, lấy thẳng
 * repository câu hỏi vốn không được QuestionsModule export và dựng
 * repository idempotency tay từ handle DB của repository đó.
 * Nay mọi dependency đều là service/repository ĐÃ ĐƯỢC module sở hữu
 * export và được Nest inject như mọi module khác: QuestionsService +
 * QuestionBanksService (facade của QuestionsModule), UsersService,
 * OutboxService, và McpIdempotencyRepository của chính McpModule
 * (inject Drizzle trực tiếp). Bootstrap chỉ còn `app.get(McpDepsService)`
 * như tiền lệ BetterAuthService.
 */
@Injectable()
export class McpDepsService {
  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly questions: QuestionsService,
    private readonly banks: QuestionBanksService,
    private readonly idempotency: McpIdempotencyRepository,
    private readonly outbox: OutboxService,
  ) {}

  /** Dựng deps của mount từ các provider đã inject (gọi trong main.ts sau NestFactory.create, như mountBetterAuth). */
  createMountDeps(): McpMountDeps {
    const readLimit = Number(this.config.get<string>('MCP_RATE_READ_PER_HOUR') ?? 300);
    const createLimit = Number(this.config.get<string>('MCP_RATE_CREATE_PER_HOUR') ?? 120);
    const publicBaseUrl = this.config.get<string>('MCP_PUBLIC_BASE_URL') ?? null;
    return {
      bridgeAuth: new McpBridgeAuth(this.config.getOrThrow<string>('JWT_SECRET'), this.users),
      rateLimiter: new McpRateLimiter({
        read: Number.isFinite(readLimit) && readLimit > 0 ? readLimit : 300,
        create: Number.isFinite(createLimit) && createLimit > 0 ? createLimit : 120,
      }),
      publicBaseUrl,
      issuer: this.config.get<string>('MCP_AUTH_ISSUER') ?? null,
      toolDeps: {
        questions: this.questions,
        banks: this.banks,
        idempotency: this.idempotency,
        outbox: this.outbox,
        publicBaseUrl: publicBaseUrl ?? '',
      },
    };
  }
}
