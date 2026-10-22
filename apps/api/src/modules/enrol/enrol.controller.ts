import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createEnrolInstanceSchema, enrolUserSchema, updateEnrolInstanceSchema, type CreateEnrolInstanceDto, type EnrolUserDto, type UpdateEnrolInstanceDto } from './dto/enrol.dto';
import { EnrolService } from './enrol.service';

@ApiTags('enrol')
@Controller({ path: 'courses', version: '1' })
export class EnrolController {
  constructor(private readonly enrol: EnrolService) {}

  @Post(':courseId/enrol/instances')
  async createInstance(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createEnrolInstanceSchema }) dto: CreateEnrolInstanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.createInstance(actor.id, courseId, dto);
  }
  @Get(':courseId/enrol/instances')
  async listInstances(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.enrol.listInstances(courseId);
  }
  @Patch(':courseId/enrol/instances/:instanceId')
  async updateInstance(@Param('instanceId', ParseIntPipe) instanceId: number, @Body({ schema: updateEnrolInstanceSchema }) dto: UpdateEnrolInstanceDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.updateInstance(actor.id, instanceId, dto);
  }
  @Delete(':courseId/enrol/instances/:instanceId')
  async deleteInstance(@Param('instanceId', ParseIntPipe) instanceId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.enrol.deleteInstance(actor.id, instanceId);
    return { deleted: true };
  }

  @Post(':courseId/enrol/instances/:instanceId/enrol')
  async enrolUser(@Param('instanceId', ParseIntPipe) instanceId: number, @Body({ schema: enrolUserSchema }) dto: EnrolUserDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.enrolUser(actor.id, instanceId, dto.userid, { timestart: dto.timestart, timeend: dto.timeend });
  }
  @Post(':courseId/enrol/instances/:instanceId/self-enrol')
  async selfEnrol(@Param('instanceId', ParseIntPipe) instanceId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.selfEnrol(actor.id, instanceId);
  }
  @Post(':courseId/enrol/instances/:instanceId/users/:userId/suspend')
  async suspend(@Param('instanceId', ParseIntPipe) instanceId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.setSuspended(actor.id, instanceId, userId, true);
  }
  @Post(':courseId/enrol/instances/:instanceId/users/:userId/reactivate')
  async reactivate(@Param('instanceId', ParseIntPipe) instanceId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.setSuspended(actor.id, instanceId, userId, false);
  }
  @Delete(':courseId/enrol/instances/:instanceId/users/:userId')
  async unenrol(@Param('instanceId', ParseIntPipe) instanceId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrol.unenrolUser(actor.id, instanceId, userId);
  }

  @Get(':courseId/enrolments')
  async listEnrolments(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.enrol.listEnrolmentsForCourse(courseId);
  }
  @Get(':courseId/enrolments/me')
  async myEnrolment(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() viewer: AuthenticatedUser) {
    return {
      courseId, userId: viewer.id,
      enrolled: await this.enrol.isEnrolled(courseId, viewer.id),
      active: await this.enrol.isEnrolled(courseId, viewer.id, { onlyActive: true }),
    };
  }
}
