import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AccessRepository, type RoleRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAPABILITY_DEFINITIONS, DEFAULT_ROLES } from './domain/capabilities';
import { CAP_ALLOW, CAP_INHERIT, CAP_PREVENT, CAP_PROHIBIT } from './domain/permission';

const VALID_PERMISSIONS = [CAP_PROHIBIT, CAP_PREVENT, CAP_INHERIT, CAP_ALLOW];

@Injectable()
export class RolesService {
  constructor(private readonly repo: AccessRepository, private readonly contexts: ContextsService) {}

  /** Idempotent seed: sync capability definitions from code, create the standard Moodle core roles and their archetype defaults at the system context. */
  async seedDefaults(): Promise<void> {
    const system = await this.contexts.ensureSystemContext();
    for (const def of CAPABILITY_DEFINITIONS) await this.repo.upsertCapability(def);
    for (const def of DEFAULT_ROLES) {
      let roleRow = await this.repo.getRoleByShortname(def.shortname);
      if (!roleRow) roleRow = await this.repo.insertRole({ ...def, description: '' });
      for (const capDef of CAPABILITY_DEFINITIONS) {
        const perm = capDef.archetypes[def.archetype];
        if (perm !== undefined) {
          await this.repo.upsertRoleCapability({ contextid: system.id, roleid: roleRow.id, capability: capDef.name, permission: perm });
        }
      }
    }
  }

  async createRole(input: { name: string; shortname: string; description?: string; archetype?: string }): Promise<RoleRow> {
    const shortname = input.shortname.trim().toLowerCase();
    if (await this.repo.getRoleByShortname(shortname)) {
      throw new BadRequestException({ message: `Role shortname ${shortname} already exists`, code: 'access.role_shortname_taken' });
    }
    const roles = await this.repo.listRoles();
    return this.repo.insertRole({ name: input.name, shortname, description: input.description ?? '', archetype: input.archetype, sortorder: roles.length + 1 });
  }
  async listRoles(): Promise<RoleRow[]> { return this.repo.listRoles(); }
  async getRole(id: number): Promise<RoleRow> {
    const row = await this.repo.getRoleById(id);
    if (!row) throw new NotFoundException({ message: `Role ${id} not found`, code: 'access.role_not_found' });
    return row;
  }
  async getRoleByShortname(shortname: string): Promise<RoleRow | undefined> { return this.repo.getRoleByShortname(shortname); }
  async updateRole(id: number, input: { name?: string; description?: string }): Promise<RoleRow> {
    await this.getRole(id);
    await this.repo.updateRole(id, input);
    return this.getRole(id);
  }
  async deleteRole(id: number): Promise<void> {
    await this.getRole(id);
    await this.repo.deleteRole(id);
  }

  async assignRole(userId: number, roleId: number, contextId: number, modifierId?: number): Promise<unknown> {
    await this.getRole(roleId);
    await this.contexts.getContext(contextId);
    const row = await this.repo.insertAssignment({ roleid: roleId, userid: userId, contextid: contextId, modifierid: modifierId });
    await this.contexts.markContextDirty(contextId);
    return row;
  }
  async unassignRole(assignmentId: number): Promise<void> {
    await this.repo.deleteAssignment(assignmentId);
  }
  async listAssignments(filter: { userid?: number; contextid?: number }): Promise<unknown[]> {
    return this.repo.listAssignments(filter);
  }

  /** Set (or clear, with CAP_INHERIT) a capability override for a role at a context; dirties the whole subtree. */
  async setCapabilityOverride(roleId: number, capability: string, contextId: number, permission: number, modifierId?: number): Promise<void> {
    if (!VALID_PERMISSIONS.includes(permission)) {
      throw new BadRequestException({ message: `Invalid permission ${permission}`, code: 'access.invalid_permission' });
    }
    await this.getRole(roleId);
    await this.contexts.getContext(contextId);
    if (permission === CAP_INHERIT) {
      await this.repo.deleteRoleCapability(contextId, roleId, capability);
    } else {
      await this.repo.upsertRoleCapability({ contextid: contextId, roleid: roleId, capability, permission, modifierid: modifierId });
    }
    await this.contexts.markContextDirty(contextId);
  }
  async listRoleCapabilities(roleId: number): Promise<unknown[]> {
    await this.getRole(roleId);
    return this.repo.listRoleCapabilities(roleId);
  }
  async listCapabilities(): Promise<unknown[]> { return this.repo.listCapabilities(); }
}
