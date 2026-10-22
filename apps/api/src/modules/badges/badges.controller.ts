import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BadgesService } from './badges.service';
import { CreateBadgeDto, EvaluateDto, ManualAwardDto, SetCriteriaDto, SetStatusDto, UpdateBadgeDto } from './dto/badges.dto';

@ApiTags('badges')
@Controller({ path: 'badges', version: '1' })
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Post()
  async create(@Body() dto: CreateBadgeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.createBadge(actor.id, dto);
  }
  @Get()
  async list() { return this.badges.listBadges(); }
  @Get('mine')
  async mine(@CurrentUser() actor: AuthenticatedUser) {
    return this.badges.listMyBadges(actor.id);
  }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) { return this.badges.getBadge(id); }
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateBadgeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.updateBadge(actor.id, id, dto);
  }
  @Delete(':id')
  async archive(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.archiveBadge(actor.id, id);
  }
  @Post(':id/status')
  async setStatus(@Param('id', ParseIntPipe) id: number, @Body() dto: SetStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.setStatus(actor.id, id, dto.status);
  }
  @Post(':id/duplicate')
  async duplicate(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.duplicateBadge(actor.id, id);
  }
  @Get(':id/criteria')
  async criteria(@Param('id', ParseIntPipe) id: number) { return this.badges.getCriteria(id); }
  @Put(':id/criteria')
  async setCriteria(@Param('id', ParseIntPipe) id: number, @Body() dto: SetCriteriaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.setCriteria(actor.id, id, dto);
  }
  @Post(':id/award')
  async award(@Param('id', ParseIntPipe) id: number, @Body() dto: ManualAwardDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.manualAward(actor.id, id, dto.userId);
  }
  @Get(':id/issued')
  async issued(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.listIssuedForBadge(actor.id, id);
  }
  @Post(':id/evaluate')
  async evaluate(@Param('id', ParseIntPipe) id: number, @Body() dto: EvaluateDto) {
    return this.badges.evaluateBadge(id, dto.userId);
  }
  @Post('evaluate-user')
  async evaluateUser(@Body() dto: EvaluateDto, @CurrentUser() actor: AuthenticatedUser) {
    void actor;
    return this.badges.evaluateUserBadges(dto.userId);
  }
  @Get('issued/:issuedId')
  async getIssued(@Param('issuedId', ParseIntPipe) issuedId: number) {
    return this.badges.getIssued(issuedId);
  }
  @Post('issued/:issuedId/revoke')
  async revoke(@Param('issuedId', ParseIntPipe) issuedId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.revokeIssued(actor.id, issuedId);
  }
}
