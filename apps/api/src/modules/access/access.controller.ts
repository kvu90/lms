import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { uuidIdSchema } from '@lms/contracts';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { ContextsService } from './contexts.service';
import { assignRoleSchema, createContextSchema, createRoleSchema, hasCapabilityQueryServerSchema, overrideCapabilitySchema, updateRoleSchema, type AssignRoleDto, type CreateContextDto, type CreateRoleDto, type HasCapabilityQueryDto, type OverrideCapabilityDto, type UpdateRoleDto } from './dto/access.dto';
import { PermissionEvaluator } from './permission-evaluator.service';
import { RolesService } from './roles.service';

@ApiTags('access')
@Controller({ path: 'access', version: '1' })
/**
 * API quản trị phân quyền: context, role, capability, gán role và kiểm tra quyền.
 * Mọi endpoint đều qua PermissionEvaluator với capability moodle/role:* tại context hệ thống.
 */
export class AccessController {
  constructor(
    private readonly contexts: ContextsService,
    private readonly roles: RolesService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  @Post('contexts')
  @RequireCapability('site:config')
  /**
   * POST /access/contexts — tạo context mới dưới context cha.
   */
  async createContext(@Body({ schema: createContextSchema }) dto: CreateContextDto) {
    return this.contexts.createContext(dto.contextLevel, dto.instanceId, dto.parentId);
  }
  @Get('contexts')
  @RequireCapability('role:manage')
  /**
   * GET /access/contexts — liệt kê cây context.
   */
  async listContexts() { return this.contexts.listContexts(); }
  @Get('contexts/:id')
  @RequireCapability('role:manage')
  /**
   * GET /access/contexts/:id — chi tiết một context.
   */
  async getContext(@Param('id', { schema: uuidIdSchema }) id: string) { return this.contexts.getContext(id); }

  @Post('roles')
  @RequireCapability('role:manage')
  /**
   * POST /access/roles — tạo role mới.
   */
  async createRole(@Body({ schema: createRoleSchema }) dto: CreateRoleDto) { return this.roles.createRole(dto); }
  @Get('roles')
  @RequireCapability('role:manage')
  /**
   * GET /access/roles — liệt kê role.
   */
  async listRoles() { return this.roles.listRoles(); }
  @Get('roles/:id')
  @RequireCapability('role:manage')
  /**
   * GET /access/roles/:id — chi tiết role.
   */
  async getRole(@Param('id', { schema: uuidIdSchema }) id: string) { return this.roles.getRole(id); }
  @Patch('roles/:id')
  @RequireCapability('role:manage')
  /**
   * PATCH /access/roles/:id — cập nhật role.
   */
  async updateRole(@Param('id', { schema: uuidIdSchema }) id: string, @Body({ schema: updateRoleSchema }) dto: UpdateRoleDto) { return this.roles.updateRole(id, dto); }
  @Delete('roles/:id')
  @RequireCapability('role:manage')
  /**
   * DELETE /access/roles/:id — xoá role.
   */
  async deleteRole(@Param('id', { schema: uuidIdSchema }) id: string) { await this.roles.deleteRole(id); return { deleted: true }; }

  @Get('capabilities')
  @RequireCapability('role:manage')
  /**
   * GET /access/capabilities — liệt kê capability đã khai báo.
   */
  async listCapabilities() { return this.roles.listCapabilities(); }
  @Get('roles/:id/capabilities')
  @RequireCapability('role:manage')
  /**
   * GET /access/roles/:id/capabilities — ma trận override đã lưu của role.
   */
  async listRoleCapabilities(@Param('id', { schema: uuidIdSchema }) id: string) { return this.roles.listRoleCapabilities(id); }

  @Post('assignments')
  @RequireCapability('role:assign')
  /**
   * POST /access/assignments — gán role cho user tại context.
   */
  async assign(@Body({ schema: assignRoleSchema }) dto: AssignRoleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.roles.assignRole(dto.userId, dto.roleId, dto.contextId, actor.id);
  }
  @Get('assignments')
  @RequireCapability('role:assign')
  /**
   * GET /access/assignments — liệt kê gán role.
   */
  async listAssignments(@Query('userId') userId?: string, @Query('contextId') contextId?: string) {
    return this.roles.listAssignments({ userId: userId || undefined, contextId: contextId || undefined });
  }
  @Delete('assignments/:id')
  @RequireCapability('role:assign')
  /**
   * DELETE /access/assignments/:id — gỡ gán role.
   */
  async unassign(@Param('id', { schema: uuidIdSchema }) id: string, @CurrentUser() actor: AuthenticatedUser) { await this.roles.unassignRole(id, actor.id); return { deleted: true }; }

  @Post('overrides')
  @RequireCapability('role:override', 'body:contextId')
  /**
   * POST /access/overrides — đặt override capability cho role tại context.
   */
  async override(@Body({ schema: overrideCapabilitySchema }) dto: OverrideCapabilityDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.roles.setCapabilityOverride(dto.roleId, dto.capability, dto.contextId, dto.permission, actor.id);
    return { updated: true };
  }

  /** Debug/admin probe: what does the evaluator say for (user, capability, context)? */
  @Get('has-capability')
  @RequireCapability('role:manage')
  /**
   * GET /access/has-capability — kiểm tra capability của một user tại context (dùng cho client và kiểm chứng).
   */
  async hasCapability(@Query({ schema: hasCapabilityQueryServerSchema }) query: HasCapabilityQueryDto) {
    const allowed = await this.evaluator.hasCapability(query.userId, query.capability, query.contextId);
    return { userId: query.userId, capability: query.capability, contextId: query.contextId, allowed };
  }
}
