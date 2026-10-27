import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { DeprecatedRouteAliasInterceptor } from '../../common/deprecated-route-alias.interceptor';
import { ContentService } from './content.service';
import {
  createLessonTemplateSchema, createPageSchema, createResourceSchema, recordProgressSchema,
  updatePageSchema, updateResourceSchema,
  type CreateLessonTemplateDto, type CreatePageDto, type CreateResourceDto, type RecordProgressDto, type UpdatePageDto, type UpdateResourceDto,
} from './dto/content.dto';

@ApiTags('content')
@Controller({ path: 'courses/:courseId/pages', version: '1' })
/** API tạo trang đọc (mod_page) trong một khoá học. */
export class CoursePagesController {
  constructor(private readonly content: ContentService) {}

  @Post()
  /** POST /courses/:courseId/pages — tạo trang đọc kèm course module. */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createPageSchema }) dto: CreatePageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.createPage(actor.id, courseId, dto);
  }
}

@ApiTags('content')
@Controller({ path: 'pages', version: '1' })
/** API trang đọc: đọc cho người xem, sửa và xoá cho người quản hoạt động. */
export class PagesController {
  constructor(private readonly content: ContentService) {}

  @Get(':id')
  /** GET /pages/:id — nội dung trang đọc cho người xem (qua cổng khoá học). */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getPageForUser(viewer.id, id);
  }

  @Patch(':id')
  /** PATCH /pages/:id — sửa trang đọc. */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updatePageSchema }) dto: UpdatePageDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.updatePage(actor.id, id, dto);
  }

  @Delete(':id')
  /** DELETE /pages/:id — xoá trang đọc và course module của nó. */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.content.deletePage(actor.id, id);
    return { deleted: true };
  }
}

@ApiTags('content')
@Controller({ path: 'courses/:courseId/resources', version: '1' })
/** API tạo tài nguyên (mod_resource) trong một khoá học. */
export class CourseResourcesController {
  constructor(private readonly content: ContentService) {}

  @Post()
  /** POST /courses/:courseId/resources — tạo tài nguyên (file hoặc liên kết) kèm course module. */
  async create(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createResourceSchema }) dto: CreateResourceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.createResource(actor.id, courseId, dto);
  }
}

@ApiTags('content')
@Controller({ path: 'resources', version: '1' })
/** API tài nguyên: đọc cho người xem (file kèm URL đã ký), sửa và xoá. */
export class ResourcesController {
  constructor(private readonly content: ContentService) {}

  @Get(':id')
  /** GET /resources/:id — tài nguyên cho người xem (qua cổng khoá học). */
  async get(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getResourceForUser(viewer.id, id);
  }

  @Patch(':id')
  /** PATCH /resources/:id — sửa tài nguyên. */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateResourceSchema }) dto: UpdateResourceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.updateResource(actor.id, id, dto);
  }

  @Delete(':id')
  /** DELETE /resources/:id — xoá tài nguyên và course module của nó. */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.content.deleteResource(actor.id, id);
    return { deleted: true };
  }
}

@ApiTags('content')
@Controller({ path: 'courses/:courseId', version: '1' })
/** API trang học (player) và tiến độ học trong khoá. */
export class PlayerController {
  constructor(private readonly content: ContentService) {}

  @Get('player/:cmId')
  /** GET /courses/:courseId/player/:cmId — dữ liệu player cho một mục; ghi last-access của người xem. */
  async player(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('cmId', { schema: uuidIdSchema }) cmId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getPlayer(viewer.id, courseId, cmId);
  }

  @Get('progress/me')
  /** GET /courses/:courseId/progress/me — tiến độ của chính người xem + điểm Học tiếp. */
  async myProgress(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getMyProgress(viewer.id, courseId);
  }

  @Get('progress/class-markers')
  /** GET /courses/:courseId/progress/class-markers — mốc "lớp đã học tới đây" theo từng lớp (nhóm). */
  async classMarkers(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getClassMarkers(viewer.id, courseId);
  }

  @Post('modules/:cmId/progress')
  /** POST /courses/:courseId/modules/:cmId/progress — học sinh báo tiến độ xem (lưu bền; client gửi bù khi rớt mạng). */
  async recordProgress(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('cmId', { schema: uuidIdSchema }) cmId: string, @Body({ schema: recordProgressSchema }) dto: RecordProgressDto, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.recordProgress(viewer.id, courseId, cmId, dto);
  }

  @Get('progress/report')
  /** GET /courses/:courseId/progress/report — báo cáo tiến độ cho giáo viên (ma trận lớp × mục + tổng theo mục/HS); ?groupId= lọc theo lớp/nhóm. */
  async progressReport(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('groupId') groupId: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    return this.content.getProgressReport(viewer.id, courseId, groupId);
  }

  @Get('progress/reports')
  /**
   * GET /courses/:courseId/progress/reports — bản xuất của ma trận tiến độ để tải xuống.
   * Định dạng là dữ liệu yêu cầu qua tham số truy vấn `format` (hiện
   * chỉ hỗ trợ `csv`; vắng mặt thì mặc định `csv`), không còn nằm
   * trong path theo chuẩn bỏ hậu tố file (issue #345); nội dung file
   * xuất giữ nguyên như bản CSV trước đây, `?groupId=` lọc theo
   * lớp/nhóm như cũ. Định dạng khác `csv` bị từ chối 400
   * `content.progress_report_format_unsupported`. Path cũ
   * `progress/report.csv` giữ qua handler alias ngay dưới.
   */
  async progressReports(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('groupId') groupId: string | undefined, @Query('format') format: string | undefined, @CurrentUser() viewer: AuthenticatedUser, @Res() res: Response) {
    if (format !== undefined && format !== 'csv') {
      throw new BadRequestException({ message: `Unsupported progress report format: ${format}`, code: 'content.progress_report_format_unsupported' });
    }
    const csv = await this.content.getProgressReportCsv(viewer.id, courseId, groupId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="progress-report.csv"');
    res.send(csv);
  }

  @Get('progress/report.csv')
  @UseInterceptors(DeprecatedRouteAliasInterceptor)
  /**
   * GET /courses/:courseId/progress/report.csv — alias cũ của GET
   * /courses/:courseId/progress/reports (định dạng `csv` cố định bởi
   * chính hậu tố path): uỷ quyền nguyên vẹn cho handler canonical;
   * response mang header Deprecation/Sunset và lượt gọi được ghi log
   * alias có cấu trúc (căn cứ điều kiện gỡ alias: 0 lượt gọi trong 14
   * ngày).
   */
  async progressReportCsv(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('groupId') groupId: string | undefined, @CurrentUser() viewer: AuthenticatedUser, @Res() res: Response) {
    return this.progressReports(courseId, groupId, 'csv', viewer, res);
  }

  @Post('lesson-template')
  /** POST /courses/:courseId/lesson-template — tạo bộ section mẫu "bài học" theo khung CV 5512 (khung gợi ý, không ép cứng). */
  async lessonTemplate(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createLessonTemplateSchema }) dto: CreateLessonTemplateDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.content.createLessonTemplate(actor.id, courseId, dto);
  }
}
