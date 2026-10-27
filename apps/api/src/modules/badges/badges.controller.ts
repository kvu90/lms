import { Body, Controller, Delete, Get, Param, Patch, Post, Put, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { DeprecatedRouteAliasInterceptor } from '../../common/deprecated-route-alias.interceptor';
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
  @Post(':id/copy')
  /**
   * POST /badges/:id/copy — nhân bản badge. Động từ chuẩn là `copy`
   * theo danh sách hành động đóng (issue #345); path cũ
   * `:id/duplicate` giữ qua handler alias ngay dưới.
   */
  async copy(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.badges.duplicateBadge(actor.id, id);
  }
  @Post(':id/duplicate')
  @UseInterceptors(DeprecatedRouteAliasInterceptor)
  /**
   * POST /badges/:id/duplicate — alias cũ của POST /badges/:id/copy:
   * uỷ quyền nguyên vẹn cho handler canonical; response mang header
   * Deprecation/Sunset và lượt gọi được ghi log alias có cấu trúc
   * (căn cứ điều kiện gỡ alias: 0 lượt gọi trong 14 ngày).
   */
  async duplicate(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.copy(id, actor);
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
