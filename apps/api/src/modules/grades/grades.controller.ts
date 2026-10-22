import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { GradesService } from './grades.service';
import { createGradeCategorySchema, createGradeItemSchema, createGradeScaleSchema, setGradeLettersSchema, setGradeSchema, updateGradeCategorySchema, updateGradeItemSchema, updateGradeSchema, type CreateGradeCategoryDto, type CreateGradeItemDto, type CreateScaleDto, type SetGradeDto, type SetLettersDto, type UpdateGradeCategoryDto, type UpdateGradeDto, type UpdateGradeItemDto } from './dto/grades.dto';

@ApiTags('grades')
@Controller({ path: 'courses', version: '1' })
export class GradesController {
  constructor(private readonly grades: GradesService) {}

  @Post(':courseId/grades/categories')
  async createCategory(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGradeCategorySchema }) dto: CreateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createCategory(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/categories')
  async listCategories(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.listCategories(courseId);
  }
  @Patch('grades/categories/:categoryId')
  async updateCategory(@Param('categoryId', ParseIntPipe) categoryId: number, @Body({ schema: updateGradeCategorySchema }) dto: UpdateGradeCategoryDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateCategory(actor.id, categoryId, dto);
  }
  @Delete('grades/categories/:categoryId')
  async deleteCategory(@Param('categoryId', ParseIntPipe) categoryId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteCategory(actor.id, categoryId);
    return { deleted: true };
  }

  @Post(':courseId/grades/items')
  async createItem(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGradeItemSchema }) dto: CreateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createItem(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/items')
  async listItems(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.listItems(courseId);
  }
  @Patch('grades/items/:itemId')
  async updateItem(@Param('itemId', ParseIntPipe) itemId: number, @Body({ schema: updateGradeItemSchema }) dto: UpdateGradeItemDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateItem(actor.id, itemId, dto);
  }
  @Delete('grades/items/:itemId')
  async deleteItem(@Param('itemId', ParseIntPipe) itemId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.grades.deleteItem(actor.id, itemId);
    return { deleted: true };
  }

  @Post('grades/items/:itemId/grades')
  async setGrade(@Param('itemId', ParseIntPipe) itemId: number, @Body({ schema: setGradeSchema }) dto: SetGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setGrade(actor.id, itemId, dto.userid, dto);
  }
  @Patch('grades/grades/:gradeId')
  async updateGrade(@Param('gradeId', ParseIntPipe) gradeId: number, @Body({ schema: updateGradeSchema }) dto: UpdateGradeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.updateGrade(actor.id, gradeId, dto);
  }
  @Get('grades/items/:itemId/users/:userId/history')
  async history(@Param('itemId', ParseIntPipe) itemId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    const item = await this.grades.getItem(itemId);
    if (actor.id !== userId) {
      // History of another user requires moodle/grade:viewall at the course context.
      await this.grades.getReport(actor.id, item.courseid);
    }
    return this.grades.listHistory(itemId, userId);
  }

  @Get(':courseId/gradebook')
  async gradebook(@Param('courseId', ParseIntPipe) courseId: number, @Query('userid') userid: string | undefined, @CurrentUser() viewer: AuthenticatedUser) {
    const target = userid ? Number(userid) : viewer.id;
    return this.grades.getGradebook(viewer.id, courseId, target);
  }
  @Get(':courseId/grades/report')
  async report(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() viewer: AuthenticatedUser) {
    return this.grades.getReport(viewer.id, courseId);
  }
  @Post(':courseId/grades/regrade')
  async regrade(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.triggerRegrade(actor.id, courseId);
  }

  @Get(':courseId/grades/letters')
  async letters(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.getLetters(courseId);
  }
  @Put(':courseId/grades/letters')
  async setLetters(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: setGradeLettersSchema }) dto: SetLettersDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.setLetters(actor.id, courseId, dto.letters);
  }

  @Post(':courseId/grades/scales')
  async createScale(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGradeScaleSchema }) dto: CreateScaleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.grades.createScale(actor.id, courseId, dto);
  }
  @Get(':courseId/grades/scales')
  async scales(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.grades.listScales(courseId);
  }
}
