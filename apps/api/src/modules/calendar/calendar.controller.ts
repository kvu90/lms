import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { DeprecatedRouteAliasInterceptor } from '../../common/deprecated-route-alias.interceptor';
import { Public } from '../../common/public.decorator';
import { CalendarService } from './calendar.service';
import { calendarRemindSchema, createCalendarEventSchema, createCalendarExceptionSchema, createCalendarSubscriptionSchema, type CreateEventDto, type CreateExceptionDto, type CreateSubscriptionDto, type RemindDto } from './dto/calendar.dto';

@ApiTags('calendar')
@Controller({ path: 'calendar', version: '1' })
/**
 * API lịch: sự kiện, exception, nhắc, subscription và xuất lịch (tải .ics
 * khi đã đăng nhập, URL xuất bằng token bí mật khi chưa đăng nhập).
 */
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  /** Gửi nội dung .ics dưới dạng file tải về (text/calendar + attachment). */
  private sendIcs(res: Response, ics: string): void {
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="calendar.ics"');
    res.send(ics);
  }

  @Post('events')
  /**
   * POST /calendar/events — tạo sự kiện.
   */
  async create(@Body({ schema: createCalendarEventSchema }) dto: CreateEventDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createEvent(actor.id, dto);
  }
  @Get('events')
  /**
   * GET /calendar/events — sự kiện của tôi trong khoảng thời gian.
   */
  async list(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
    @Query('eventType') eventType: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.listEventsForUser(actor.id, { from, to, eventType });
  }
  @Get('exports')
  /**
   * GET /calendar/exports — tải file xuất lịch chứa đúng các sự kiện tôi
   * được thấy trong khoảng from/to (tuỳ chọn eventType), cùng luật hiển
   * thị với GET /calendar/events. Định dạng là dữ liệu yêu cầu qua
   * tham số truy vấn `format` (hiện chỉ hỗ trợ `ics`; vắng mặt thì mặc
   * định `ics`), không còn nằm trong path theo chuẩn bỏ hậu tố file
   * (issue #345); path cũ `export.ics` giữ qua handler alias ngay dưới.
   * Định dạng khác `ics` bị từ chối 400 `calendar.export_format_unsupported`.
   */
  async exportMine(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
    @Query('eventType') eventType: string | undefined, @Query('format') format: string | undefined,
    @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    if (format !== undefined && format !== 'ics') {
      throw new BadRequestException({ message: `Unsupported calendar export format: ${format}`, code: 'calendar.export_format_unsupported' });
    }
    this.sendIcs(res, await this.calendar.exportIcsForUser(actor.id, { from, to, eventType }));
  }
  @Get('export.ics')
  @UseInterceptors(DeprecatedRouteAliasInterceptor)
  /**
   * GET /calendar/export.ics — alias cũ của GET /calendar/exports
   * (định dạng `ics` cố định bởi chính hậu tố path): uỷ quyền nguyên
   * vẹn cho handler canonical; response mang header Deprecation/Sunset
   * và lượt gọi được ghi log alias có cấu trúc (căn cứ điều kiện gỡ
   * alias: 0 lượt gọi trong 14 ngày).
   */
  async exportMineAlias(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
    @Query('eventType') eventType: string | undefined, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    return this.exportMine(from, to, eventType, 'ics', actor, res);
  }
  @Post('export-token')
  /**
   * POST /calendar/export-token — tạo hoặc đổi token xuất lịch của tôi;
   * token thô chỉ trả về trong lần gọi này, các URL xuất cũ chết ngay.
   */
  async createExportToken(@CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createOrRotateExportToken(actor.id);
  }
  @Get('export-token')
  /**
   * GET /calendar/export-token — trạng thái token xuất lịch của tôi (không
   * bao giờ chứa token thô hay hash).
   */
  async exportTokenStatus(@CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.getExportTokenStatus(actor.id);
  }
  @Delete('export-token')
  /**
   * DELETE /calendar/export-token — thu hồi token xuất lịch của tôi; URL
   * xuất hiện tại chết ngay.
   */
  async revokeExportToken(@CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.revokeExportToken(actor.id);
  }
  /** URL xuất công khai: việc sở hữu token bí mật chính là credential — không cần JWT. */
  @Public()
  @Get('export/:filename')
  /**
   * GET /calendar/export/:token.ics — tải .ics của chủ token mà không cần
   * đăng nhập; token sai/đã đổi/đã thu hồi trả 401.
   */
  async exportByToken(@Param('filename') fileName: string, @Query('from') from: string | undefined,
    @Query('to') to: string | undefined, @Query('eventType') eventType: string | undefined, @Res() res: Response) {
    const token = fileName.endsWith('.ics') ? fileName.slice(0, -'.ics'.length) : fileName;
    this.sendIcs(res, await this.calendar.exportIcsByToken(token, { from, to, eventType }));
  }
  @Get('events/:id')
  /**
   * GET /calendar/events/:id — chi tiết sự kiện.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    const event = await this.calendar.getEvent(id);
    return { ...event, visibleToMe: await this.calendar.isVisibleTo(event, actor.id) };
  }
  @Post('events/:id/exception')
  /**
   * POST /calendar/events/:id/exceptions — tạo exception cho một occurrence.
   */
  async exception(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createCalendarExceptionSchema }) dto: CreateExceptionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createException(actor.id, id, dto);
  }
  @Post('events/:id/remind')
  /**
   * POST /calendar/events/:id/remind — đặt nhắc cho sự kiện.
   */
  async remind(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: calendarRemindSchema }) dto: RemindDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.scheduleReminder(actor.id, id, dto.minutesBefore);
  }
  @Delete('events/:id')
  /**
   * DELETE /calendar/events/:id — xoá sự kiện.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.deleteEvent(actor.id, id);
  }
  @Post('subscriptions')
  /**
   * POST /calendar/subscriptions — đăng ký lịch ngoài.
   */
  async createSubscription(@Body({ schema: createCalendarSubscriptionSchema }) dto: CreateSubscriptionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createSubscription(actor.id, dto);
  }
  @Get('subscriptions')
  /**
   * GET /calendar/subscriptions — subscription của tôi.
   */
  async listSubscriptions(@CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.listSubscriptions(actor.id);
  }
  @Post('subscriptions/:id/import')
  /**
   * POST /calendar/subscriptions/:id/import — đồng bộ ngay subscription.
   */
  async importNow(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.requestImport(actor.id, id);
  }
}
