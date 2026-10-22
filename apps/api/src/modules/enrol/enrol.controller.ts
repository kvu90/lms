import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createEnrolInstanceSchema, enrolUserSchema, updateEnrolInstanceSchema, type CreateEnrolInstanceDto, type EnrolUserDto, type UpdateEnrolInstanceDto } from './dto/enrol.dto';
import { EnrolService } from './enrol.service';

@ApiTags('enrol')
@Controller({ path: 'courses', version: '1' })
/**
 * API ghi danh: enrol instance, ghi danh thủ công/tự ghi danh, đình chỉ và rút.
 */
export class EnrolController {
  constructor(private readonly enrol: EnrolService) {}

  @Post(':courseId/enrol/instances')
  /**
   * POST /courses/:id/enrol-instances — tạo phương thức ghi danh.
   */
  async createInstance(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createEnrolInstanceSchema }) dto: CreateEnrolInstanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.createInstance(actor.id, courseId, dto);
  }
  @Get(':courseId/enrol/instances')
  /**
   * GET /courses/:id/enrol-instances — liệt kê phương thức.
   */
  async listInstances(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.enrol.listInstances(courseId);
  }
  @Patch(':courseId/enrol/instances/:instanceId')
  /**
   * PATCH /enrol-instances/:id — cập nhật phương thức.
   */
  async updateInstance(@Param('instanceId', ParseIntPipe) instanceId: number, @Body({ schema: updateEnrolInstanceSchema }) dto: UpdateEnrolInstanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.updateInstance(actor.id, instanceId, dto);
  }
  @Delete(':courseId/enrol/instances/:instanceId')
  /**
   * DELETE /enrol-instances/:id — xoá phương thức.
   */
  async deleteInstance(@Param('instanceId', ParseIntPipe) instanceId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.enrol.deleteInstance(actor.id, instanceId);
    return { deleted: true };
  }

  @Post(':courseId/enrol/instances/:instanceId/enrol')
  /**
   * POST /courses/:id/enrol — ghi danh thủ công.
   */
  async enrolUser(@Param('instanceId', ParseIntPipe) instanceId: number, @Body({ schema: enrolUserSchema }) dto: EnrolUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.enrolUser(actor.id, instanceId, dto.userid, { timestart: dto.timestart, timeend: dto.timeend });
  }
  @Post(':courseId/enrol/instances/:instanceId/self-enrol')
  /**
   * POST /courses/:id/self-enrol — tự ghi danh (có thể cần khoá ghi danh).
   */
  async selfEnrol(@Param('instanceId', ParseIntPipe) instanceId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.selfEnrol(actor.id, instanceId);
  }
  @Post(':courseId/enrol/instances/:instanceId/users/:userId/suspend')
  /**
   * POST /enrolments/:id/suspend — đình chỉ ghi danh.
   */
  async suspend(@Param('instanceId', ParseIntPipe) instanceId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.setSuspended(actor.id, instanceId, userId, true);
  }
  @Post(':courseId/enrol/instances/:instanceId/users/:userId/reactivate')
  /**
   * POST /enrolments/:id/reactivate — kích hoạt lại ghi danh.
   */
  async reactivate(@Param('instanceId', ParseIntPipe) instanceId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.setSuspended(actor.id, instanceId, userId, false);
  }
  @Delete(':courseId/enrol/instances/:instanceId/users/:userId')
  /**
   * DELETE /enrolments/:id — rút ghi danh.
   */
  async unenrol(@Param('instanceId', ParseIntPipe) instanceId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.unenrolUser(actor.id, instanceId, userId);
  }

  @Get(':courseId/enrolments')
  /**
   * GET /courses/:id/enrolments — ghi danh của khoá học.
   */
  async listEnrolments(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.enrol.listEnrolmentsForCourse(courseId);
  }
  @Get(':courseId/enrolments/me')
  /**
   * GET /courses/:id/my-enrolment — ghi danh của chính user hiện tại.
   */
  async myEnrolment(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() viewer: AuthenticatedUser) {
    return {
      courseId, userId: viewer.id,
      enrolled: await this.enrol.isEnrolled(courseId, viewer.id),
      active: await this.enrol.isEnrolled(courseId, viewer.id, { onlyActive: true }),
    };
  }
}
