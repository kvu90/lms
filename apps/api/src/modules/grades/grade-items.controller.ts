import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { gradePublicationActionSchema, setGradePostingPolicySchema, setGradeSchema, updateGradeItemSchema, updateGradeSchema, type GradePublicationActionDto, type SetGradeDto, type SetGradePostingPolicyDto, type UpdateGradeDto, type UpdateGradeItemDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'grade-items', version: '1' })
/**
 * API gắn với một grade item ở path canonical theo chuẩn đường dẫn
 * module điểm (issue #342): item được định danh thẳng ở gốc
 * (`grade-items/:itemId`) thay vì lồng dưới `courses/grades/items`
 * như path cũ. Logic nghiệp vụ giữ nguyên của module điểm theo bài
 * (issue #224): cập nhật/xoá item, nhập điểm, chính sách công bố,
 * công bố/rút công bố và lịch sử thay đổi điểm. Các path cũ vẫn tới
 * được qua các controller alias trong `legacy-grades.controller.ts`.
 */
export class GradeItemsController {
  constructor(private readonly grades: GradesService) {}

  @Patch(':itemId')
  /**
   * PATCH /grade-items/:itemId — cập nhật item.
   */
  async updateItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: updateGradeItemSchema }) dto: UpdateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateItem(actor.id, itemId, dto);
  }
  @Delete(':itemId')
  /**
   * DELETE /grade-items/:itemId — xoá item.
   */
  async deleteItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteItem(actor.id, itemId);
    return { deleted: true };
  }

  @Post(':itemId/grades')
  /**
   * POST /grade-items/:itemId/grades — nhập điểm của một bài cho user.
   */
  async setGrade(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradeSchema }) dto: SetGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setGrade(actor.id, itemId, dto.userId, dto);
  }
  @Put(':itemId/posting-policy')
  /**
   * PUT /grade-items/:itemId/posting-policy — đặt chính sách công bố của item (PH-0): auto | manual.
   */
  async setPostingPolicy(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: setGradePostingPolicySchema }) dto: SetGradePostingPolicyDto, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.setItemPostingPolicy(actor.id, itemId, dto.policy);
    return { itemId: item.id, policy: item.postingPolicy };
  }
  @Post(':itemId/publish')
  /**
   * POST /grade-items/:itemId/publish — công bố điểm của bài cho mọi học sinh (ghi vết grade_publications + event_log).
   */
  async publishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'publish', dto.note);
  }
  @Post(':itemId/unpublish')
  /**
   * POST /grade-items/:itemId/unpublish — rút công bố điểm của bài (học sinh mất quyền thấy điểm cho tới khi công bố lại).
   */
  async unpublishItem(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Body({ schema: gradePublicationActionSchema }) dto: GradePublicationActionDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setItemPublication(actor.id, itemId, 'unpublish', dto.note);
  }

  @Get(':itemId/users/:userId/history')
  /**
   * GET /grade-items/:itemId/users/:userId/history — lịch sử thay đổi điểm.
   */
  async history(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // Lịch sử của người dùng khác yêu cầu grade:viewall tại context của khoá học.
      await this.grades.getCourseActivityGrid(actor.id, item.courseId);
    }
    return this.grades.listHistory(itemId, userId);
  }
}

@ApiTags('grades')
@Controller({ path: 'grades', version: '1' })
/**
 * API gắn với một bản ghi điểm ở path canonical theo chuẩn đường dẫn
 * module điểm (issue #342): bản ghi điểm được định danh thẳng ở gốc
 * (`grades/:gradeId`) thay vì lồng dưới `courses/grades/grades` như
 * path cũ. Path cũ vẫn tới được qua controller alias trong
 * `legacy-grades.controller.ts`.
 */
export class GradeRecordsController {
  constructor(private readonly grades: GradesService) {}

  @Patch(':gradeId')
  /**
   * PATCH /grades/:gradeId — sửa một bản ghi điểm.
   */
  async updateGrade(@Param('gradeId', { schema: uuidIdSchema }) gradeId: string, @Body({ schema: updateGradeSchema }) dto: UpdateGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateGrade(actor.id, gradeId, dto);
  }
}
