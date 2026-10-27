import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { createGradeItemSchema, exportGradesVneduSchema, gradePublicationActionSchema, setGradePostingPolicySchema, setGradeSchema, updateGradeItemSchema, updateGradeSchema, type CreateGradeItemDto, type ExportGradesVneduDto, type GradePublicationActionDto, type SetGradeDto, type SetGradePostingPolicyDto, type UpdateGradeDto, type UpdateGradeItemDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'courses', version: '1' })
/**
 * API điểm theo bài (issue #224): grade item = một bài/hoạt động, nhập
 * điểm của bài, công bố điểm cấp bài, lưới xem học sinh × các bài và
 * xuất vnEdu từ điểm đã công bố. KHÔNG còn sổ điểm tổng hợp của khoá
 * và KHÔNG còn Sổ điểm VN.
 */
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Post(':courseId/grades/items')
  /**
   * POST /courses/:courseId/grades/items — tạo grade item.
   */
  async createItem(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/items')
  /**
   * GET /courses/:courseId/grades/items — liệt kê item (các bài có điểm) của khoá.
   */
  async listItems(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.listItems(actor.id, courseId);
  }
  @Patch('grades/items/:itemId')
  /**
   * PATCH /courses/grades/items/:itemId — cập nhật item.
   */
  async updateItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: updateGradeItemSchema }) dto: UpdateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateItem(actor.id, itemId, dto);
  }
  @Delete('grades/items/:itemId')
  /**
   * DELETE /courses/grades/items/:itemId — xoá item.
   */
  async deleteItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteItem(actor.id, itemId);
    return { deleted: true };
  }

  @Post('grades/items/:itemId/grades')
  /**
   * POST /courses/grades/items/:itemId/grades — nhập điểm của một bài cho user.
   */
  async setGrade(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradeSchema }) dto: SetGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setGrade(actor.id, itemId, dto.userId, dto);
  }
  @Patch('grades/grades/:gradeId')
  /**
   * PATCH /courses/grades/:gradeId — sửa một bản ghi điểm.
   */
  async updateGrade(@Param('gradeId', { schema: uuidIdSchema }) gradeId: string, @Body({ schema: updateGradeSchema }) dto: UpdateGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateGrade(actor.id, gradeId, dto);
  }
  @Put('grades/items/:itemId/posting-policy')
  /**
   * PUT /courses/grades/items/:itemId/posting-policy — đặt chính sách công bố của item (PH-0): auto | manual.
   */
  async setPostingPolicy(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradePostingPolicySchema }) dto: SetGradePostingPolicyDto, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.setItemPostingPolicy(actor.id, itemId, dto.policy);
    return { itemId: item.id, policy: item.postingPolicy };
  }
  @Post('grades/items/:itemId/publish')
  /**
   * POST /courses/grades/items/:itemId/publish — công bố điểm của bài cho mọi học sinh (ghi vết grade_publications + event_log).
   */
  async publishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'publish', dto.note);
  }
  @Post('grades/items/:itemId/unpublish')
  /**
   * POST /courses/grades/items/:itemId/unpublish — rút công bố điểm của bài (học sinh mất quyền thấy điểm cho tới khi công bố lại).
   */
  async unpublishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'unpublish', dto.note);
  }

  @Get('grades/items/:itemId/users/:userId/history')
  /**
   * GET /courses/grades/items/:itemId/users/:userId/history — lịch sử thay đổi điểm.
   */
  async history(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // Lịch sử của người dùng khác yêu cầu grade:viewall tại context của khoá học.
      await this.grades.getCourseActivityGrid(actor.id, item.courseId);
    }
    return this.grades.listHistory(itemId, userId);
  }

  @Get(':courseId/gradebook')
  /**
   * GET /courses/:courseId/gradebook — điểm THEO TỪNG BÀI của một học
   * sinh trong khoá (mặc định là chính mình): danh sách bài + điểm +
   * trạng thái công bố. Thay cho sổ điểm tổng hợp cũ và cho ĐX-2 xem
   * ĐTB khoá (issue #224): không còn điểm tổng/trung bình của khoá.
   */
  async gradebook(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('userId') userId: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    const target = userId || viewer.id;
    return this.grades.listUserActivityGrades(viewer.id, courseId, target);
  }
  @Get(':courseId/grades/report')
  /**
   * GET /courses/:courseId/grades/report — lưới CHỈ-ĐỌC học sinh × các
   * bài của khoá cho giáo viên: một hàng mỗi học sinh đã ghi danh, mỗi
   * ô là điểm của đúng bài đó. Không điểm tổng, không trọng số (issue #224).
   */
  async report(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getCourseActivityGrid(viewer.id, courseId);
  }

  @Post(':courseId/grades/export/vnedu')
  @HttpCode(200)
  /**
   * POST /courses/:courseId/grades/export/vnedu — xuất điểm ra Excel theo cấu trúc vnEdu (issue #53):
   * body mang ánh xạ bài → loại cột (thường xuyên/giữa kỳ/cuối kỳ) do giáo viên xác nhận; trả file .xlsx đính kèm.
   * Nguồn (issue #224): chỉ các bài ĐÃ CÔNG BỐ mới được xuất; bài chưa công bố bị từ chối.
   */
  async exportVnedu(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: exportGradesVneduSchema }) dto: ExportGradesVneduDto, @CurrentUser() actor: AuthenticatedUser, @Res() res: Response) {
    const { filename, buffer } = await this.grades.exportGradesVnedu(actor.id, courseId, dto);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
}
