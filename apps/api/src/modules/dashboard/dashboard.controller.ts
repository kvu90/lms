import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import {
  dashboardOverviewQuerySchema,
  upsertCourseCardPrefSchema,
  type DashboardOverviewQueryDto,
  type UpsertCourseCardPrefDto,
} from './dto/dashboard.dto';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller({ path: 'dashboard', version: '1' })
/**
 * API Dashboard việc cần làm (DASH1, issue #121): khối tổng hợp đầu
 * dashboard + tuỳ chọn thẻ khoá cá nhân. Mọi endpoint chỉ trả dữ liệu của
 * chính người gọi — không nhận tham số user.
 */
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  /**
   * GET /dashboard/overview?days=7 — MỘT response cho cả khối: việc sắp
   * đến hạn của học sinh, điểm/phản hồi mới đã công bố kể từ lần xem trước
   * (đồng thời cập nhật mốc xem trước phía server), hàng đợi chấm của
   * giáo viên gộp theo khoá.
   */
  async overview(
    @Query({ schema: dashboardOverviewQuerySchema }) query: DashboardOverviewQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.dashboard.getOverview(actor.id, query.days);
  }

  @Get('course-cards')
  /**
   * GET /dashboard/course-cards — pref thẻ khoá (màu/biệt danh) của chính
   * người gọi.
   */
  async courseCards(@CurrentUser() actor: AuthenticatedUser) {
    return { prefs: await this.dashboard.listCourseCards(actor.id) };
  }

  @Put('course-cards/:courseId')
  /**
   * PUT /dashboard/course-cards/:courseId — đặt/xoá màu + biệt danh thẻ
   * khoá của chính người gọi cho một khoá họ thuộc về.
   */
  async upsertCourseCard(
    @Param('courseId', { schema: uuidIdSchema }) courseId: string,
    @Body({ schema: upsertCourseCardPrefSchema }) dto: UpsertCourseCardPrefDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.dashboard.upsertCourseCard(actor.id, courseId, dto);
  }
}
