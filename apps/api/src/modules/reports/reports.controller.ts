import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createReportSchema, createReportScheduleSchema, type CreateReportDto, type CreateScheduleDto } from './dto/reports.dto';
import { ReportsService } from './reports.service';

/** Controller Report Builder. */
@ApiTags('reports')
@Controller({ path: 'reports', version: '1' })
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Get('datasources')
  async datasources() { return this.reports.listDatasources(); }
  @Post()
  async create(@Body({ schema: createReportSchema }) dto: CreateReportDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.reports.createReport(actor.id, dto);
  }
  @Get()
  async list() { return this.reports.listReports(); }
  @Get('schedules/all')
  async schedules() { return this.reports.listSchedules(); }
  @Post('schedules/:id/run')
  async runSchedule(@Param('id', { schema: uuidIdSchema }) id: string) { return this.reports.runSchedule(id); }
  @Get(':id')
  async get(@Param('id', { schema: uuidIdSchema }) id: string) { return this.reports.getReport(id); }
  @Get(':id/run')
  async run(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.reports.runReport(actor.id, id);
  }
  @Post(':id/schedules')
  async schedule(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: createReportScheduleSchema }) dto: CreateScheduleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.reports.createSchedule(actor.id, id, dto.cron ?? 'daily');
  }
}
