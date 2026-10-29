import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Cache } from 'cache-manager';
import type { ConfigService } from '@nestjs/config';
import type { OutboxService } from '../../infra/events/outbox.service';
import type { AccessRepository, ContextRow } from '../access/access.repository';
import { ContextsService } from '../access/contexts.service';
import { PermissionEvaluator } from '../access/permission-evaluator.service';
import type { CoursesService } from '../courses/courses.service';
import type { EnrolService } from '../enrol/enrol.service';
import type { GroupsService } from '../groups/groups.service';
import type { RolesService } from '../access/roles.service';
import { TenantContextService } from '../tenants/tenant-context.service';
import type { TenantsService } from '../tenants/tenants.service';
import type { UsersService } from '../users/users.service';
import type { ClassesRepository, ClassRow } from './classes.repository';
import { ClassesService } from './classes.service';

/**
 * Bộ spec phân quyền cho danh sách lớp (DL-06): khi `listClasses`
 * chuyển từ đánh giá quyền xem lớp theo từng lớp sang đánh giá THEO
 * LÔ cho cả tập lớp, đáp ứng phải giữ nguyên tuyệt đối.
 *
 * Cách khẳng định: mỗi kịch bản tính đáp ứng kỳ vọng bằng THUẬT TOÁN
 * CŨ được viết lại độc lập ngay trong spec (chủ lớp → capability
 * `class:view` qua `PermissionEvaluator.hasCapability` từng lớp →
 * thành viên roster; bốn cờ khả năng theo đúng công thức hiện hành)
 * rồi đối chiếu toàn bộ hình chiếu đáp ứng (id, bốn cờ, mã tham gia)
 * của `listClasses` với kỳ vọng đó. Spec đạt trên code hiện tại (nơi
 * `listClasses` chính là thuật toán cũ) và phải đạt y hệt sau khi
 * batch hoá — lệch một trường hợp là batch sai.
 *
 * Kèm hai khẳng định về cách làm mới: khi không ở chế độ thấy toàn bộ,
 * phép phân giải theo lô của evaluator được gọi ĐÚNG MỘT lượt cho cả
 * tập lớp và không còn lượt `hasCapability('class:view')` theo từng
 * lớp; khi ở chế độ thấy toàn bộ (site admin / tenant:manage) đường
 * theo lô không được chạm tới — lối tắt hiện hành giữ nguyên.
 *
 * Thế giới kiểm chứng: tenant có 5 lớp ở các trạng thái quyền khác
 * nhau (lớp của mình, lớp có capability, lớp là thành viên roster,
 * lớp không liên hệ, lớp của người khác) trên cây context thật
 * system → tenant → class; `ContextsService` + `PermissionEvaluator`
 * là service THẬT trên tầng dữ liệu giả lập trong bộ nhớ.
 */

const SYS_ID = '00000000-0000-4000-8000-000000000010';
const TEN_ID = '00000000-0000-4000-8000-000000000020';
const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';
const CLASS_CTX_IDS = [
  '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000102',
  '00000000-0000-4000-8000-000000000103',
  '00000000-0000-4000-8000-000000000104',
  '00000000-0000-4000-8000-000000000105',
];
const CLASS_IDS = [
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000202',
  '00000000-0000-4000-8000-000000000203',
  '00000000-0000-4000-8000-000000000204',
  '00000000-0000-4000-8000-000000000205',
];
const ORPHAN_CLASS_ID = '00000000-0000-4000-8000-000000000206';

const ALLOW = 1;

const ctx = (id: string, contextLevel: number, path: string, instanceId: string | null = null): ContextRow =>
  ({ id, contextLevel, instanceId, path, depth: path.split('/').filter(Boolean).length, version: 1 }) as ContextRow;

const classRow = (id: string, ownerId: string, cohortId: string, joinCode: string): ClassRow =>
  ({
    id,
    tenantId: TENANT_ID,
    name: `Lớp ${id.slice(-3)}`,
    code: null,
    schoolYear: null,
    ownerId,
    cohortId,
    allowSelfReport: false,
    joinCode,
    joinAutoApprove: false,
    onLeave: 'suspend',
    status: 'active',
    description: '',
    feeCost: 0,
    feeCurrency: 'VND',
    feePaymentAccountId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }) as ClassRow;

interface WorldOptions {
  orphanRow?: boolean;
  emptyTenant?: boolean;
}

