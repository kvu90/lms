import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CoursesService } from '../courses/courses.service';
import { CompletionService } from './completion.service';
import {
  markCourseCriteriaCompletionSchema, markCourseSelfCompletionSchema, markManualCompletionSchema,
  setCompletionCriteriaSchema, type MarkCriteriaDto, type MarkManualDto, type MarkSelfDto, type SetCriteriaDto,
} from './dto/completion.dto';

@ApiTags('completion')
@Controller({ path: 'courses', version: '1' })
/**
 * API hoàn thành: tiến độ của tôi, tiến độ theo học viên, đánh dấu thủ công, tiêu chí và tính lại.
 */
export class CompletionController {
  constructor(
    private readonly completion: CompletionService,
    private readonly courses: CoursesService,
  ) {}

  @Get(':courseId/completion/me')
  /**
   * GET /courses/:courseId/completion/me — tiến độ hoàn thành của chính user.
   */
  async myCompletion(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, courseId);
    const activities = await this.completion.listCmCompletionsForCourse(courseId, viewer.id);
    const courseCompletion = await this.completion.getCourseCompletion(viewer.id, courseId);
    return { activities, course: courseCompletion };
  }

  @Get(':courseId/completion/users/:userId')
  /**
   * GET /courses/:courseId/completion/users/:userId — tiến độ của một học viên.
   */
  async userCompletion(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() viewer: AuthenticatedUser) {
    if (viewer.id !== userId) await this.completion.requireCompletionManage(viewer.id, courseId);
    const activities = await this.completion.listCmCompletionsForCourse(courseId, userId);
    const courseCompletion = await this.completion.getCourseCompletion(userId, courseId);
    return { activities, course: courseCompletion };
  }

  @Get(':courseId/completion')
  /**
   * GET /courses/:courseId/completion — tiến độ toàn khoá học.
   */
  async listCourseCompletions(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() viewer: AuthenticatedUser) {
    await this.completion.requireCompletionManage(viewer.id, courseId);
    return this.completion.listCourseCompletions(courseId);
  }

  @Post(':courseId/modules/:cmId/completion/manual')
  /**
   * POST /courses/:courseId/modules/:cmId/completion/manual — đánh dấu hoàn thành thủ công.
   */
  async markManual(@Param('cmId', { schema: uuidIdSchema }) cmId: string, @Body({ schema: markManualCompletionSchema }) dto: MarkManualDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.markManual(actor.id, cmId, dto.userId, dto.complete);
  }

  @Get(':courseId/completion/criteria')
  /**
   * GET /courses/:courseId/completion/criteria — bộ tiêu chí hiện tại.
   */
  async getCriteria(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.getCriteria(actor.id, courseId);
  }
  @Put(':courseId/completion/criteria')
  /**
   * PUT /courses/:courseId/completion/criteria — đặt bộ tiêu chí.
   */
  async setCriteria(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: setCompletionCriteriaSchema }) dto: SetCriteriaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.setCriteria(actor.id, courseId, dto);
  }
  @Post(':courseId/completion/recalculate')
  /**
   * POST /courses/:courseId/completion/recalculate — tính lại completion toàn khoá học.
   */
  async recalculate(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.completion.requireCompletionManage(actor.id, courseId);
    return this.completion.recalculateCourse(courseId);
  }

  @Post(':courseId/completion/self')
  /**
   * POST /courses/:courseId/completion/self — học viên tự đánh dấu/bỏ đánh
   * dấu hoàn thành khoá học (tiêu chí self của Moodle).
   */
  async markSelf(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: markCourseSelfCompletionSchema }) dto: MarkSelfDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.markSelfCompletion(actor.id, courseId, dto.complete);
  }

  @Post(':courseId/completion/criteria/:criteriaId/mark')
  /**
   * POST /courses/:courseId/completion/criteria/:criteriaId/mark — người
   * giữ vai trò của tiêu chí role đánh dấu/bỏ đánh dấu hoàn thành cho một
   * học viên (manual completion by others của Moodle).
   */
  async markCriterion(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Param('criteriaId', { schema: uuidIdSchema }) criteriaId: string, @Body({ schema: markCourseCriteriaCompletionSchema }) dto: MarkCriteriaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.markCriterionByRole(actor.id, courseId, criteriaId, dto.userId, dto.complete);
  }
}
