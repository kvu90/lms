import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { createCohortSchema, createGroupSchema, createGroupingSchema, groupMemberSchema, groupingGroupSchema, updateCohortSchema, updateGroupSchema, type CreateCohortDto, type CreateGroupDto, type CreateGroupingDto, type GroupingGroupDto, type MemberDto, type UpdateCohortDto, type UpdateGroupDto } from './dto/groups.dto';
import { GroupsService } from './groups.service';

@ApiTags('groups')
@Controller({ path: 'courses', version: '1' })
/**
 * API nhóm trong khoá học: group, grouping và thành viên.
 */
export class CourseGroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Post(':courseId/groups')
  /**
   * POST /courses/:id/groups — tạo nhóm.
   */
  async createGroup(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGroupSchema }) dto: CreateGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.createGroup(actor.id, courseId, dto);
  }
  @Get(':courseId/groups')
  /**
   * GET /courses/:id/groups — nhóm của khoá học (đã lọc theo quyền nhìn thấy của người xem).
   */
  async listGroups(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.listGroups(actor.id, courseId);
  }
  @Get(':courseId/groups/visible-members')
  /**
   * GET /groups/:id/visible-members — thành viên được phép thấy.
   */
  async visibleMembers(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.listVisibleMembers(actor.id, courseId);
  }
  @Patch(':courseId/groups/:groupId')
  /**
   * PATCH /groups/:id — cập nhật nhóm.
   */
  async updateGroup(@Param('groupId', { schema: uuidIdSchema }) groupId: string, @Body({ schema: updateGroupSchema }) dto: UpdateGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.updateGroup(actor.id, groupId, dto);
  }
  @Delete(':courseId/groups/:groupId')
  /**
   * DELETE /groups/:id — xoá nhóm.
   */
  async deleteGroup(@Param('groupId', { schema: uuidIdSchema }) groupId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.deleteGroup(actor.id, groupId);
    return { deleted: true };
  }
  @Post(':courseId/groups/:groupId/members')
  /**
   * POST /groups/:id/members — thêm thành viên.
   */
  async addMember(@Param('groupId', { schema: uuidIdSchema }) groupId: string, @Body({ schema: groupMemberSchema }) dto: MemberDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.addMember(actor.id, groupId, dto.userid);
    return { added: true };
  }
  @Delete(':courseId/groups/:groupId/members/:userId')
  /**
   * DELETE /groups/:id/members/:userId — gỡ thành viên.
   */
  async removeMember(@Param('groupId', { schema: uuidIdSchema }) groupId: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.removeMember(actor.id, groupId, userId);
    return { removed: true };
  }
  @Get(':courseId/groups/:groupId/members')
  /**
   * GET /groups/:id/members hoặc /cohorts/:id/members — liệt kê thành viên.
   */
  async members(@Param('groupId', { schema: uuidIdSchema }) groupId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.listMembers(actor.id, groupId);
  }

  @Post(':courseId/groupings')
  /**
   * POST /courses/:id/groupings — tạo grouping.
   */
  async createGrouping(@Param('courseId', { schema: uuidIdSchema }) courseId: string, @Body({ schema: createGroupingSchema }) dto: CreateGroupingDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.createGrouping(actor.id, courseId, dto);
  }
  @Get(':courseId/groupings')
  /**
   * GET /courses/:id/groupings — liệt kê grouping.
   */
  async listGroupings(@Param('courseId', { schema: uuidIdSchema }) courseId: string) {
    return this.groups.listGroupings(courseId);
  }
  @Post(':courseId/groupings/:groupingId/groups')
  /**
   * POST /groupings/:id/groups — đưa nhóm vào grouping.
   */
  async addToGrouping(@Param('groupingId', { schema: uuidIdSchema }) groupingId: string, @Body({ schema: groupingGroupSchema }) dto: GroupingGroupDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.addGroupToGrouping(actor.id, groupingId, dto.groupid);
    return { added: true };
  }
  @Get(':courseId/groupings/:groupingId/groups')
  /**
   * GET /groupings/:id/groups — nhóm thuộc grouping.
   */
  async groupingGroups(@Param('groupingId', { schema: uuidIdSchema }) groupingId: string) {
    return this.groups.groupsInGrouping(groupingId);
  }
  @Delete(':courseId/groupings/:groupingId')
  /**
   * DELETE /groupings/:id — xoá grouping.
   */
  async deleteGrouping(@Param('groupingId', { schema: uuidIdSchema }) groupingId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.deleteGrouping(actor.id, groupingId);
    return { deleted: true };
  }
}

@ApiTags('cohorts')
@Controller({ path: 'cohorts', version: '1' })
/**
 * API cohort: cohort hệ thống/danh mục và thành viên của chúng.
 */
export class CohortsController {
  constructor(private readonly groups: GroupsService) {}

  @Post()
  /**
   * POST /cohorts — tạo cohort.
   */
  async create(@Body({ schema: createCohortSchema }) dto: CreateCohortDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.createCohort(actor.id, dto);
  }
  @Get()
  /**
   * GET /cohorts — liệt kê cohort.
   */
  async list() { return this.groups.listCohorts(); }
  @Get(':id')
  /**
   * GET /cohorts/:id — chi tiết cohort.
   */
  async get(@Param('id', { schema: uuidIdSchema }) id: string) { return this.groups.getCohort(id); }
  @Patch(':id')
  /**
   * PATCH /cohorts/:id — cập nhật cohort.
   */
  async update(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateCohortSchema }) dto: UpdateCohortDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.groups.updateCohort(actor.id, id, dto);
  }
  @Delete(':id')
  /**
   * DELETE /cohorts/:id — xoá cohort.
   */
  async remove(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.deleteCohort(actor.id, id);
    return { deleted: true };
  }
  @Get(':id/members')
  /** GET /cohorts/:id/members — thành viên của cohort. */
  async members(@Param('id', { schema: uuidIdSchema }) id: string) { return this.groups.listCohortMembers(id); }
  @Post(':id/members')
  /** POST /cohorts/:id/members — thêm thành viên cohort (kích hoạt cohort sync). */
  async addMember(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: groupMemberSchema }) dto: MemberDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.addCohortMember(actor.id, id, dto.userid);
    return { added: true };
  }
  @Delete(':id/members/:userId')
  /** DELETE /cohorts/:id/members/:userId — gỡ thành viên cohort. */
  async removeMember(@Param('id', { schema: uuidIdSchema }) id: string, @Param('userId', { schema: uuidIdSchema }) userId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.groups.removeCohortMember(actor.id, id, userId);
    return { removed: true };
  }
}