function makeWorld(opts: WorldOptions = {}) {
  const contexts: ContextRow[] = [
    ctx(SYS_ID, 10, `/${SYS_ID}`),
    ctx(TEN_ID, 20, `/${SYS_ID}/${TEN_ID}`, TENANT_ID),
    ...CLASS_CTX_IDS.map((id, i) => ctx(id, 45, `/${SYS_ID}/${TEN_ID}/${id}`, CLASS_IDS[i]!)),
  ];
  const byId = new Map(contexts.map((c) => [c.id, c]));

  const rows: ClassRow[] = opts.emptyTenant
    ? []
    : [
        classRow(CLASS_IDS[0]!, 'teacher-a', 'cohort-1', 'JOIN1'),
        classRow(CLASS_IDS[1]!, 'teacher-b', 'cohort-2', 'JOIN2'),
        classRow(CLASS_IDS[2]!, 'teacher-b', 'cohort-3', 'JOIN3'),
        classRow(CLASS_IDS[3]!, 'teacher-b', 'cohort-4', 'JOIN4'),
        classRow(CLASS_IDS[4]!, 'teacher-c', 'cohort-5', 'JOIN5'),
        ...(opts.orphanRow ? [classRow(ORPHAN_CLASS_ID, 'teacher-b', 'cohort-6', 'JOIN6')] : []),
      ];

  const memberships = new Map<string, string>([
    [`${TENANT_ID}|teacher-c`, 'active'],
    [`${TENANT_ID}|manager-m`, 'active'],
  ]);
  const assignments = [
    { userId: 'teacher-c', roleId: 'role-viewer', contextId: CLASS_CTX_IDS[1]! },
    { userId: 'manager-m', roleId: 'role-manager', contextId: TEN_ID },
  ];
  const overrides = [
    { roleId: 'role-viewer', capability: 'class:view', contextId: CLASS_CTX_IDS[1]!, permission: ALLOW },
    { roleId: 'role-viewer', capability: 'class:update', contextId: CLASS_CTX_IDS[1]!, permission: ALLOW },
    { roleId: 'role-manager', capability: 'tenant:manage', contextId: TEN_ID, permission: ALLOW },
    { roleId: 'role-manager', capability: 'class:create', contextId: TEN_ID, permission: ALLOW },
    { roleId: 'role-manager', capability: 'class:view', contextId: SYS_ID, permission: ALLOW },
    { roleId: 'role-manager', capability: 'class:update', contextId: SYS_ID, permission: ALLOW },
    { roleId: 'role-manager', capability: 'class:delete', contextId: SYS_ID, permission: ALLOW },
    { roleId: 'role-manager', capability: 'class:manageroster', contextId: SYS_ID, permission: ALLOW },
  ];
  const cohortMembers = new Set(['cohort-3|teacher-c', 'cohort-3|outsider-o']);
  const rolesByShortname: Record<string, { id: string; shortName: string }> = {
    user: { id: 'role-user', shortName: 'user' },
    guest: { id: 'role-guest', shortName: 'guest' },
  };

  const accessRepo = {
    async getContextById(id: string) { return byId.get(id); },
    async getContextsByIds(ids: string[]) { return ids.map((id) => byId.get(id)).filter(Boolean) as ContextRow[]; },
    async getContextByLevelInstance(contextLevel: number, instanceId: string | null) {
      return contexts.find((c) => c.contextLevel === contextLevel && c.instanceId === instanceId);
    },
    async getTenantGateInfo(tenantId: string) {
      return tenantId === TENANT_ID ? { kind: 'center', status: 'active' } : undefined;
    },
    async getTenantGateInfos(tenantIds: string[]) {
      return tenantIds.filter((id) => id === TENANT_ID).map((id) => ({ id, kind: 'center', status: 'active' }));
    },
    async getMembershipStatus(tenantId: string, userId: string) {
      return memberships.get(`${tenantId}|${userId}`);
    },
    async getMembershipStatuses(tenantIds: string[], userId: string) {
      return tenantIds
        .filter((id) => memberships.has(`${id}|${userId}`))
        .map((tenantId) => ({ tenantId, status: memberships.get(`${tenantId}|${userId}`)! }));
    },
    async getConfigValue(key: string) {
      return key === 'siteadmins' ? ['admin-z'] : undefined;
    },
    async getAssignmentsForUserInContexts(userId: string, contextIds: string[]) {
      return assignments.filter((a) => a.userId === userId && contextIds.includes(a.contextId));
    },
    async getRoleByShortname(shortName: string) { return rolesByShortname[shortName]; },
    async getOverridesForRoles(roleIds: string[], capability: string, contextIds: string[]) {
      return overrides.filter((o) => roleIds.includes(o.roleId) && o.capability === capability && contextIds.includes(o.contextId));
    },
    async getOverridesForRolesInContexts(roleIds: string[], contextIds: string[]) {
      return overrides.filter((o) => roleIds.includes(o.roleId) && contextIds.includes(o.contextId));
    },
  };

  const cacheStore = new Map<string, unknown>();
  const cache = {
    async get(key: string) { return cacheStore.get(key); },
    async set(key: string, value: unknown) { cacheStore.set(key, value); },
    async del(key: string) { cacheStore.delete(key); },
  };

  const accessRepoCast = accessRepo as unknown as AccessRepository;
  const contextsService = new ContextsService(accessRepoCast);
  const evaluator = new PermissionEvaluator(accessRepoCast, contextsService, cache as unknown as Cache, { getOrThrow: () => 'postgres://user:pass@localhost:5432/lms_test_api' } as unknown as ConfigService);

  const classesRepo = {
    async listClassesByTenant(tenantId: string) {
      return rows.filter((r) => r.tenantId === tenantId);
    },
  };
  const groups = {
    async isCohortMember(cohortId: string, userId: string) {
      return cohortMembers.has(`${cohortId}|${userId}`);
    },
  };
  const tenants = { async fallbackTenantId() { return TENANT_ID; } };
  const tenantContext = { currentTenantId() { return TENANT_ID; } };

  const service = new ClassesService(
    classesRepo as unknown as ClassesRepository,
    contextsService,
    evaluator,
    {} as unknown as RolesService,
    {} as unknown as CoursesService,
    groups as unknown as GroupsService,
    {} as unknown as EnrolService,
    {} as unknown as UsersService,
    tenants as unknown as TenantsService,
    tenantContext as unknown as TenantContextService,
    {} as unknown as OutboxService,
  );
  return { service, evaluator, contextsService, groups, rows };
}

