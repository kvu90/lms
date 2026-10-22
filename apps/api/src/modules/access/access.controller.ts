import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../../common/current-user.decorator';
import { RequireCapability } from '../../common/require-capability.decorator';
import { ContextsService } from './contexts.service';
import { assignRoleSchema, createContextSchema, createRoleSchema, hasCapabilityQueryServerSchema, overrideCapabilitySchema, updateRoleSchema, type AssignRoleDto, type CreateContextDto, type CreateRoleDto, type HasCapabilityQueryDto, type OverrideCapabilityDto, type UpdateRoleDto } from './dto/access.dto';
import { PermissionEvaluator } from './permission-evaluator.service';
import { RolesService } from './roles.service';

@ApiTags('access')
@Controller({ path: 'access', version: '1' })
export class AccessController {
  constructor(
    private readonly contexts: ContextsService,
    private readonly roles: RolesService,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  @Post('contexts')
  @RequireCapability('moodle/site:config')
  async createContext(@Body({ schema: createContextSchema }) dto: CreateContextDto) {
    return this.contexts.createContext(dto.contextlevel, dto.instanceid, dto.parentId);
  }
  @Get('contexts')
  @RequireCapability('moodle/role:manage')
  async listContexts() { return this.contexts.listContexts(); }
  @Get('contexts/:id')
  @RequireCapability('moodle/role:manage')
  async getContext(@Param('id', ParseIntPipe) id: number) { return this.contexts.getContext(id); }

  @Post('roles')
  @RequireCapability('moodle/role:manage')
  async createRole(@Body({ schema: createRoleSchema }) dto: CreateRoleDto) { return this.roles.createRole(dto); }
  @Get('roles')
  @RequireCapability('moodle/role:manage')
  async listRoles() { return this.roles.listRoles(); }
  @Get('roles/:id')
  @RequireCapability('moodle/role:manage')
  async getRole(@Param('id', ParseIntPipe) id: number) { return this.roles.getRole(id); }
  @Patch('roles/:id')
  @RequireCapability('moodle/role:manage')
  async updateRole(@Param('id', ParseIntPipe) id: number, @Body({ schema: updateRoleSchema }) dto: UpdateRoleDto) { return this.roles.updateRole(id, dto); }
  @Delete('roles/:id')
  @RequireCapability('moodle/role:manage')
  async deleteRole(@Param('id', ParseIntPipe) id: number) { await this.roles.deleteRole(id); return { deleted: true }; }

  @Get('capabilities')
  @RequireCapability('moodle/role:manage')
  async listCapabilities() { return this.roles.listCapabilities(); }
  @Get('roles/:id/capabilities')
  @RequireCapability('moodle/role:manage')
  async listRoleCapabilities(@Param('id', ParseIntPipe) id: number) { return this.roles.listRoleCapabilities(id); }

  @Post('assignments')
  @RequireCapability('moodle/role:assign')
  async assign(@Body({ schema: assignRoleSchema }) dto: AssignRoleDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.roles.assignRole(dto.userid, dto.roleid, dto.contextid, actor.id);
  }
  @Get('assignments')
  @RequireCapability('moodle/role:assign')
  async listAssignments(@Query('userid') userid?: string, @Query('contextid') contextid?: string) {
    return this.roles.listAssignments({ userid: userid ? Number(userid) : undefined, contextid: contextid ? Number(contextid) : undefined });
  }
  @Delete('assignments/:id')
  @RequireCapability('moodle/role:assign')
  async unassign(@Param('id', ParseIntPipe) id: number) { await this.roles.unassignRole(id); return { deleted: true }; }

  @Post('overrides')
  @RequireCapability('moodle/role:override', 'body:contextId')
  async override(@Body({ schema: overrideCapabilitySchema }) dto: OverrideCapabilityDto, @CurrentUser() actor: AuthenticatedUser) {
    await this.roles.setCapabilityOverride(dto.roleid, dto.capability, dto.contextid, dto.permission, actor.id);
    return { updated: true };
  }

  /** Debug/admin probe: what does the evaluator say for (user, capability, context)? */
  @Get('has-capability')
  @RequireCapability('moodle/role:manage')
  async hasCapability(@Query({ schema: hasCapabilityQueryServerSchema }) query: HasCapabilityQueryDto) {
    const allowed = await this.evaluator.hasCapability(Number(query.userid), query.capability, Number(query.contextid));
    return { userid: Number(query.userid), capability: query.capability, contextid: Number(query.contextid), allowed };
  }
}
