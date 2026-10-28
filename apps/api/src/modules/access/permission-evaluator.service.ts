import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { AccessRepository, type ContextRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAPABILITY_DEFINITIONS, CONTEXT_LEVELS } from './domain/capabilities';
import { aggregateRoleResults, evaluateSingleRole, type RoleOverridePoint } from './domain/permission';

/** Kết quả cổng tenant: `allowed=false` = chặn tuyệt đối; `assignmentScope` = tập context mà gán vai được tính (null = không thu hẹp). */
interface TenantGate {
  allowed: boolean;
  assignmentScope: Set<string> | null;
}

/**
 * PermissionEvaluator — nguồn sự thật duy nhất cho ngữ nghĩa capability của Moodle
 * (report §3.3). KHÔNG phải CASL, KHÔNG phải JWT claims: kết quả được tính
 * từ cây context + gán role + overrides, cache trong
 * cache chế độ application dưới một khoá nhúng dấu version của path, nên
 * việc đánh dấu một context là dirty (tăng version) sẽ làm mất hiệu lực lười cây con của nó.
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

  /** Site admin (tương đương $CFG->siteadmins, khoá config `siteadmins`) bỏ qua mọi kiểm tra capability. */
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
   * Cổng tenant (TENANT-0, #168 — hồ sơ mục 3.2/4.3): khi context đích
   * nằm trong cây của một tenant `school`/`center` thì (1) user phải có
   * membership `active` ở tenant đó — cổng chạy TRƯỚC lối tắt site admin
   * vì platform admin KHÔNG có quyền ngầm trong tenant (vào tenant qua
   * loginas có lý do + audit, hoặc được gán vai như người thường khi đã
   * là thành viên); (2) chỉ gán vai neo TRONG cây tenant mới hiệu lực —
   * gán vai ở context hệ thống không chảy vào tenant (định nghĩa role +
   * archetype defaults vẫn toàn cục như Moodle). Tenant-zero
   * (kind `platform`) là không gian của chính platform nên không cổng,
   * không thu hẹp — hành vi cũ giữ nguyên. Đổi trạng thái membership
   * phải markContextDirty(context tenant) để cache cũ hết hiệu lực.
   */
  private async tenantGate(userId: string, pathContexts: ContextRow[]): Promise<TenantGate> {
    const tenantCtx = pathContexts.find((c) => c.contextLevel === CONTEXT_LEVELS.TENANT);
    if (!tenantCtx?.instanceId) return { allowed: true, assignmentScope: null };
    const info = await this.repo.getTenantGateInfo(tenantCtx.instanceId);
    if (!info || (info.kind !== 'school' && info.kind !== 'center')) return { allowed: true, assignmentScope: null };
    // Tenant đã khoá (suspended) hoặc lưu trữ (archived) thì không ai còn
    // quyền trong cây của nó — kể cả thành viên.
    if (info.status !== 'active') return { allowed: false, assignmentScope: null };
    const status = await this.repo.getMembershipStatus(tenantCtx.instanceId, userId);
    if (status !== 'active') return { allowed: false, assignmentScope: null };
    const scope = new Set(
      pathContexts.filter((c) => c.path.startsWith(tenantCtx.path)).map((c) => c.id),
    );
    return { allowed: true, assignmentScope: scope };
  }

  /**
   * Đánh giá capability cho user tại context theo thuật toán cây context; kết quả có thể cache theo path version.
   *
   * TENANT-1 (#196, điểm N2): bên trong cây của tenant school/center
   * (cổng tenant đã thu hẹp assignmentScope), lối tắt site admin KHÔNG
   * áp dụng — platform không có quyền ngầm trong tenant: site admin ở
   * trong tenant là người thường, chỉ gán vai thật neo trong cây tenant
   * mới sinh quyền (muốn hỗ trợ thì gán vai như người thường, hoặc
   * loginas có lý do + audit). Ngoài cây tenant (context hệ thống,
   * tenant-zero) lối tắt giữ nguyên như cũ.
   */
  async hasCapability(userId: string, capability: string, contextId: string, opts?: { isGuest?: boolean }): Promise<boolean> {
    const target = await this.contexts.getContext(contextId);
    const pathContexts = await this.contexts.getPathContexts(target);
    const gate = await this.tenantGate(userId, pathContexts);
    if (!gate.allowed) return false;
    if (gate.assignmentScope === null && (await this.isSiteAdmin(userId))) return true;
    const stamp = this.contexts.pathVersionStamp(pathContexts);
    const cacheKey = `access:${userId}:${capability}:${contextId}:${stamp}:${opts?.isGuest ? 'g' : 'u'}`;
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached !== undefined && cached !== null) return cached;
    const result = await this.evaluate(userId, capability, pathContexts, opts, gate.assignmentScope);
    await this.cache.set(cacheKey, result, 60 * 60 * 1000);
    return result;
  }

  private async evaluate(userId: string, capability: string, pathContexts: { id: string }[], opts?: { isGuest?: boolean }, assignmentScope?: Set<string> | null): Promise<boolean> {
    const pathIds = pathContexts.map((c) => c.id); // lá → gốc
    const allAssignments = await this.repo.getAssignmentsForUserInContexts(userId, pathIds);
    const assignments = assignmentScope ? allAssignments.filter((a) => assignmentScope.has(a.contextId)) : allAssignments;
    const roleIds = new Set<string>(assignments.map((a) => a.roleId));
    // Moodle thêm gán role mặc định ảo: `user` cho mọi user đã đăng nhập,
    // `guest` cho tài khoản guest — cả hai neo tại context hệ thống.
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
   * Phân giải capability THEO LÔ cho một tập context đích — đường riêng
   * của ảnh chụp quyền (`UsersService.getMyAccess`), KHÔNG phải đường gác
   * route: các route nghiệp vụ vẫn đi qua `hasCapability` như cũ.
   *
   * Vì sao cần: ảnh chụp quyền phải phân giải toàn bộ capability đã đăng
   * ký tại mọi context liên quan của người dùng. Gọi `hasCapability`
   * tuần tự cho từng cặp (context × capability) tốn vài truy vấn
   * Postgres cho mỗi cặp (đọc context, đọc path, cổng tenant — trước cả
   * khi tra cache kết quả), nên một request ảnh chụp quyền phát sinh
   * hàng nghìn truy vấn. Phép này nạp dữ kiện MỘT lần theo lô rồi tính
   * trong bộ nhớ:
   *   1. Path (lá → gốc) của từng đích dựng từ cột `path` vật chất hoá
   *      và bảng context được truyền vào; id nào còn thiếu thì nạp bổ
   *      sung đúng một truy vấn cho mọi đích.
   *   2. Cổng tenant của từng đích tính từ HAI truy vấn dùng chung
   *      (thông tin cổng của mọi tenant xuất hiện trên các path + trạng
   *      thái membership của user ở các tenant đó). Kết quả cổng của
   *      một đích chỉ phụ thuộc tenant trên path của nó và membership
   *      của user nên dùng chung không đổi kết quả so với `tenantGate`.
   *   3. Lối tắt site admin tra một lần, chỉ áp cho các đích ngoài cây
   *      tenant (cổng không thu hẹp) — đúng điều kiện của
   *      `hasCapability`.
   *   4. Các đích còn lại được đánh giá bằng đúng các hàm thuần
   *      `evaluateSingleRole`/`aggregateRoleResults` trên dữ kiện nạp
   *      theo lô: gán vai của user trên hợp nhất các path (một truy
   *      vấn, lọc lại theo path và `assignmentScope` của từng đích),
   *      vai mặc định `user`/`guest`, và toàn bộ override của các vai
   *      đó trên các path (một truy vấn, không lọc theo capability).
   *
   * Bất biến tương đương: với cùng dữ kiện, kết quả tại từng đích bằng
   * đúng kết quả `hasCapability(userId, capability, đích, opts)` cho
   * mọi capability — thứ tự tổ tiên lá → gốc, PROHIBIT thắng tuyệt đối,
   * PREVENT/ALLOW, vai mặc định, thu hẹp gán vai theo cổng tenant và
   * lối tắt site admin đều giữ nguyên. Khác biệt duy nhất: đường này
   * KHÔNG qua cache kết quả phân giải trên Redis của `hasCapability`.
   * Cache đó chỉ là bản ghi nhớ của cùng phép đánh giá, khoá bằng dấu
   * version của path và bị vô hiệu hoá mỗi khi dữ kiện quyền thay đổi
   * (`markContextDirty`), nên tính tươi từ dữ kiện vừa nạp cho cùng một
   * đáp án; đổi lại ảnh chụp quyền không phải trả hàng trăm vòng đi
   * Redis cho mỗi request.
   *
   * @param targets - Các context đích cần phân giải.
   * @param contextRowsById - Bảng tra các context đã nạp sẵn (phải gồm
   *   mọi tổ tiên của mọi đích — `getMyAccess` nạp đúng tập này; id nào
   *   thiếu vẫn được nạp bổ sung ở bước 1).
   * @returns Map từ id context đích sang danh sách capability đạt được
   *   tại context đó, theo đúng thứ tự của sổ đăng ký capability.
   */
  async resolveCapabilitiesForContexts(
    userId: string,
    targets: ContextRow[],
    contextRowsById: Map<string, ContextRow>,
    opts?: { isGuest?: boolean },
  ): Promise<Map<string, string[]>> {
    const resolved = new Map<string, string[]>();
    if (targets.length === 0) return resolved;

    // Bước 1: path của từng đích + nạp bổ sung các context còn thiếu.
    const known = new Map(contextRowsById);
    const pathIdsByTarget = new Map<string, string[]>();
    const missingIds = new Set<string>();
    for (const target of targets) {
      const ids = target.path.split('/').filter(Boolean).reverse();
      pathIdsByTarget.set(target.id, ids);
      for (const id of ids) if (!known.has(id)) missingIds.add(id);
    }
    if (missingIds.size > 0) {
      for (const row of await this.repo.getContextsByIds([...missingIds])) known.set(row.id, row);
    }
    const pathContextsOf = (targetId: string): ContextRow[] =>
      (pathIdsByTarget.get(targetId) ?? []).map((id) => known.get(id)!).filter(Boolean);

    // Bước 2: cổng tenant cho mọi đích từ hai truy vấn dùng chung.
    const tenantIds = new Set<string>();
    for (const target of targets) {
      const tenantCtx = pathContextsOf(target.id).find((c) => c.contextLevel === CONTEXT_LEVELS.TENANT);
      if (tenantCtx?.instanceId) tenantIds.add(tenantCtx.instanceId);
    }
    const gateInfoByTenant = new Map(
      (await this.repo.getTenantGateInfos([...tenantIds])).map((info) => [info.id, info]),
    );
    const membershipByTenant = new Map(
      (await this.repo.getMembershipStatuses([...tenantIds], userId)).map((m) => [m.tenantId, m.status]),
    );
    const gateByTarget = new Map<string, TenantGate>();
    for (const target of targets) {
      const pathContexts = pathContextsOf(target.id);
      const tenantCtx = pathContexts.find((c) => c.contextLevel === CONTEXT_LEVELS.TENANT);
      if (!tenantCtx?.instanceId) {
        gateByTarget.set(target.id, { allowed: true, assignmentScope: null });
        continue;
      }
      const info = gateInfoByTenant.get(tenantCtx.instanceId);
      if (!info || (info.kind !== 'school' && info.kind !== 'center')) {
        gateByTarget.set(target.id, { allowed: true, assignmentScope: null });
        continue;
      }
      if (info.status !== 'active' || membershipByTenant.get(tenantCtx.instanceId) !== 'active') {
        gateByTarget.set(target.id, { allowed: false, assignmentScope: null });
        continue;
      }
      const scope = new Set(pathContexts.filter((c) => c.path.startsWith(tenantCtx.path)).map((c) => c.id));
      gateByTarget.set(target.id, { allowed: true, assignmentScope: scope });
    }

    // Bước 3: phân loại các đích — cổng chặn (không capability nào),
    // lối tắt site admin (trọn bộ capability đã đăng ký), còn lại phải
    // đánh giá thật. Cờ site admin chỉ tra một lần khi có đích ngoài
    // cây tenant.
    const toEvaluate: ContextRow[] = [];
    let needsAdminCheck = false;
    for (const target of targets) {
      const gate = gateByTarget.get(target.id)!;
      if (!gate.allowed) {
        resolved.set(target.id, []);
      } else {
        if (gate.assignmentScope === null) needsAdminCheck = true;
        toEvaluate.push(target);
      }
    }
    const isAdmin = needsAdminCheck ? await this.isSiteAdmin(userId) : false;
    const evaluated: ContextRow[] = [];
    for (const target of toEvaluate) {
      const gate = gateByTarget.get(target.id)!;
      if (gate.assignmentScope === null && isAdmin) {
        resolved.set(target.id, CAPABILITY_DEFINITIONS.map((def) => def.name));
      } else {
        evaluated.push(target);
      }
    }
    if (evaluated.length === 0) return resolved;

    // Bước 4: nạp theo lô dữ kiện đánh giá cho mọi đích còn lại — mỗi
    // loại dữ kiện đúng một truy vấn.
    const unionPathIds = [...new Set(evaluated.flatMap((t) => pathIdsByTarget.get(t.id) ?? []))];
    const allAssignments = await this.repo.getAssignmentsForUserInContexts(userId, unionPathIds);
    const defaultRole = await this.repo.getRoleByShortname(opts?.isGuest ? 'guest' : 'user');
    const roleIds = new Set<string>(allAssignments.map((a) => a.roleId));
    if (defaultRole) roleIds.add(defaultRole.id);
    const allOverrides = await this.repo.getOverridesForRolesInContexts([...roleIds], unionPathIds);
    const overrideByKey = new Map<string, number>();
    for (const o of allOverrides) overrideByKey.set(`${o.roleId}|${o.capability}|${o.contextId}`, o.permission);

    // Bước 5: tính trong bộ nhớ cho từng đích, đúng thuật toán của
    // evaluate(): lọc gán vai theo path (và theo assignmentScope khi
    // cổng tenant thu hẹp), cộng vai mặc định, rồi với từng capability
    // duyệt override theo thứ tự lá → gốc cho từng vai và tổng hợp.
    for (const target of evaluated) {
      const gate = gateByTarget.get(target.id)!;
      const pathIds = pathIdsByTarget.get(target.id) ?? [];
      const pathIdSet = new Set(pathIds);
      const targetRoleIds = new Set<string>();
      for (const a of allAssignments) {
        if (!pathIdSet.has(a.contextId)) continue;
        if (gate.assignmentScope && !gate.assignmentScope.has(a.contextId)) continue;
        targetRoleIds.add(a.roleId);
      }
      if (defaultRole) targetRoleIds.add(defaultRole.id);
      const capabilities: string[] = [];
      if (targetRoleIds.size > 0) {
        for (const def of CAPABILITY_DEFINITIONS) {
          const roleResults: number[] = [];
          for (const roleId of targetRoleIds) {
            const points: RoleOverridePoint[] = [];
            for (const contextId of pathIds) {
              const permission = overrideByKey.get(`${roleId}|${def.name}|${contextId}`);
              if (permission !== undefined) points.push({ contextId, permission });
            }
            roleResults.push(evaluateSingleRole(points));
          }
          if (aggregateRoleResults(roleResults)) capabilities.push(def.name);
        }
      }
      resolved.set(target.id, capabilities);
    }
    return resolved;
  }

  /**
   * Kiểm tra capability chỉ trên gán role THẬT (không có role mặc định ảo
   * user/guest), tuỳ chọn bỏ qua gán của các archetype cho trước.
   * Enrol dùng cách này cho ngoại lệ của cổng enrol (report §2#5):
   * một ghi danh bị đình chỉ vẫn chặn user mà đường duy nhất tới
   * `course:view` là role student do chính ghi danh đó cấp,
   * trong khi gán staff thật (teacher/manager/…) vẫn cho họ vào.
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
    const target = await this.contexts.getContext(contextId);
    const pathContexts = await this.contexts.getPathContexts(target);
    const gate = await this.tenantGate(userId, pathContexts);
    if (!gate.allowed) return false;
    // N2 (#196): trong cây tenant school/center, site admin cũng chỉ
    // tính gán vai thật như người thường — cùng quy tắc hasCapability.
    if (gate.assignmentScope === null && (await this.isSiteAdmin(userId))) return true;
    const pathIds = pathContexts.map((c) => c.id);
    const allAssignments = await this.repo.getAssignmentsForUserInContexts(userId, pathIds);
    const assignments = gate.assignmentScope ? allAssignments.filter((a) => gate.assignmentScope!.has(a.contextId)) : allAssignments;
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
   * Kiểm tra capability trên gán role THẬT Ở BẤT KỲ ĐÂU: đạt khi user
   * giữ capability từ một gán vai THẬT ở ít nhất một context (vai mặc
   * định ảo user/guest không bao giờ tính). Dùng cho các cổng kiểu "được
   * dùng không gian cá nhân của mình" (vd kho học liệu cá nhân): sự kiện
   * quyết định là user là nhân sự giảng dạy Ở ĐÂU ĐÓ, không phải có vai
   * tại chính context cá nhân (nơi theo thiết kế không ai được gán vai).
   */
  async hasCapabilityFromRealAssignmentAnywhere(userId: string, capability: string): Promise<boolean> {
    if (await this.isSiteAdmin(userId)) return true;
    const assignments = await this.repo.listAssignments({ userId });
    const contextIds = [...new Set(assignments.map((a) => a.contextId))];
    for (const contextId of contextIds) {
      if (await this.hasCapabilityFromRealAssignment(userId, capability, contextId)) return true;
    }
    return false;
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
