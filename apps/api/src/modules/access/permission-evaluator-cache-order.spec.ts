import { describe, expect, it } from 'vitest';
import type { Cache } from 'cache-manager';
import { AccessRepository, type ContextRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAP_ALLOW } from './domain/permission';
import { PermissionEvaluator } from './permission-evaluator.service';

/**
 * Bộ spec phân quyền cho việc tái thứ tự tra cứu của PermissionEvaluator
 * (BE-05): ma trận vai trò × ngữ cảnh × trạng thái cache, khẳng định hai
 * lớp hệ quả phải giữ tuyệt đối khi thứ tự tra cứu đổi:
 *
 *  1. Kết quả cho/chặn của từng trường hợp KHÔNG đổi so với hành vi
 *     hiện tại — ma trận kết quả trong spec này đạt trên code hiện tại
 *     và phải đạt y hệt sau refactor (đây là lưới an toàn của việc đổi
 *     thứ tự).
 *  2. Chi phí truy vấn đổi đúng theo thiết kế cache-trước: ở lượt kiểm
 *     lặp lại cùng đầu vào (cache ấm), tầng dữ liệu đánh giá (gán vai,
 *     override), dữ kiện cổng tenant (thông tin tenant + membership) và
 *     cấu hình site admin KHÔNG bị hỏi lại — mọi tầng cache đều được
 *     tra trước truy vấn DB mà chúng thay thế. Hai truy vấn nạp
 *     context/path là ngoại lệ có chủ đích: chúng dựng dấu version —
 *     chính khoá vô hiệu hoá của mọi tầng cache — nên luôn đọc từ DB;
 *     spec ghim bất biến này bằng bộ đếm contextReads vẫn tăng ở lượt
 *     lặp lại.
 *
 *  3. Vô hiệu hoá giữ nguyên điều kiện và tính tức thì hiện hành: mọi
 *     thay đổi dữ kiện quyền trong sản phẩm đều bump version của
 *     context liên quan qua `markContextDirty` (gỡ gán vai bump context
 *     của gán, đổi trạng thái membership/tenant bump context tenant,
 *     đặt override bump context của override). Spec mô phỏng đúng các
 *     bump đó và khẳng định kết quả lật ngay ở lượt kiểm sau. Danh sách
 *     site admin đổi qua `setSiteAdmins` — điểm ghi duy nhất của cấu
 *     hình này — cũng phải hiệu lực ngay.
 *
 * Thế giới kiểm chứng dựng trong bộ nhớ với tầng dữ liệu giả lập đếm
 * số lần bị hỏi theo từng loại đọc; `ContextsService` và
 * `PermissionEvaluator` đều là service THẬT.
 */

const SYS_ID = '00000000-0000-4000-8000-000000000010';
const TEN_ID = '00000000-0000-4000-8000-000000000020';
const CRS_ID = '00000000-0000-4000-8000-000000000050';
const OUT_ID = '00000000-0000-4000-8000-000000000060';

interface AssignmentRow { userId: string; roleId: string; contextId: string }
interface OverrideRow { roleId: string; capability: string; contextId: string; permission: number }

