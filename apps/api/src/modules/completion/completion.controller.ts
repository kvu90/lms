import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CoursesService } from '../courses/courses.service';
import { CompletionService } from './completion.service';
import { markManualCompletionSchema, setCompletionCriteriaSchema, type MarkManualDto, type SetCriteriaDto } from './dto/completion.dto';

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
    return this.completion.markManual(actor.id, cmId, dto.userid, dto.complete);
  }

  @Get(':courseId/completion/criteria')
  /**
   * GET /courses/:courseId/completion/criteria — bộ tiêu chí hiện tại.
   */
  async getCriteria(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.completion.getCriteria(courseId);
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
}
