import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { createGradeCategorySchema, createGradeItemSchema, createGradeOutcomeSchema, createGradeScaleSchema, setGradeLettersSchema, setGradeSchema, updateGradeCategorySchema, updateGradeItemSchema, updateGradeOutcomeSchema, updateGradeSchema, type CreateGradeCategoryDto, type CreateGradeItemDto, type CreateGradeOutcomeDto, type CreateScaleDto, type SetGradeDto, type SetLettersDto, type UpdateGradeCategoryDto, type UpdateGradeDto, type UpdateGradeItemDto, type UpdateGradeOutcomeDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'courses', version: '1' })
/**
 * API sổ điểm: category, item, nhập điểm, sổ điểm cá nhân, báo cáo lớp, letters và scales.
 */
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Post(':courseId/grades/categories')
  /**
   * POST /courses/:courseId/grades/categories — tạo category điểm.
   */
  async createCategory(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeCategorySchema }) dto: CreateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createCategory(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/categories')
  /**
   * GET /courses/:courseId/grades/categories — liệt kê category.
   */
  async listCategories(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listCategories(courseId);
  }
  @Patch('grades/categories/:categoryId')
  /**
   * PATCH /courses/grades/categories/:categoryId — cập nhật category.
   */
  async updateCategory(@Param('categoryId', { schema: uuidIdSchema }) categoryId: string, @Body({ schema: updateGradeCategorySchema }) dto: UpdateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateCategory(actor.id, categoryId, dto);
  }
  @Delete('grades/categories/:categoryId')
  /**
   * DELETE /courses/grades/categories/:categoryId — xoá category.
   */
  async deleteCategory(@Param('categoryId', { schema: uuidIdSchema }) categoryId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteCategory(actor.id, categoryId);
    return { deleted: true };
  }

  @Post(':courseId/grades/items')
  /**
   * POST /courses/:courseId/grades/items — tạo grade item.
   */
  async createItem(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/items')
  /**
   * GET /courses/:courseId/grades/items — liệt kê item.
   */
  async listItems(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listItems(courseId);
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
   * POST /courses/grades/items/:itemId/grades — nhập điểm cho user.
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
  @Get('grades/items/:itemId/users/:userId/history')
  /**
   * GET /courses/grades/items/:itemId/users/:userId/history — lịch sử thay đổi điểm.
   */
  async history(@Param('itemId', { schema: uuidIdSchema }) itemId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // History of another user requires moodle/grade:viewall at the course context.
      await this.grades.getReport(actor.id, item.courseId);
    }
    return this.grades.listHistory(itemId, userId);
  }

  @Get(':courseId/gradebook')
  /**
   * GET /courses/:courseId/gradebook — sổ điểm của user (mặc định là chính mình).
   */
  async gradebook(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Query('userId') userId: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    const target = userId || viewer.id;
    return this.grades.getGradebook(viewer.id, courseId, target);
  }
  @Get(':courseId/grades/report')
  /**
   * GET /courses/:courseId/grades/report — báo cáo điểm toàn lớp.
   */
  async report(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getReport(viewer.id, courseId);
  }
  @Post(':courseId/grades/regrade')
  /**
   * POST /courses/:courseId/grades/regrade — tính lại điểm toàn khoá học.
   */
  async regrade(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.triggerRegrade(actor.id, courseId);
  }

  @Get(':courseId/grades/letters')
  /**
   * GET /courses/:courseId/grades/letters — bảng chữ cái điểm.
   */
  async letters(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.getLetters(courseId);
  }
  @Put(':courseId/grades/letters')
  /**
   * PUT /courses/:courseId/grades/letters — đặt bảng chữ cái điểm.
   */
  async setLetters(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: setGradeLettersSchema }) dto: SetLettersDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setLetters(actor.id, courseId, dto.letters);
  }

  @Post(':courseId/grades/scales')
  /**
   * POST /courses/:courseId/grades/scales — tạo scale cho khoá học.
   */
  async createScale(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeScaleSchema }) dto: CreateScaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createScale(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/scales')
  /**
   * GET /courses/:courseId/grades/scales — liệt kê scales của khoá học.
   */
  async scales(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listScales(courseId);
  }

  @Post(':courseId/grades/outcomes')
  /**
   * POST /courses/:courseId/grades/outcomes — tạo grade outcome mức khoá học.
   */
  async createOutcome(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGradeOutcomeSchema }) dto: CreateGradeOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createOutcome(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/outcomes')
  /**
   * GET /courses/:courseId/grades/outcomes — liệt kê outcome của khoá học và outcome mức site.
   */
  async listOutcomes(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.grades.listOutcomes(courseId);
  }
  @Patch('grades/outcomes/:outcomeId')
  /**
   * PATCH /courses/grades/outcomes/:outcomeId — cập nhật grade outcome.
   */
  async updateOutcome(@Param('outcomeId', { schema: uuidIdSchema }) outcomeId: string, @Body({ schema: updateGradeOutcomeSchema }) dto: UpdateGradeOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateOutcome(actor.id, outcomeId, dto);
  }
  @Delete('grades/outcomes/:outcomeId')
  /**
   * DELETE /courses/grades/outcomes/:outcomeId — xoá grade outcome.
   */
  async deleteOutcome(@Param('outcomeId', { schema: uuidIdSchema }) outcomeId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteOutcome(actor.id, outcomeId);
    return { deleted: true };
  }
}

@ApiTags('grades')
@Controller({ path: 'grades', version: '1' })
/**
 * API grade outcome/scale mức site (không thuộc một khoá học cụ thể).
 */
export class SiteGradesController {
  constructor(private readonly grades: GradesService) {}

  @Post('outcomes')
  /**
   * POST /grades/outcomes — tạo grade outcome mức site.
   */
  async createSiteOutcome(@Body({ schema: createGradeOutcomeSchema }) dto: CreateGradeOutcomeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createOutcome(actor.id, null, dto);
  }
  @Get('outcomes')
  /**
   * GET /grades/outcomes — liệt kê grade outcome mức site.
   */
  async listSiteOutcomes() {
    return this.grades.listOutcomes();
  }
  @Post('scales')
  /**
   * POST /grades/scales — tạo scale mức site.
   */
  async createSiteScale(@Body({ schema: createGradeScaleSchema }) dto: CreateScaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createSiteScale(actor.id, dto);
  }
}
