import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CalendarService } from './calendar.service';
import { calendarRemindSchema, createCalendarEventSchema, createCalendarExceptionSchema, createCalendarSubscriptionSchema, type CreateEventDto, type CreateExceptionDto, type CreateSubscriptionDto, type RemindDto } from './dto/calendar.dto';

@ApiTags('calendar')
@Controller({ path: 'calendar', version: '1' })
/**
 * API lịch: sự kiện, exception, nhắc và subscription.
 */
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

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
    @Query('eventtype') eventtype: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.listEventsForUser(actor.id, { from, to, eventtype });
  }
  @Get('events/:id')
  /**
   * GET /calendar/events/:id — chi tiết sự kiện.
   */
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    const event = await this.calendar.getEvent(id);
    return { ...event, visibleToMe: await this.calendar.isVisibleTo(event, actor.id) };
  }
  @Post('events/:id/exception')
  /**
   * POST /calendar/events/:id/exceptions — tạo exception cho một occurrence.
   */
  async exception(@Param('id', ParseIntPipe) id: number, @Body({ schema: createCalendarExceptionSchema }) dto: CreateExceptionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createException(actor.id, id, dto);
  }
  @Post('events/:id/remind')
  /**
   * POST /calendar/events/:id/remind — đặt nhắc cho sự kiện.
   */
  async remind(@Param('id', ParseIntPipe) id: number, @Body({ schema: calendarRemindSchema }) dto: RemindDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.scheduleReminder(actor.id, id, dto.minutesBefore);
  }
  @Delete('events/:id')
  /**
   * DELETE /calendar/events/:id — xoá sự kiện.
   */
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
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
  async listSubscriptions() {
    return this.calendar.listSubscriptions();
  }
  @Post('subscriptions/:id/import')
  /**
   * POST /calendar/subscriptions/:id/import — đồng bộ ngay subscription.
   */
  async importNow(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.requestImport(actor.id, id);
  }
}
