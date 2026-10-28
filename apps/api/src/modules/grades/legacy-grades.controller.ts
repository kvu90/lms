import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Res, UseInterceptors } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradePathsDeprecationInterceptor } from './deprecation.interceptor';
import { GradesService } from './grades.service';
import { createGradeItemSchema, exportGradesVneduSchema, gradePublicationActionSchema, setGradePostingPolicySchema, setGradeSchema, updateGradeItemSchema, updateGradeSchema, type CreateGradeItemDto, type ExportGradesVneduDto, type GradePublicationActionDto, type SetGradeDto, type SetGradePostingPolicyDto, type UpdateGradeDto, type UpdateGradeItemDto } from './dto/grades.dto';

/**
 * Các controller alias giữ các path cũ của module điểm chạy song song
 * với path canonical sau khi module điểm áp chuẩn đường dẫn (issue
 * #342).
 *
 * @remarks
 * Chính sách alias: mọi handler trong file này là handler mỏng uỷ
 * thác đúng các method của `GradesService` như handler canonical
 * tương ứng — cùng schema kiểm chứng, cùng logic nghiệp vụ, cùng kết
 * quả trả về; chỉ khác path. Mỗi lượt gọi qua alias đều đi qua
 * `GradePathsDeprecationInterceptor`: response mang header
 * `Deprecation: true` và `Sunset: Sun, 01 Feb 2027 00:00:00 GMT`, và
 * hệ thống ghi một bản ghi log có cấu trúc cho lượt gọi đó (sự kiện
 * `deprecated_route_alias`, kèm method, mẫu alias, mẫu canonical và
 * path cụ thể).
 *
 * Điều kiện gỡ alias: log có cấu trúc của các lượt gọi alias là căn
 * cứ chính — khi log ghi nhận 0 lượt gọi alias trong 14 ngày thì
 * alias đủ điều kiện gỡ. Header Sunset chỉ là hạn ngoài thông báo cho
 * client, không phải căn cứ tự động gỡ alias khi tới hạn mà log vẫn
 * còn lượt gọi.
 *
 * Hai controller alias tương ứng hai họ path cũ: các path cũ thuộc
 * khoá học (`courses/:courseId/grades/...`) và các path cũ "phantom"
 * lồng dưới tiền tố cố định `courses/grades/...` mà không mang id
 * khoá học trong path.
 *
 * Tên method của mọi handler alias đều mang tiền tố `legacy` và mỗi
 * handler khai `operationId` riêng qua `@ApiOperation`: controller
 * alias dùng chung tag `grades` với controller canonical, nếu trùng tên
 * method thì Swagger không sinh được operationId phân biệt cho hai
 * operation cùng tên và lỗi tại bước tạo tài liệu OpenAPI.
 */
@ApiTags('grades')
@Controller({ path: 'courses/:courseId/grades', version: '1' })
@UseInterceptors(GradePathsDeprecationInterceptor)
/**
 * Alias cho các path cũ thuộc khoá học của module điểm: tạo/liệt kê
 * grade item, lưới báo cáo và xuất vnEdu theo path cũ. Handler canonical
 * tương ứng nằm ở `grades.controller.ts`. Lớp khai tiền tố con đầy đủ
 * của chính nó thay vì tiền tố trơ `courses`: tiền tố trơ `courses` chỉ
 * còn module courses sở hữu. Mọi path alias giữ nguyên từng ký tự so
 * với trước khi đổi hình thức khai báo.
 */
export class LegacyGradesCourseController {
  constructor(private readonly grades: GradesService) {}

  @Post('items')
  /**
   * POST /courses/:courseId/grades/items — alias cũ của POST /courses/:courseId/grade-items: tạo grade item.
   */
  @ApiOperation({ operationId: 'legacyGradesCreateItem' })
  async legacyCreateItem(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get('items')
  /**
   * GET /courses/:courseId/grades/items — alias cũ của GET /courses/:courseId/grade-items: liệt kê item (các bài có điểm) của khoá.
   */
  @ApiOperation({ operationId: 'legacyGradesListItems' })
  async legacyListItems(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.listItems(actor.id, courseId);
  }
  @Get('report')
  /**
   * GET /courses/:courseId/grades/report — alias cũ của GET /courses/:courseId/gradebook/report: lưới CHỈ-ĐỌC học sinh × các bài của khoá cho giáo viên.
   */
  @ApiOperation({ operationId: 'legacyGradesReport' })
  async legacyReport(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getCourseActivityGrid(viewer.id, courseId);
  }

  @Post('export/vnedu')
  @HttpCode(200)
  /**
   * POST /courses/:courseId/grades/export/vnedu — alias cũ của POST /courses/:courseId/grade-exports với provider vnedu: xuất điểm ra Excel theo cấu trúc vnEdu (issue #53).
   * Thân yêu cầu ở alias này giữ khuôn vnEdu cũ, không có trường `provider` (nhà cung cấp đã nằm trong chính path cũ).
   * Nguồn (issue #224): chỉ các bài ĐÃ CÔNG BỐ mới được xuất; bài chưa công bố bị từ chối.
   */
  @ApiOperation({ operationId: 'legacyGradesExportVnedu' })
  async legacyExportVnedu(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: exportGradesVneduSchema }) dto: ExportGradesVneduDto, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const { filename, buffer } = await this.grades.exportGradesVnedu(actor.id, courseId, dto);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}

