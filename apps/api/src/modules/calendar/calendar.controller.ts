import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CalendarService } from './calendar.service';
import { calendarRemindSchema, createCalendarEventSchema, createCalendarExceptionSchema, createCalendarSubscriptionSchema, type CreateEventDto, type CreateExceptionDto, type CreateSubscriptionDto, type RemindDto } from './dto/calendar.dto';

@ApiTags('calendar')
@Controller({ path: 'calendar', version: '1' })
export class CalendarController {
  constructor(private readonly calendar: CalendarService) {}

  @Post('events')
  async create(@Body({ schema: createCalendarEventSchema }) dto: CreateEventDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createEvent(actor.id, dto);
  }
  @Get('events')
  async list(@Query('from') from: string | undefined, @Query('to') to: string | undefined,
    @Query('eventtype') eventtype: string | undefined, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.listEventsForUser(actor.id, { from, to, eventtype });
  }
  @Get('events/:id')
  async get(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    const event = await this.calendar.getEvent(id);
    return { ...event, visibleToMe: await this.calendar.isVisibleTo(event, actor.id) };
  }
  @Post('events/:id/exception')
  async exception(@Param('id', ParseIntPipe) id: number, @Body({ schema: createCalendarExceptionSchema }) dto: CreateExceptionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createException(actor.id, id, dto);
  }
  @Post('events/:id/remind')
  async remind(@Param('id', ParseIntPipe) id: number, @Body({ schema: calendarRemindSchema }) dto: RemindDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.scheduleReminder(actor.id, id, dto.minutesBefore);
  }
  @Delete('events/:id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.deleteEvent(actor.id, id);
  }
  @Post('subscriptions')
  async createSubscription(@Body({ schema: createCalendarSubscriptionSchema }) dto: CreateSubscriptionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.createSubscription(actor.id, dto);
  }
  @Get('subscriptions')
  async listSubscriptions() {
    return this.calendar.listSubscriptions();
  }
  @Post('subscriptions/:id/import')
  async importNow(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.calendar.requestImport(actor.id, id);
  }
}
