import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { Public } from '../../common/public.decorator';
import { CallFunctionDto, CreateServiceDto, CreateTokenDto } from './dto/integrations.dto';
import { IntegrationsService } from './integrations.service';

/** Controller quản trị external services/tokens và endpoint gọi function. */
@ApiTags('webservice')
@Controller({ path: 'webservice', version: '1' })
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}
  @Get('functions')
  async functions() { return this.integrations.listFunctions(); }
  @Post('services')
  async createService(@Body() dto: CreateServiceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.integrations.createService(actor.id, dto);
  }
  @Get('services')
  async listServices() { return this.integrations.listServices(); }
  @Patch('services/:id')
  async setEnabled(@Param('id', ParseIntPipe) id: number, @Body() body: { enabled: boolean }, @CurrentUser() actor: AuthenticatedUser) {
    return this.integrations.setServiceEnabled(actor.id, id, body.enabled);
  }
  @Post('tokens')
  async createToken(@Body() dto: CreateTokenDto, @CurrentUser() actor: AuthenticatedUser) {
    const { token, row } = await this.integrations.createToken(actor.id, dto);
    return { token, id: row.id, userid: row.userid, serviceid: row.serviceid, validuntil: row.validuntil };
  }
  @Get('tokens')
  async listTokens(@CurrentUser() actor: AuthenticatedUser) { return this.integrations.listTokens(actor.id); }
  @Post('tokens/:id/revoke')
  async revoke(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.integrations.revokeToken(actor.id, id);
  }
  /** Endpoint gọi function: xác thực bằng external token (không phải JWT). */
  @Public()
  @Post('call')
  async call(@Body() dto: CallFunctionDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string) ?? req.ip ?? '';
    const result = await this.integrations.callFunction({ token: dto.token, functionName: dto.functionName, args: dto.args, ip: String(ip).split(',')[0]!.trim() });
    return { result };
  }
}