@ApiTags('grades')
@Controller({ path: 'courses/grades', version: '1' })
@UseInterceptors(GradePathsDeprecationInterceptor)
/**
 * Alias cho các path cũ "phantom" của module điểm: các path lồng dưới
 * tiền tố cố định `courses/grades` mà không mang id khoá học trong
 * path — cập nhật/xoá item, nhập điểm, sửa bản ghi điểm, chính sách
 * công bố, công bố/rút công bố và lịch sử điểm. Handler canonical
 * tương ứng nằm ở `grade-items.controller.ts`.
 */
export class LegacyGradesPhantomController {
  constructor(private readonly grades: GradesService) {}

  @Patch('items/:itemId')
  /**
   * PATCH /courses/grades/items/:itemId — alias cũ của PATCH /grade-items/:itemId: cập nhật item.
   */
  @ApiOperation({ operationId: 'legacyGradesUpdateItem' })
  async legacyUpdateItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: updateGradeItemSchema }) dto: UpdateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateItem(actor.id, itemId, dto);
  }
  @Delete('items/:itemId')
  /**
   * DELETE /courses/grades/items/:itemId — alias cũ của DELETE /grade-items/:itemId: xoá item.
   */
  @ApiOperation({ operationId: 'legacyGradesDeleteItem' })
  async legacyDeleteItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteItem(actor.id, itemId);
    return { deleted: true };
  }

  @Post('items/:itemId/grades')
  /**
   * POST /courses/grades/items/:itemId/grades — alias cũ của POST /grade-items/:itemId/grades: nhập điểm của một bài cho user.
   */
  @ApiOperation({ operationId: 'legacyGradesSetGrade' })
  async legacySetGrade(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradeSchema }) dto: SetGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setGrade(actor.id, itemId, dto.userId, dto);
  }
  @Patch('grades/:gradeId')
  /**
   * PATCH /courses/grades/grades/:gradeId — alias cũ của PATCH /grades/:gradeId: sửa một bản ghi điểm.
   */
  @ApiOperation({ operationId: 'legacyGradesUpdateGrade' })
  async legacyUpdateGrade(@Param('gradeId', { schema: uuidIdSchema }) gradeId: string, @Body({ schema: updateGradeSchema }) dto: UpdateGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateGrade(actor.id, gradeId, dto);
  }
  @Put('items/:itemId/posting-policy')
  /**
   * PUT /courses/grades/items/:itemId/posting-policy — alias cũ của PUT /grade-items/:itemId/posting-policy: đặt chính sách công bố của item (PH-0): auto | manual.
   */
  @ApiOperation({ operationId: 'legacyGradesSetPostingPolicy' })
  async legacySetPostingPolicy(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradePostingPolicySchema }) dto: SetGradePostingPolicyDto, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.setItemPostingPolicy(actor.id, itemId, dto.policy);
    return { itemId: item.id, policy: item.postingPolicy };
  }
  @Post('items/:itemId/publish')
  /**
   * POST /courses/grades/items/:itemId/publish — alias cũ của POST /grade-items/:itemId/publish: công bố điểm của bài cho mọi học sinh (ghi vết grade_publications + event_log).
   */
  @ApiOperation({ operationId: 'legacyGradesPublishItem' })
  async legacyPublishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'publish', dto.note);
  }
  @Post('items/:itemId/unpublish')
  /**
   * POST /courses/grades/items/:itemId/unpublish — alias cũ của POST /grade-items/:itemId/unpublish: rút công bố điểm của bài (học sinh mất quyền thấy điểm cho tới khi công bố lại).
   */
  @ApiOperation({ operationId: 'legacyGradesUnpublishItem' })
  async legacyUnpublishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'unpublish', dto.note);
  }

  @Get('items/:itemId/users/:userId/history')
  /**
   * GET /courses/grades/items/:itemId/users/:userId/history — alias cũ của GET /grade-items/:itemId/users/:userId/history: lịch sử thay đổi điểm.
   */
  @ApiOperation({ operationId: 'legacyGradesHistory' })
  async legacyHistory(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // Lịch sử của người dùng khác yêu cầu grade:viewall tại context của khoá học.
      await this.grades.getCourseActivityGrid(actor.id, item.courseId);
    }
    return this.grades.listHistory(itemId, userId);
  }
}
