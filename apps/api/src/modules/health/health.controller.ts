import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HealthStatus } from '@lms/contracts';
import { HealthService } from './health.service';
import { Public } from '../../common/public.decorator';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
/**
 * API kiểm tra sức khoẻ (không cần xác thực).
 */
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  @ApiOkResponse({ description: 'Service health (database + redis checks)' })
  /**
   * GET /health — trạng thái API, DB và Redis.
   */
  async getHealth(): Promise<HealthStatus> {
    return this.health.check();
  }
}
