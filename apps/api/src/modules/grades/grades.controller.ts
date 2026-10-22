import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { createGradeCategorySchema, createGradeItemSchema, createGradeScaleSchema, setGradeLettersSchema, setGradeSchema, updateGradeCategorySchema, updateGradeItemSchema, updateGradeSchema, type CreateGradeCategoryDto, type CreateGradeItemDto, type CreateScaleDto, type SetGradeDto, type SetLettersDto, type UpdateGradeCategoryDto, type UpdateGradeDto, type UpdateGradeItemDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'courses', version: '1' })
/**
 * API sổ điểm: category, item, nhập điểm, sổ điểm cá nhân, báo cáo lớp, letters và scales.
 */
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Post(':courseId/grades/categories')
  /**
   * POST /courses/:id/grade-categories — tạo category điểm.
   */
  async createCategory(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGradeCategorySchema }) dto: CreateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createCategory(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/categories')
  /**
   * GET /courses/:id/grade-categories — liệt kê category.
   */
  async listCategories(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.listCategories(courseId);
  }
  @Patch('grades/categories/:categoryId')
  /**
   * PATCH /grade-categories/:id — cập nhật category.
   */
  async updateCategory(@Param('categoryId', ParseIntPipe) categoryId: number, @Body({ schema: updateGradeCategorySchema }) dto: UpdateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateCategory(actor.id, categoryId, dto);
  }
  @Delete('grades/categories/:categoryId')
  /**
   * DELETE /grade-categories/:id — xoá category.
   */
  async deleteCategory(@Param('categoryId', ParseIntPipe) categoryId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteCategory(actor.id, categoryId);
    return { deleted: true };
  }

  @Post(':courseId/grades/items')
  /**
   * POST /courses/:id/grade-items — tạo grade item.
   */
  async createItem(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/items')
  /**
   * GET /courses/:id/grade-items — liệt kê item.
   */
  async listItems(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.listItems(courseId);
  }
  @Patch('grades/items/:itemId')
  /**
   * PATCH /grade-items/:id — cập nhật item.
   */
  async updateItem(@Param('itemId', ParseIntPipe) itemId: number, @Body({ schema: updateGradeItemSchema }) dto: UpdateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateItem(actor.id, itemId, dto);
  }
  @Delete('grades/items/:itemId')
  /**
   * DELETE /grade-items/:id — xoá item.
   */
  async deleteItem(@Param('itemId', ParseIntPipe) itemId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteItem(actor.id, itemId);
    return { deleted: true };
  }

  @Post('grades/items/:itemId/grades')
  /**
   * POST /grade-items/:id/grades — nhập điểm cho user.
   */
  async setGrade(@Param('itemId', ParseIntPipe) itemId: number, @Body({ schema: setGradeSchema }) dto: SetGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setGrade(actor.id, itemId, dto.userid, dto);
  }
  @Patch('grades/grades/:gradeId')
  /**
   * PATCH /grades/:id — sửa một bản ghi điểm.
   */
  async updateGrade(@Param('gradeId', ParseIntPipe) gradeId: number, @Body({ schema: updateGradeSchema }) dto: UpdateGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateGrade(actor.id, gradeId, dto);
  }
  @Get('grades/items/:itemId/users/:userId/history')
  /**
   * GET /grade-items/:id/history — lịch sử thay đổi điểm.
   */
  async history(@Param('itemId', ParseIntPipe) itemId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // History of another user requires moodle/grade:viewall at the course context.
      await this.grades.getReport(actor.id, item.courseid);
    }
    return this.grades.listHistory(itemId, userId);
  }

  @Get(':courseId/gradebook')
  /**
   * GET /courses/:id/gradebook — sổ điểm của user hiện tại.
   */
  async gradebook(@Param('courseId', ParseIntPipe) courseId: number, @Query('userid') userid: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    const target = userid ? Number(userid) : viewer.id;
    return this.grades.getGradebook(viewer.id, courseId, target);
  }
  @Get(':courseId/grades/report')
  /**
   * GET /courses/:id/grade-report — báo cáo điểm toàn lớp.
   */
  async report(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getReport(viewer.id, courseId);
  }
  @Post(':courseId/grades/regrade')
  /**
   * POST /courses/:id/regrade — tính lại điểm toàn khoá học.
   */
  async regrade(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.triggerRegrade(actor.id, courseId);
  }

  @Get(':courseId/grades/letters')
  /**
   * GET /courses/:id/grade-letters — bảng chữ cái điểm.
   */
  async letters(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.getLetters(courseId);
  }
  @Put(':courseId/grades/letters')
  /**
   * PUT /courses/:id/grade-letters — đặt bảng chữ cái điểm.
   */
  async setLetters(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: setGradeLettersSchema }) dto: SetLettersDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setLetters(actor.id, courseId, dto.letters);
  }

  @Post(':courseId/grades/scales')
  /**
   * POST /grade-scales — tạo scale.
   */
  async createScale(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGradeScaleSchema }) dto: CreateScaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createScale(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/scales')
  /**
   * GET /grade-scales — liệt kê scales.
   */
  async scales(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.listScales(courseId);
  }
}