function makeWorld() {
  const contexts: ContextRow[] = [
    { id: SYS_ID, contextLevel: 10, instanceId: null, path: `/${SYS_ID}`, depth: 1, version: 1 } as ContextRow,
    { id: TEN_ID, contextLevel: 20, instanceId: 'tenant-1', path: `/${SYS_ID}/${TEN_ID}`, depth: 2, version: 1 } as ContextRow,
    { id: CRS_ID, contextLevel: 50, instanceId: 'course-1', path: `/${SYS_ID}/${TEN_ID}/${CRS_ID}`, depth: 3, version: 1 } as ContextRow,
    { id: OUT_ID, contextLevel: 50, instanceId: 'course-2', path: `/${SYS_ID}/${OUT_ID}`, depth: 2, version: 1 } as ContextRow,
  ];
  const state = {
    tenantInfo: { kind: 'center', status: 'active' } as { kind: string; status: string } | undefined,
    memberships: new Map<string, string>([['tenant-1|user-member', 'active'], ['tenant-1|user-plain', 'active']]),
    siteAdmins: ['user-admin'] as string[],
    assignments: [
      { userId: 'user-member', roleId: 'role-viewer', contextId: CRS_ID },
      { userId: 'user-outsider', roleId: 'role-viewer', contextId: CRS_ID },
    ] as AssignmentRow[],
    overrides: [
      { roleId: 'role-viewer', capability: 'course:view', contextId: CRS_ID, permission: CAP_ALLOW },
      { roleId: 'role-guest', capability: 'files:view', contextId: SYS_ID, permission: CAP_ALLOW },
    ] as OverrideRow[],
  };
  const counters = {
    contextReads: 0,
    gateInfoReads: 0,
    membershipReads: 0,
    configReads: 0,
    assignmentReads: 0,
    overrideReads: 0,
  };
  const rolesByShortname: Record<string, { id: string; shortName: string }> = {
    user: { id: 'role-user', shortName: 'user' },
    guest: { id: 'role-guest', shortName: 'guest' },
    viewer: { id: 'role-viewer', shortName: 'viewer' },
  };

  const repo = {
    // --- contexts ---------------------------------------------------
    async getContextById(id: string) {
      counters.contextReads += 1;
      return contexts.find((c) => c.id === id);
    },
    async getContextsByIds(ids: string[]) {
      counters.contextReads += 1;
      return ids.map((id) => contexts.find((c) => c.id === id)).filter(Boolean) as ContextRow[];
    },
    async bumpContextVersions(pathPrefix: string) {
      for (const c of contexts) {
        if (c.path === pathPrefix || c.path.startsWith(`${pathPrefix}/`)) c.version += 1;
      }
    },
    // --- cổng tenant / cấu hình --------------------------------------
    async getTenantGateInfo(tenantId: string) {
      counters.gateInfoReads += 1;
      return tenantId === 'tenant-1' ? state.tenantInfo : undefined;
    },
    async getMembershipStatus(tenantId: string, userId: string) {
      counters.membershipReads += 1;
      return state.memberships.get(`${tenantId}|${userId}`);
    },
    async getConfigValue(key: string) {
      counters.configReads += 1;
      return key === 'siteadmins' ? state.siteAdmins : undefined;
    },
    async setConfigValue(key: string, value: unknown) {
      if (key === 'siteadmins') state.siteAdmins = value as string[];
    },
    // --- gán vai / override -------------------------------------------
    async getAssignmentsForUserInContexts(userId: string, contextIds: string[]) {
      counters.assignmentReads += 1;
      return state.assignments.filter((a) => a.userId === userId && contextIds.includes(a.contextId));
    },
    async getRoleByShortname(shortName: string) {
      return rolesByShortname[shortName];
    },
    async getRoleById(id: string) {
      return Object.values(rolesByShortname).find((r) => r.id === id);
    },
    async getOverridesForRoles(roleIds: string[], capability: string, contextIds: string[]) {
      counters.overrideReads += 1;
      return state.overrides.filter((o) => roleIds.includes(o.roleId) && o.capability === capability && contextIds.includes(o.contextId));
    },
  };

  const cacheStore = new Map<string, unknown>();
  const cache = {
    async get(key: string) { return cacheStore.get(key); },
    async set(key: string, value: unknown) { cacheStore.set(key, value); },
    async del(key: string) { cacheStore.delete(key); },
  };

  const repoCast = repo as unknown as AccessRepository;
  const contextsService = new ContextsService(repoCast);
  const evaluator = new PermissionEvaluator(repoCast, contextsService, cache as unknown as Cache);
  return { state, counters, contextsService, evaluator };
}

describe('PermissionEvaluator — ma trận cho/chặn theo vai trò và ngữ cảnh (cache nguội)', () => {
  it('thành viên có gán vai và override ALLOW tại khoá trong tenant thì được cho', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(true);
  });

  it('có gán vai trong cây tenant nhưng không có membership thì cổng tenant chặn', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-outsider', 'course:view', CRS_ID)).resolves.toBe(false);
  });

  it('thành viên không có override cho capability thì bị chặn', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-member', 'course:delete', CRS_ID)).resolves.toBe(false);
  });

  it('site admin được cho ngoài cây tenant qua lối tắt', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-admin', 'course:view', OUT_ID)).resolves.toBe(true);
  });

  it('site admin không có membership thì vẫn bị cổng chặn trong cây tenant (không lối tắt)', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-admin', 'course:view', CRS_ID)).resolves.toBe(false);
  });

  it('thành viên chỉ có vai mặc định user, không override nào cho capability, thì bị chặn', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-plain', 'course:view', CRS_ID)).resolves.toBe(false);
  });

  it('vai mặc định phân biệt user và guest: cùng một capability, user bị chặn còn guest được cho theo override của vai guest', async () => {
    const { evaluator } = makeWorld();
    await expect(evaluator.hasCapability('user-plain', 'files:view', SYS_ID)).resolves.toBe(false);
    await expect(evaluator.hasCapability('user-plain', 'files:view', SYS_ID, { isGuest: true })).resolves.toBe(true);
  });
});

