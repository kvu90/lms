import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OutboxService } from '../../infra/events/outbox.service';
import { BETTER_AUTH_BASE_PATH } from '../auth/better-auth/better-auth.instance';
import { BetterAuthService } from '../auth/better-auth/better-auth.service';
import { CurriculumService } from '../curriculum/curriculum.service';
import { QuestionBanksService } from '../questions/question-banks.service';
import { TenantsService } from '../tenants/tenants.service';
import { QuestionsService } from '../questions/questions.service';
import { UsersService } from '../users/users.service';
import { McpBridgeAuth } from './mcp-bridge-auth';
import { McpIdempotencyRepository } from './mcp-idempotency.repository';
import type { McpMountDeps } from './mcp.mount';
import { McpOAuthVerifier } from './mcp-oauth-verifier';
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
 *
 * Lát MCP-1 (issue #163) thêm đường RS OAuth: khi BetterAuthService báo
 * AS đã bật (`mcpAsEnabled`), facade dựng McpOAuthVerifier trỏ đúng
 * issuer/JWKS của instance BA vừa compose + hàm resolveActor kiểm tra
 * tài khoản còn hoạt động; PRM khi đó quảng bá issuer của AS. AS tắt
 * thì deps giữ nguyên hình MCP-0 (cầu bridge là đường auth duy nhất).
 */
@Injectable()
export class McpDepsService {
  constructor(
    private readonly config: ConfigService,
    private readonly users: UsersService,
    private readonly questions: QuestionsService,
    private readonly banks: QuestionBanksService,
    private readonly curriculum: CurriculumService,
    private readonly idempotency: McpIdempotencyRepository,
    private readonly outbox: OutboxService,
    private readonly betterAuth: BetterAuthService,
    private readonly tenants: TenantsService,
  ) {}

  /** Dựng deps của mount từ các provider đã inject (gọi trong main.ts sau NestFactory.create, như mountBetterAuth). */
  createMountDeps(): McpMountDeps {
    const readLimit = Number(this.config.get<string>('MCP_RATE_READ_PER_HOUR') ?? 300);
    const createLimit = Number(this.config.get<string>('MCP_RATE_CREATE_PER_HOUR') ?? 120);
    const publishLimit = Number(this.config.get<string>('MCP_RATE_PUBLISH_PER_HOUR') ?? 10);
    const port = this.config.get<number>('PORT') ?? 3000;
    // Origin công khai theo đúng thứ tự ưu tiên mà BetterAuthService
    // dùng để chốt `resource` của AS — hai nơi PHẢI ra cùng một gốc,
    // nếu không `aud` của token và audience RS kỳ vọng sẽ lệch nhau.
    const publicBaseUrl =
      this.config.get<string>('MCP_PUBLIC_BASE_URL') ??
      this.config.get<string>('BETTER_AUTH_URL') ??
      null;

    const asEnabled = this.betterAuth.mcpAsEnabled && this.betterAuth.mcpAs !== null;
    if (asEnabled) {
      const origin = (publicBaseUrl ?? `http://localhost:${port}`).replace(/\/+$/, '');
      const issuer = `${origin}${BETTER_AUTH_BASE_PATH}`;
      return {
        bridgeAuth: new McpBridgeAuth(this.config.getOrThrow<string>('JWT_SECRET'), this.users),
        rateLimiter: new McpRateLimiter({
          read: Number.isFinite(readLimit) && readLimit > 0 ? readLimit : 300,
          create: Number.isFinite(createLimit) && createLimit > 0 ? createLimit : 120,
          publish: Number.isFinite(publishLimit) && publishLimit > 0 ? publishLimit : 10,
        }),
        publicBaseUrl: origin,
        issuer,
        oauthVerifier: new McpOAuthVerifier({
          issuer,
          audience: this.betterAuth.mcpAs!.resource,
          jwksUrl: `${issuer}/jwks`,
        }),
        resolveActor: async (userId: string) => {
          const user = await this.users.getByIdOrUndefined(userId);
          if (!user || user.deleted || user.suspended) return null;
          // TENANT-1 (#196): tenant của phiên OAuth = tenant mặc định
          // của user theo membership (khi token AS không mang `tid`).
          const tenant = await this.tenants.resolveDefaultTenant(userId).catch(() => null);
          return { username: user.username, tenantId: tenant?.id ?? null };
        },
        toolDeps: {
          questions: this.questions,
          banks: this.banks,
          curriculum: this.curriculum,
          idempotency: this.idempotency,
          outbox: this.outbox,
          publicBaseUrl: origin,
        },
      };
    }

    return {
      bridgeAuth: new McpBridgeAuth(this.config.getOrThrow<string>('JWT_SECRET'), this.users),
      rateLimiter: new McpRateLimiter({
        read: Number.isFinite(readLimit) && readLimit > 0 ? readLimit : 300,
        create: Number.isFinite(createLimit) && createLimit > 0 ? createLimit : 120,
        publish: Number.isFinite(publishLimit) && publishLimit > 0 ? publishLimit : 10,
      }),
      publicBaseUrl,
      issuer: this.config.get<string>('MCP_AUTH_ISSUER') ?? null,
      toolDeps: {
        questions: this.questions,
        banks: this.banks,
        curriculum: this.curriculum,
        idempotency: this.idempotency,
        outbox: this.outbox,
        publicBaseUrl: publicBaseUrl ?? '',
      },
    };
  }
}
