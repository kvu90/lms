import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CreateReportDto, CreateScheduleDto } from './dto/reports.dto';
import { ReportsService } from './reports.service';

/** Controller Report Builder. */
@ApiTags('reports')
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get('datasources')
  async datasources() { return this.reports.listDatasources(); }
  @Post()
  async create(@Body() dto: CreateReportDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.reports.createReport(actor.id, dto);
  }
  @Get()
  async list() { return this.reports.listReports(); }
  @Get('schedules/all')
  async schedules() { return this.reports.listSchedules(); }
  @Post('schedules/:id/run')
  async runSchedule(@Param('id', ParseIntPipe) id: number) { return this.reports.runSchedule(id); }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) { return this.reports.getReport(id); }
  @Get(':id/run')
  async run(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.reports.runReport(actor.id, id);
  }
  @Post(':id/schedules')
  async schedule(@Param('id', ParseIntPipe) id: number, @Body() dto: CreateScheduleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.reports.createSchedule(actor.id, id, dto.cron ?? 'daily');
  }
}
