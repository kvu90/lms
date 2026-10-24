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
/**
 * Trái tim phân quyền kiểu Moodle: quyết định user có capability tại một context hay không.
 * Quy tắc (đối chiếu lib/accesslib.php has_capability): duyệt cây context từ lá lên gốc;
 * tại mỗi context, gộp override của mọi role user được gán ở context đó và các context tổ tiên;
 * PROHIBIT ở bất kỳ đâu thắng tuyệt đối, PREVENT thắng ALLOW ở cùng/cao hơn theo thứ tự duyệt,
 * quyền chỉ được cấp khi có ít nhất một ALLOW còn hiệu lực. Site admin bỏ qua mọi kiểm tra.
 */
export class PermissionEvaluator {
  constructor(
    private readonly repo: AccessRepository,
    private readonly contexts: ContextsService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
  ) {}

  /** Site admins ($CFG->siteadmins equivalent, config key `siteadmins`) bypass every capability check. */
  /**
   * User có nằm trong danh sách site admin (config siteadmins) hay không — admin bỏ qua mọi capability check.
   */
  async isSiteAdmin(userId: string): Promise<boolean> {
    const raw = await this.repo.getConfigValue('siteadmins');
    if (!Array.isArray(raw)) return false;
    return raw.map((v) => String(v)).includes(userId);
  }
  /**
   * Danh sách id site admin hiện tại.
   */
  async listSiteAdmins(): Promise<string[]> {
    const raw = await this.repo.getConfigValue('siteadmins');
    return Array.isArray(raw) ? raw.map((v) => String(v)) : [];
  }
  /**
   * Thay danh sách site admin (lưu vào config).
   */
  async setSiteAdmins(userIds: string[]): Promise<void> {
    await this.repo.setConfigValue('siteadmins', userIds);
  }

  /**
   * Đánh giá capability cho user tại context theo thuật toán cây context; kết quả có thể cache theo path version.
   */
  async hasCapability(userId: string, capability: string, contextId: string, opts?: { isGuest?: boolean }): Promise<boolean> {
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

  private async evaluate(userId: string, capability: string, pathContexts: { id: string }[], opts?: { isGuest?: boolean }): Promise<boolean> {
    const pathIds = pathContexts.map((c) => c.id); // leaf → root
    const assignments = await this.repo.getAssignmentsForUserInContexts(userId, pathIds);
    const roleIds = new Set<string>(assignments.map((a) => a.roleId));
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
        const o = overrides.find((x) => x.roleId === roleId && x.contextId === contextId);
        if (o) points.push({ contextId, permission: o.permission });
      }
      roleResults.push(evaluateSingleRole(points));
    }
    return aggregateRoleResults(roleResults);
  }

  /**
   * Capability check over REAL role assignments only (no virtual
   * user/guest default roles), optionally ignoring assignments of given
   * archetypes. Enrol uses this for the enrol gate's exception (report §2#5):
   * a suspended enrolment still blocks a user whose only path to
   * `course:view` is the student role the enrolment itself granted,
   * while a genuine staff assignment (teacher/manager/…) still lets them in.
   */
  /**
   * Như hasCapability nhưng chỉ tính gán role thật, bỏ qua lối tắt site admin — dùng cho các luồng cần phân biệt (vd login-as).
   */
  async hasCapabilityFromRealAssignment(
    userId: string,
    capability: string,
    contextId: string,
    opts?: { excludeArchetypes?: string[] },
  ): Promise<boolean> {
    if (await this.isSiteAdmin(userId)) return true;
    const target = await this.contexts.getContext(contextId);
    const pathContexts = await this.contexts.getPathContexts(target);
    const pathIds = pathContexts.map((c) => c.id);
    const assignments = await this.repo.getAssignmentsForUserInContexts(userId, pathIds);
    const roleIds = new Set<string>();
    for (const a of assignments) {
      if (opts?.excludeArchetypes?.length) {
        const roleRow = await this.repo.getRoleById(a.roleId);
        if (roleRow?.archetype && opts.excludeArchetypes.includes(roleRow.archetype)) continue;
      }
      roleIds.add(a.roleId);
    }
    if (roleIds.size === 0) return false;
    const overrides = await this.repo.getOverridesForRoles([...roleIds], capability, pathIds);
    const roleResults: number[] = [];
    for (const roleId of roleIds) {
      const points: RoleOverridePoint[] = [];
      for (const cid of pathIds) {
        const o = overrides.find((x) => x.roleId === roleId && x.contextId === cid);
        if (o) points.push({ contextId: cid, permission: o.permission });
      }
      roleResults.push(evaluateSingleRole(points));
    }
    return aggregateRoleResults(roleResults);
  }

  /**
   * Như hasCapability nhưng ném Forbidden (access.forbidden) khi không đạt — cổng chặn chuẩn của các service.
   */
  async requireCapability(userId: string, capability: string, contextId: string, opts?: { isGuest?: boolean }): Promise<void> {
    if (!(await this.hasCapability(userId, capability, contextId, opts))) {
      throw new ForbiddenException({ message: `Missing capability ${capability} in context ${contextId}`, code: 'access.capability_denied' });
    }
  }
}
