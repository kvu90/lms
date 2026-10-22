import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { AccessRepository } from './access.repository';
import { ContextsService } from './contexts.service';
import { aggregateRoleResults, evaluateSingleRole, type RoleOverridePoint } from './domain/permission';

/**
 * PermissionEvaluator — the single source of truth for Moodle capability
 * semantics (report §3.3). NOT CASL, NOT JWT claims: results are computed
 * from context tree + role assignments + overrides, cached in the
 * application-mode cache under a key that embeds the path version stamp, so
 * dirty-marking a context (version bump) lazily invalidates its subtree.
 */
@Injectable()
export class PermissionEvaluator {
  constructor(
    private readonly repo: AccessRepository,
    private readonly contexts: ContextsService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Site admins ($CFG->siteadmins equivalent, config key `siteadmins`) bypass every capability check. */
  async isSiteAdmin(userId: number): Promise<boolean> {
    const raw = await this.repo.getConfigValue('siteadmins');
    if (!Array.isArray(raw)) return false;
    return raw.map(Number).includes(userId);
  }
  async listSiteAdmins(): Promise<number[]> {
    const raw = await this.repo.getConfigValue('siteadmins');
    return Array.isArray(raw) ? raw.map(Number) : [];
  }
  async setSiteAdmins(userIds: number[]): Promise<void> {
    await this.repo.setConfigValue('siteadmins', userIds);
  }

  async hasCapability(userId: number, capability: string, contextId: number, opts?: { isGuest?: boolean }): Promise<boolean> {
    if (await this.isSiteAdmin(userId)) return true;
    const target = await this.contexts.getContext(contextId);
    const pathContexts = await this.contexts.getPathContexts(target);
    const stamp = this.contexts.pathVersionStamp(pathContexts);
    const cacheKey = `access:${userId}:${capability}:${contextId}:${stamp}:${opts?.isGuest ? 'g' : 'u'}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached !== undefined && cached !== null) return cached;
    const result = await this.evaluate(userId, capability, pathContexts, opts);
    await this.cache.set(cacheKey, result, 60 * 60 * 1000);
    return result;
  }

  private async evaluate(userId: number, capability: string, pathContexts: { id: number }[], opts?: { isGuest?: boolean }): Promise<boolean> {
    const pathIds = pathContexts.map((c) => c.id); // leaf → root
    const assignments = await this.repo.getAssignmentsForUserInContexts(userId, pathIds);
    const roleIds = new Set<number>(assignments.map((a) => a.roleid));
    // Moodle adds virtual default-role assignments: `user` for any logged-in
    // user, `guest` for the guest account — both anchored at the system context.
    const systemId = pathIds[pathIds.length - 1];
    const defaultRole = await this.repo.getRoleByShortname(opts?.isGuest ? 'guest' : 'user');
    if (defaultRole && systemId !== undefined) roleIds.add(defaultRole.id);
    if (roleIds.size === 0) return false;

    const overrides = await this.repo.getOverridesForRoles([...roleIds], capability, pathIds);
    const roleResults: number[] = [];
    for (const roleId of roleIds) {
      const points: RoleOverridePoint[] = [];
      for (const contextId of pathIds) {
        const o = overrides.find((x) => x.roleid === roleId && x.contextid === contextId);
        if (o) points.push({ contextId, permission: o.permission });
      }
      roleResults.push(evaluateSingleRole(points));
    }
    return aggregateRoleResults(roleResults);
  }

  async requireCapability(userId: number, capability: string, contextId: number, opts?: { isGuest?: boolean }): Promise<void> {
    if (!(await this.hasCapability(userId, capability, contextId, opts))) {
      throw new ForbiddenException({ message: `Missing capability ${capability} in context ${contextId}`, code: 'access.capability_denied' });
    }
  }
}
