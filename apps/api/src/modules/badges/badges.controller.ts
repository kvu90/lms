import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { BadgesService } from './badges.service';
import { badgeUserSchema, createBadgeSchema, setBadgeCriteriaSchema, setBadgeStatusSchema, updateBadgeSchema, type CreateBadgeDto, type EvaluateDto, type ManualAwardDto, type SetCriteriaDto, type SetStatusDto, type UpdateBadgeDto } from './dto/badges.dto';

@ApiTags('badges')
@Controller({ path: 'badges', version: '1' })
/**
 * API huy hiệu: quản trị badge/tiêu chí, cấp phát, huy hiệu của tôi và thu hồi.
 */
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  @Post()
  /**
   * POST /badges — tạo badge.
   */
  async create(@Body({ schema: createBadgeSchema }) dto: CreateBadgeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.createBadge(actor.id, dto);
  }
  @Get()
  /**
   * GET /badges — liệt kê badge.
   */
  async list() { return this.badges.listBadges(); }
  @Get('mine')
  /**
   * GET /badges/mine — huy hiệu đã cấp cho tôi.
   */
  async mine(@CurrentUser() actor: AuthenticatedUser) {
    return this.badges.listMyBadges(actor.id);
  }
  @Get(':id')
  /**
   * GET /badges/:id — chi tiết badge.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string) { return this.badges.getBadge(id); }
  @Patch(':id')
  /**
   * PATCH /badges/:id — cập nhật badge.
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateBadgeSchema }) dto: UpdateBadgeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.updateBadge(actor.id, id, dto);
  }
  @Delete(':id')
  /**
   * POST /badges/:id/archive — lưu trữ badge.
   */
  async archive(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.archiveBadge(actor.id, id);
  }
  @Post(':id/status')
  /**
   * POST /badges/:id/status — đổi trạng thái (kích hoạt…).
   */
  async setStatus(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setBadgeStatusSchema }) dto: SetStatusDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.setStatus(actor.id, id, dto.status);
  }
  @Post(':id/duplicate')
  /**
   * POST /badges/:id/duplicate — nhân bản badge.
   */
  async duplicate(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.duplicateBadge(actor.id, id);
  }
  @Get(':id/criteria')
  /**
   * GET /badges/:id/criteria — bộ tiêu chí.
   */
  async criteria(@Param('id', { schema: uuidIdSchema }) id: string) { return this.badges.getCriteria(id); }
  @Put(':id/criteria')
  /**
   * PUT /badges/:id/criteria — đặt bộ tiêu chí.
   */
  async setCriteria(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: setBadgeCriteriaSchema }) dto: SetCriteriaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.setCriteria(actor.id, id, dto);
  }
  @Post(':id/award')
  /**
   * POST /badges/:id/award — cấp thủ công cho user.
   */
  async award(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: badgeUserSchema }) dto: ManualAwardDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.manualAward(actor.id, id, dto.userId);
  }
  @Get(':id/issued')
  /**
   * GET /badges/:id/issued — danh sách đã cấp.
   */
  async issued(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.listIssuedForBadge(actor.id, id);
  }
  @Post(':id/evaluate')
  /**
   * POST /badges/:id/evaluate — đánh giá tiêu chí cho một user.
   */
  async evaluate(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: badgeUserSchema }) dto: EvaluateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.evaluateBadgeFor(actor.id, id, dto.userId);
  }
  @Post('evaluate-user')
  /**
   * POST /badges/evaluate-user — đánh giá mọi badge cho user.
   */
  async evaluateUser(@Body({ schema: badgeUserSchema }) dto: EvaluateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.evaluateUserBadgesFor(actor.id, dto.userId);
  }
  @Get('issued/:issuedId')
  /**
   * GET /badges/issued/:id — một bản ghi cấp phát.
   */
  async getIssued(@Param('issuedId', { schema: uuidIdSchema }) issuedId: string) {
    return this.badges.getIssued(issuedId);
  }
  @Post('issued/:issuedId/revoke')
  /**
   * POST /badges/issued/:id/revoke — thu hồi huy hiệu đã cấp.
   */
  async revoke(@Param('issuedId', { schema: uuidIdSchema }) issuedId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.revokeIssued(actor.id, issuedId);
  }
}