type ProjectedItem = {
  id: string;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManageRoster: boolean;
  joinCode: string | null;
};

/**
 * Thuật toán cũ, viết lại độc lập làm căn cứ đối chiếu: khả năng thấy
 * một lớp = chủ lớp, hoặc `class:view` tại context lớp qua hasCapability
 * từng lớp, hoặc thành viên roster; bốn cờ theo đúng công thức của
 * listClasses hiện hành (cờ xoá gồm cả cổng `tenant:manage` khi không
 * phải chủ lớp; mã tham gia lộ khi là chủ lớp hoặc có
 * `class:manageroster`).
 */
async function legacyProjection(world: ReturnType<typeof makeWorld>, actorId: string): Promise<ProjectedItem[]> {
  const { evaluator, contextsService, groups, rows } = world;
  const tenantCtx = await contextsService.getTenantContext(TENANT_ID);
  const seesAll = (await evaluator.isSiteAdmin(actorId))
    || (tenantCtx ? await evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id) : false);
  const canCreate = tenantCtx ? await evaluator.hasCapability(actorId, 'class:create', tenantCtx.id) : false;
  const ctxIdOf = async (classId: string): Promise<string> => {
    const found = await contextsService.getByLevelInstance(45, classId);
    if (!found) throw new Error(`missing class context for ${classId}`);
    return found.id;
  };
  const visible: ClassRow[] = [];
  for (const row of rows) {
    if (seesAll || row.ownerId === actorId) {
      visible.push(row);
      continue;
    }
    const ctxId = await ctxIdOf(row.id);
    if (await evaluator.hasCapability(actorId, 'class:view', ctxId)) {
      visible.push(row);
      continue;
    }
    if (await groups.isCohortMember(row.cohortId, actorId)) visible.push(row);
  }
  const out: ProjectedItem[] = [];
  for (const row of visible) {
    const ctxId = await ctxIdOf(row.id);
    const isOwner = actorId === row.ownerId;
    const canUpdate = isOwner || (await evaluator.hasCapability(actorId, 'class:update', ctxId));
    const canManageRoster = isOwner || (await evaluator.hasCapability(actorId, 'class:manageroster', ctxId));
    const canDelete = (isOwner || (tenantCtx ? await evaluator.hasCapability(actorId, 'tenant:manage', tenantCtx.id) : false))
      && (isOwner || (await evaluator.hasCapability(actorId, 'class:delete', ctxId)));
    out.push({
      id: row.id,
      canCreate,
      canUpdate,
      canDelete,
      canManageRoster,
      joinCode: canManageRoster ? row.joinCode : null,
    });
  }
  return out;
}

