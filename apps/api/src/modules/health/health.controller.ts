import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { HealthStatus } from '@lms/contracts';
import { HealthService } from './health.service';
import { Public } from '../../common/public.decorator';

@ApiTags('health')
@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Public()
  @Get()
  @ApiOkResponse({ description: 'Service health (database + redis checks)' })
  async getHealth(): Promise<HealthStatus> {
    return this.health.check();
  }
}
