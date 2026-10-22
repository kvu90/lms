import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { AnalyticsService } from './analytics.service';
import { runAnalyticsModelSchema, type RunModelDto } from './dto/analytics.dto';

/** Controller Analytics: models, run, insights của người dùng hiện tại. */
@ApiTags('analytics')
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}
  @Get('models')
  async models() { return this.analytics.listModels(); }
  @Get('indicators')
  async indicators() { return this.analytics.listIndicators(); }
  @Post('models/:name/run')
  async run(@Param('name') name: string, @Body({ schema: runAnalyticsModelSchema }) dto: RunModelDto) {
    return this.analytics.runModel(name, dto.courseId);
  }
  @Get('insights/me')
  async myInsights(@CurrentUser() actor: AuthenticatedUser) { return this.analytics.listInsightsFor(actor.id); }
  @Get('insights')
  async allInsights() { return this.analytics.listAllInsights(); }
}
