import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CreatePrivacyRequestDto, DecidePrivacyRequestDto } from './dto/privacy.dto';
import { PrivacyService } from './privacy.service';

/** Controller Privacy: providers registry, requests, phê duyệt, export files. */
@ApiTags('privacy')
@Controller({ path: 'privacy', version: '1' })
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}
  @Get('providers')
  async providers() { return this.privacy.listProviders(); }
  @Get('completeness')
  async completeness() { return { missing: this.privacy.missingProviders(), complete: this.privacy.missingProviders().length === 0 }; }
  @Post('requests')
  async create(@Body() dto: CreatePrivacyRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.privacy.createRequest(actor.id, dto);
  }
  @Get('requests')
  async list(@CurrentUser() actor: AuthenticatedUser) { return this.privacy.listRequestsFor(actor.id); }
  @Get('requests/:id')
  async get(@Param('id', ParseIntPipe) id: number) { return this.privacy.getRequest(id); }
  @Get('requests/:id/files')
  async files(@Param('id', ParseIntPipe) id: number) { return this.privacy.listExportFiles(id); }
  @Post('requests/:id/decide')
  async decide(@Param('id', ParseIntPipe) id: number, @Body() dto: DecidePrivacyRequestDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.privacy.decide(actor.id, id, dto.decision);
  }
  @Post('requests/:id/process')
  async process(@Param('id', ParseIntPipe) id: number) { return this.privacy.processRequest(id); }
}