const project = (items: Awaited<ReturnType<ClassesService['listClasses']>>): ProjectedItem[] =>
  items.map((i) => ({
    id: i.id,
    canCreate: i.canCreate,
    canUpdate: i.canUpdate,
    canDelete: i.canDelete,
    canManageRoster: i.canManageRoster,
    joinCode: i.joinCode,
  }));

describe('ClassesService.listClasses — đáp ứng giữ nguyên khi đánh giá quyền xem lớp theo lô', () => {
  it('giáo viên có capability ở một lớp, là thành viên roster ở lớp khác và chủ một lớp: thấy đúng ba lớp với đúng bốn cờ', async () => {
    const world = makeWorld();
    const actual = project(await world.service.listClasses('teacher-c'));
    expect(actual).toEqual(await legacyProjection(world, 'teacher-c'));
    // Chốt tay các điểm phân biệt của kịch bản.
    expect(actual.map((i) => i.id)).toEqual([CLASS_IDS[1], CLASS_IDS[2], CLASS_IDS[4]]);
    const byClass = new Map(actual.map((i) => [i.id, i]));
    expect(byClass.get(CLASS_IDS[1]!)).toMatchObject({ canUpdate: true, canManageRoster: false, canDelete: false, joinCode: null, canCreate: false });
    expect(byClass.get(CLASS_IDS[2]!)).toMatchObject({ canUpdate: false, canManageRoster: false, canDelete: false, joinCode: null });
    expect(byClass.get(CLASS_IDS[4]!)).toMatchObject({ canUpdate: true, canManageRoster: true, canDelete: true, joinCode: 'JOIN5' });
  });

  it('quản trị tenant (tenant:manage) thấy toàn bộ lớp của tenant và có cờ tạo lớp', async () => {
    const world = makeWorld();
    const actual = project(await world.service.listClasses('manager-m'));
    expect(actual).toEqual(await legacyProjection(world, 'manager-m'));
    expect(actual.map((i) => i.id)).toEqual(CLASS_IDS);
    expect(actual[0]).toMatchObject({ canCreate: true, canUpdate: true, canDelete: true, canManageRoster: true, joinCode: 'JOIN1' });
  });

  it('site admin thấy toàn bộ lớp qua lối tắt dù không có membership, nhưng cờ tạo lớp vẫn bị cổng tenant chặn như hiện hành', async () => {
    const world = makeWorld();
    const actual = project(await world.service.listClasses('admin-z'));
    expect(actual).toEqual(await legacyProjection(world, 'admin-z'));
    expect(actual.map((i) => i.id)).toEqual(CLASS_IDS);
    expect(actual[0]!.canCreate).toBe(false);
  });

  it('người ngoài tenant chỉ thấy lớp mình là thành viên roster, capability bị cổng tenant chặn', async () => {
    const world = makeWorld();
    const actual = project(await world.service.listClasses('outsider-o'));
    expect(actual).toEqual(await legacyProjection(world, 'outsider-o'));
    expect(actual.map((i) => i.id)).toEqual([CLASS_IDS[2]]);
  });

  it('tenant không có lớp nào thì đáp ứng là danh sách rỗng', async () => {
    const world = makeWorld({ emptyTenant: true });
    await expect(world.service.listClasses('teacher-c')).resolves.toEqual([]);
  });

  it('lớp thiếu context (trạng thái hỏng) làm listClasses ném đúng lỗi class.context_missing như đường cũ', async () => {
    const world = makeWorld({ orphanRow: true });
    let caught: unknown;
    try {
      await world.service.listClasses('teacher-c');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getResponse()).toMatchObject({ code: 'class.context_missing' });
  });
});

describe('ClassesService.listClasses — cách đánh giá theo lô', () => {
  it('phân giải quyền xem cho cả tập lớp trong đúng một lượt theo lô và không còn lượt hasCapability(class:view) theo từng lớp', async () => {
    const world = makeWorld();
    const batchSpy = vi.spyOn(world.evaluator, 'resolveCapabilitiesForContexts');
    const singleSpy = vi.spyOn(world.evaluator, 'hasCapability');
    await world.service.listClasses('teacher-c');
    expect(batchSpy).toHaveBeenCalledTimes(1);
    const viewCalls = singleSpy.mock.calls.filter((call) => call[1] === 'class:view');
    expect(viewCalls).toHaveLength(0);
  });

  it('ở chế độ thấy toàn bộ thì đường theo lô không được chạm tới', async () => {
    const world = makeWorld();
    const batchSpy = vi.spyOn(world.evaluator, 'resolveCapabilitiesForContexts');
    await world.service.listClasses('manager-m');
    await world.service.listClasses('admin-z');
    expect(batchSpy).not.toHaveBeenCalled();
  });
});
