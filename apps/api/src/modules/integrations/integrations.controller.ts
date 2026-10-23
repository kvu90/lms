import { Body, Controller, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { clientIpOf } from '../../common/client-ip';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { callExternalFunctionSchema, createExternalServiceSchema, createExternalTokenSchema, setExternalServiceEnabledSchema, type CallFunctionDto, type CreateServiceDto, type CreateTokenDto, type SetEnabledDto } from './dto/integrations.dto';
import { IntegrationsService } from './integrations.service';

/** Controller quản trị external services/tokens và endpoint gọi function. */
@ApiTags('webservice')
@Controller({ path: 'webservice', version: '1' })
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}
  @Get('functions')
  async functions() { return this.integrations.listFunctions(); }
  @Post('services')
  async createService(@Body({ schema: createExternalServiceSchema }) dto: CreateServiceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.integrations.createService(actor.id, dto);
  }
  @Get('services')
  async listServices() { return this.integrations.listServices(); }
  @Patch('services/:id')
  async setEnabled(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setExternalServiceEnabledSchema }) body: SetEnabledDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.integrations.setServiceEnabled(actor.id, id, body.enabled);
  }
  @Post('tokens')
  async createToken(@Body({ schema: createExternalTokenSchema }) dto: CreateTokenDto, @CurrentUser() actor: AuthenticatedUser) {
    const { token, row } = await this.integrations.createToken(actor.id, dto);
    return { token, id: row.id, userId: row.userId, serviceId: row.serviceId, validUntil: row.validUntil };
  }
  @Get('tokens')
  async listTokens(@CurrentUser() actor: AuthenticatedUser) { return this.integrations.listTokens(actor.id); }
  @Post('tokens/:id/revoke')
  async revoke(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.integrations.revokeToken(actor.id, id);
  }
  /** Endpoint gọi function: xác thực bằng external token (không phải JWT). */
  @Public()
  @Post('call')
  async call(@Body({ schema: callExternalFunctionSchema }) dto: CallFunctionDto, @Req() req: Request) {
    // IP khách thật qua cơ chế chung (common/client-ip) để đối chiếu
    // allowlist của dịch vụ — không đọc tay X-Forwarded-For ở đây.
    const ip = clientIpOf(req) ?? '';
    const result = await this.integrations.callFunction({ token: dto.token, functionName: dto.functionName, args: dto.args, ip });
    return { result };
  }
}