describe('PermissionEvaluator — lượt kiểm lặp lại khi cache đã ấm', () => {
  it('cho cùng kết quả và không hỏi lại tầng dữ liệu đánh giá, cổng tenant và cấu hình; chỉ dấu version được đọc lại từ DB', async () => {
    const { evaluator, counters } = makeWorld();
    // Lượt đầu (cache nguội) cho bốn trường hợp đại diện.
    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(true);
    await expect(evaluator.hasCapability('user-member', 'course:delete', CRS_ID)).resolves.toBe(false);
    await expect(evaluator.hasCapability('user-admin', 'course:view', OUT_ID)).resolves.toBe(true);
    await expect(evaluator.hasCapability('user-plain', 'course:view', CRS_ID)).resolves.toBe(false);

    const before = { ...counters };
    // Lượt lặp lại: kết quả giữ nguyên tuyệt đối.
    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(true);
    await expect(evaluator.hasCapability('user-member', 'course:delete', CRS_ID)).resolves.toBe(false);
    await expect(evaluator.hasCapability('user-admin', 'course:view', OUT_ID)).resolves.toBe(true);
    await expect(evaluator.hasCapability('user-plain', 'course:view', CRS_ID)).resolves.toBe(false);

    // Mọi tầng cache đều trúng: không tầng dữ liệu nào bị hỏi lại,
    // trừ phép đọc context/path dựng dấu version (khoá vô hiệu hoá).
    expect(counters.assignmentReads).toBe(before.assignmentReads);
    expect(counters.overrideReads).toBe(before.overrideReads);
    expect(counters.gateInfoReads).toBe(before.gateInfoReads);
    expect(counters.membershipReads).toBe(before.membershipReads);
    expect(counters.configReads).toBe(before.configReads);
    expect(counters.contextReads).toBeGreaterThan(before.contextReads);
  });
});

describe('PermissionEvaluator — thay đổi dữ kiện quyền có hiệu lực tức thì dù kết quả đã cache', () => {
  it('membership bị đình chỉ (kèm bump version context tenant) thì lượt kiểm sau bị chặn ngay và cổng được đọc lại từ DB', async () => {
    const { evaluator, contextsService, state, counters } = makeWorld();
    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(true);
    const readsBefore = counters.membershipReads + counters.gateInfoReads;

    // Mô phỏng TenantsService.setMemberStatus: đổi trạng thái + bump
    // version của context tenant.
    state.memberships.set('tenant-1|user-member', 'suspended');
    await contextsService.markContextDirty(TEN_ID);

    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(false);
    expect(counters.membershipReads + counters.gateInfoReads).toBeGreaterThan(readsBefore);
  });

  it('tenant bị đình chỉ (kèm bump version context tenant) thì thành viên cũng bị chặn ngay', async () => {
    const { evaluator, contextsService, state } = makeWorld();
    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(true);

    // Mô phỏng TenantsService.updateTenant đổi status: bump context tenant.
    state.tenantInfo = { kind: 'center', status: 'suspended' };
    await contextsService.markContextDirty(TEN_ID);

    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(false);
  });

  it('gỡ gán vai (kèm bump version context của gán) thì lượt kiểm sau bị chặn và tầng đánh giá được hỏi lại', async () => {
    const { evaluator, contextsService, state, counters } = makeWorld();
    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(true);
    const readsBefore = counters.assignmentReads;

    // Mô phỏng RolesService.unassignRole: xoá gán + bump context của gán.
    state.assignments = state.assignments.filter((a) => a.userId !== 'user-member');
    await contextsService.markContextDirty(CRS_ID);

    await expect(evaluator.hasCapability('user-member', 'course:view', CRS_ID)).resolves.toBe(false);
    expect(counters.assignmentReads).toBeGreaterThan(readsBefore);
  });

  it('thêm override ALLOW (kèm bump version context của override) thì capability trước đó bị chặn được cho ngay', async () => {
    const { evaluator, contextsService, state } = makeWorld();
    await expect(evaluator.hasCapability('user-member', 'course:delete', CRS_ID)).resolves.toBe(false);

    // Mô phỏng RolesService.setCapabilityOverride: thêm override + bump.
    state.overrides.push({ roleId: 'role-viewer', capability: 'course:delete', contextId: CRS_ID, permission: CAP_ALLOW });
    await contextsService.markContextDirty(CRS_ID);

    await expect(evaluator.hasCapability('user-member', 'course:delete', CRS_ID)).resolves.toBe(true);
  });

  it('cấp rồi thu hồi site admin qua setSiteAdmins có hiệu lực ngay ở lượt kiểm sau', async () => {
    const { evaluator } = makeWorld();
    // Ngoài cây tenant, user-plain không có quyền nào: bị chặn, kết quả
    // đánh giá được cache.
    await expect(evaluator.hasCapability('user-plain', 'course:view', OUT_ID)).resolves.toBe(false);
    await evaluator.setSiteAdmins(['user-plain']);
    await expect(evaluator.hasCapability('user-plain', 'course:view', OUT_ID)).resolves.toBe(true);
    await evaluator.setSiteAdmins([]);
    await expect(evaluator.hasCapability('user-plain', 'course:view', OUT_ID)).resolves.toBe(false);
  });
});
