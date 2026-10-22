import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { CoursesService } from '../courses/courses.service';
import { CompletionService } from './completion.service';
import { MarkManualDto, SetCriteriaDto } from './dto/completion.dto';

@ApiTags('completion')
@Controller({ path: 'courses', version: '1' })
export class CompletionController {
  constructor(
    private readonly completion: CompletionService,
    private readonly courses: CoursesService,
  ) {}

  @Get(':courseId/completion/me')
  async myCompletion(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() viewer: AuthenticatedUser) {
    await this.courses.assertCourseAccess(viewer.id, courseId);
    const activities = await this.completion.listCmCompletionsForCourse(courseId, viewer.id);
    const courseCompletion = await this.completion.getCourseCompletion(viewer.id, courseId);
    return { activities, course: courseCompletion };
  }

  @Get(':courseId/completion/users/:userId')
  async userCompletion(@Param('courseId', ParseIntPipe) courseId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() viewer: AuthenticatedUser) {
    if (viewer.id !== userId) await this.completion.requireCompletionManage(viewer.id, courseId);
    const activities = await this.completion.listCmCompletionsForCourse(courseId, userId);
    const courseCompletion = await this.completion.getCourseCompletion(userId, courseId);
    return { activities, course: courseCompletion };
  }

  @Get(':courseId/completion')
  async listCourseCompletions(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() viewer: AuthenticatedUser) {
    await this.completion.requireCompletionManage(viewer.id, courseId);
    return this.completion.listCourseCompletions(courseId);
  }

  @Post(':courseId/modules/:cmId/completion/manual')
  async markManual(@Param('cmId', ParseIntPipe) cmId: number, @Body() dto: MarkManualDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.markManual(actor.id, cmId, dto.userid, dto.complete);
  }

  @Get(':courseId/completion/criteria')
  async getCriteria(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.completion.getCriteria(courseId);
  }
  @Put(':courseId/completion/criteria')
  async setCriteria(@Param('courseId', ParseIntPipe) courseId: number, @Body() dto: SetCriteriaDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.completion.setCriteria(actor.id, courseId, dto);
  }
  @Post(':courseId/completion/recalculate')
  async recalculate(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.completion.requireCompletionManage(actor.id, courseId);
    return this.completion.recalculateCourse(courseId);
  }
}
