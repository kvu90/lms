import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createCohortSchema, createGroupSchema, createGroupingSchema, groupMemberSchema, groupingGroupSchema, updateCohortSchema, updateGroupSchema, type CreateCohortDto, type CreateGroupDto, type CreateGroupingDto, type GroupingGroupDto, type MemberDto, type UpdateCohortDto, type UpdateGroupDto } from './dto/groups.dto';
import { GroupsService } from './groups.service';

@ApiTags('groups')
@Controller({ path: 'courses', version: '1' })
export class CourseGroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post(':courseId/groups')
  async createGroup(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGroupSchema }) dto: CreateGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.createGroup(actor.id, courseId, dto);
  }
  @Get(':courseId/groups')
  async listGroups(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.listGroups(actor.id, courseId);
  }
  @Get(':courseId/groups/visible-members')
  async visibleMembers(@Param('courseId', ParseIntPipe) courseId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.listVisibleMembers(actor.id, courseId);
  }
  @Patch(':courseId/groups/:groupId')
  async updateGroup(@Param('groupId', ParseIntPipe) groupId: number, @Body({ schema: updateGroupSchema }) dto: UpdateGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.updateGroup(actor.id, groupId, dto);
  }
  @Delete(':courseId/groups/:groupId')
  async deleteGroup(@Param('groupId', ParseIntPipe) groupId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.deleteGroup(actor.id, groupId);
    return { deleted: true };
  }
  @Post(':courseId/groups/:groupId/members')
  async addMember(@Param('groupId', ParseIntPipe) groupId: number, @Body({ schema: groupMemberSchema }) dto: MemberDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.addMember(actor.id, groupId, dto.userid);
    return { added: true };
  }
  @Delete(':courseId/groups/:groupId/members/:userId')
  async removeMember(@Param('groupId', ParseIntPipe) groupId: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.removeMember(actor.id, groupId, userId);
    return { removed: true };
  }
  @Get(':courseId/groups/:groupId/members')
  async members(@Param('groupId', ParseIntPipe) groupId: number, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.listMembers(actor.id, groupId);
  }

  @Post(':courseId/groupings')
  async createGrouping(@Param('courseId', ParseIntPipe) courseId: number, @Body({ schema: createGroupingSchema }) dto: CreateGroupingDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.createGrouping(actor.id, courseId, dto);
  }
  @Get(':courseId/groupings')
  async listGroupings(@Param('courseId', ParseIntPipe) courseId: number) {
    return this.groups.listGroupings(courseId);
  }
  @Post(':courseId/groupings/:groupingId/groups')
  async addToGrouping(@Param('groupingId', ParseIntPipe) groupingId: number, @Body({ schema: groupingGroupSchema }) dto: GroupingGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.addGroupToGrouping(actor.id, groupingId, dto.groupid);
    return { added: true };
  }
  @Get(':courseId/groupings/:groupingId/groups')
  async groupingGroups(@Param('groupingId', ParseIntPipe) groupingId: number) {
    return this.groups.groupsInGrouping(groupingId);
  }
  @Delete(':courseId/groupings/:groupingId')
  async deleteGrouping(@Param('groupingId', ParseIntPipe) groupingId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.deleteGrouping(actor.id, groupingId);
    return { deleted: true };
  }
}

@ApiTags('cohorts')
@Controller({ path: 'cohorts', version: '1' })
export class CohortsController {
  constructor(private readonly groups: GroupsService) {}

  @Post()
  async create(@Body({ schema: createCohortSchema }) dto: CreateCohortDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.createCohort(actor.id, dto);
  }
  @Get()
  async list() { return this.groups.listCohorts(); }
  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) { return this.groups.getCohort(id); }
  @Patch(':id')
  async update(@Param('id', ParseIntPipe) id: number, @Body({ schema: updateCohortSchema }) dto: UpdateCohortDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.updateCohort(actor.id, id, dto);
  }
  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.deleteCohort(actor.id, id);
    return { deleted: true };
  }
  @Get(':id/members')
  async members(@Param('id', ParseIntPipe) id: number) { return this.groups.listCohortMembers(id); }
  @Post(':id/members')
  async addMember(@Param('id', ParseIntPipe) id: number, @Body({ schema: groupMemberSchema }) dto: MemberDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.addCohortMember(actor.id, id, dto.userid);
    return { added: true };
  }
  @Delete(':id/members/:userId')
  async removeMember(@Param('id', ParseIntPipe) id: number, @Param('userId', ParseIntPipe) userId: number, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.removeCohortMember(actor.id, id, userId);
    return { removed: true };
  }
}
