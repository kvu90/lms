import { describe, expect, it } from 'vitest';
import type { Cache } from 'cache-manager';
import type { ConfigService } from '@nestjs/config';
import type { SpaceDatabaseService } from '../../db/routing/space-database.service';
import { AccessRepository, type ContextRow } from './access.repository';
import { ContextsService } from './contexts.service';
import { CAP_ALLOW } from './domain/permission';
import { PermissionEvaluator } from './permission-evaluator.service';
import { tenantAls } from '../tenants/tenant-als';

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
 *  4. Mục cache của cấu hình site admin được cô lập theo cơ sở dữ
 *     liệu: giá trị của nó là id người dùng, chỉ có nghĩa trong đúng
 *     một DB, trong khi nhiều tiến trình trỏ vào các DB khác nhau có
 *     thể dùng chung một Redis (CI chạy nhiều DB test trên một
 *     Redis). Hai tiến trình khác DB không bao giờ được đọc/ghi lẫn
 *     mục của nhau — nếu không, một tiến trình sẽ thấy admin của DB
 *     lạ và quyết định sai (điển hình: seed của app con trên DB
 *     trống tưởng admin đầu tiên đã tồn tại nên bỏ qua việc tạo).
 *     Ngược lại, hai tiến trình cùng một DB vẫn dùng chung mục như
 *     thiết kế cache-trước vốn có.
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

function makeWorld(opts?: { databaseUrl?: string; cacheStore?: Map<string, unknown>; contextDatabaseName?: () => string | undefined }) {
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
    // Danh sách site admin của KHO CHUNG, chỉ phép đọc ghim
    // platform của evaluator (`isPlatformSiteAdmin`, TĐ6) mới
    // thấy: tầng dữ liệu giả lập phân biệt lượt đọc này bằng
    // ngữ cảnh ALS platform đã lược slug (xem `getConfigValue`
    // và `currentContextDatabaseName` giả lập dưới đây).
    platformSiteAdmins: ['user-admin'] as string[],
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
      if (key !== 'siteadmins') return undefined;
      // Lượt đọc ghim platform của evaluator chạy trong ngữ
      // cảnh ALS platform đã lược slug: tầng dữ liệu thật lúc
      // đó đọc kho chung, nên giả lập trả danh sách platform
      // riêng thay vì danh sách của "kho đang được ngữ cảnh
      // đọc" mà các ca thường dùng.
      const store = tenantAls.getStore();
      if (store?.platform && !store?.spaceSlug) return state.platformSiteAdmins;
      return state.siteAdmins;
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

  // Kho cache và URL cơ sở dữ liệu được truyền vào khi spec cần dựng
  // nhiều "tiến trình" dùng chung một Redis (cùng `cacheStore`) nhưng
  // trỏ vào các DB khác nhau (khác `databaseUrl`); mặc định mỗi thế
  // giới có kho riêng và DB tên `lms_test_api`.
  const cacheStore = opts?.cacheStore ?? new Map<string, unknown>();
  const cache = {
    async get(key: string) { return cacheStore.get(key); },
    async set(key: string, value: unknown) { cacheStore.set(key, value); },
    async del(key: string) { cacheStore.delete(key); },
  };

  const repoCast = repo as unknown as AccessRepository;
  const contextsService = new ContextsService(repoCast);
  const config = {
    getOrThrow: () => opts?.databaseUrl ?? 'postgres://user:pass@localhost:5432/lms_test_api',
  } as unknown as ConfigService;
  // Khung định tuyến kho giả lập cho các ca cần ngữ cảnh kho riêng:
  // chỉ phơi đúng phép tra danh tính kho của ngữ cảnh mà evaluator
  // dùng để dựng khoá cache `siteadmins`; mặc định không có ngữ
  // cảnh kho riêng (trả undefined — kho chung) như các ca còn lại.
  // Lượt đọc ghim platform của evaluator lược slug khỏi ALS nên
  // khung thật lúc đó cũng báo "không phải kho riêng": giả lập
  // trả undefined trong ngữ cảnh ALS platform đã lược slug để
  // khoá cache của lượt đọc đó rơi về kho chung như code thật.
  const spaceDb = {
    currentContextDatabaseName: () => {
      const store = tenantAls.getStore();
      if (store?.platform && !store?.spaceSlug) return undefined;
      return opts?.contextDatabaseName?.();
    },
  } as unknown as SpaceDatabaseService;
  const evaluator = new PermissionEvaluator(repoCast, contextsService, cache as unknown as Cache, config, spaceDb);
  return { state, counters, contextsService, evaluator, cacheStore };
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

describe('PermissionEvaluator — cô lập cache site admin theo cơ sở dữ liệu khi dùng chung Redis', () => {
  it('tiến trình trên DB trống không thấy danh sách site admin mà tiến trình của DB khác đã ghi xuyên vào Redis chung', async () => {
    // Đúng hình thù làm CI đỏ ở spec seed-bootstrap: app chính boot
    // trên DB của nó và seed ghi xuyên admin đầu tiên vào Redis dùng
    // chung; app con trên DB trống khác sau đó quyết định việc tạo
    // admin đầu tiên dựa trên danh sách site admin nó đọc được.
    const sharedStore = new Map<string, unknown>();
    const processA = makeWorld({ databaseUrl: 'postgres://localhost:5432/lms_db_a', cacheStore: sharedStore });
    const processB = makeWorld({ databaseUrl: 'postgres://localhost:5432/lms_db_b', cacheStore: sharedStore });
    processB.state.siteAdmins = [];

    await processA.evaluator.setSiteAdmins(['admin-cua-db-a']);

    // B phải đọc danh sách của chính DB của nó (rỗng) từ DB, không
    // được đọc trúng mục A đã ghi vào Redis chung.
    await expect(processB.evaluator.listSiteAdmins()).resolves.toEqual([]);
    await expect(processB.evaluator.isSiteAdmin('admin-cua-db-a')).resolves.toBe(false);
    expect(processB.counters.configReads).toBeGreaterThan(0);
  });

  it('lượt đọc tự nạp cache của một DB không làm DB khác đọc trúng danh sách của DB đó', async () => {
    const sharedStore = new Map<string, unknown>();
    const processA = makeWorld({ databaseUrl: 'postgres://localhost:5432/lms_db_a', cacheStore: sharedStore });
    const processB = makeWorld({ databaseUrl: 'postgres://localhost:5432/lms_db_b', cacheStore: sharedStore });
    processB.state.siteAdmins = ['admin-cua-db-b'];

    await expect(processA.evaluator.listSiteAdmins()).resolves.toEqual(['user-admin']);
    await expect(processB.evaluator.listSiteAdmins()).resolves.toEqual(['admin-cua-db-b']);
  });

  it('hai tiến trình cùng một cơ sở dữ liệu vẫn dùng chung mục cache: lượt đọc của tiến trình sau trúng cache, không hỏi lại DB', async () => {
    const sharedStore = new Map<string, unknown>();
    const processA = makeWorld({ databaseUrl: 'postgres://localhost:5432/lms_db_chung', cacheStore: sharedStore });
    const processB = makeWorld({ databaseUrl: 'postgres://localhost:5432/lms_db_chung', cacheStore: sharedStore });

    await expect(processA.evaluator.listSiteAdmins()).resolves.toEqual(['user-admin']);
    await expect(processB.evaluator.listSiteAdmins()).resolves.toEqual(['user-admin']);
    expect(processB.counters.configReads).toBe(0);
  });

  it('cùng một tiến trình phục vụ hai kho: ngữ cảnh kho riêng hợp nhất một chiều với danh sách platform, ngữ cảnh kho chung không bao giờ thấy danh sách kho riêng', async () => {
    // Mô hình của tiền điều kiện TĐ6 (issue #587): một tiến trình vừa
    // phục vụ kho chung vừa phục vụ một trung tâm kho riêng qua
    // handle định tuyến, dùng chung một Redis. Tầng dữ liệu giả lập
    // là một repository duy nhất, nên test hoán đổi danh sách site
    // admin của repository theo "kho đang được ngữ cảnh đọc" để
    // đóng vai hai kho; phần bị kiểm chứng là khoá cache mà
    // evaluator dựng từ danh tính kho của ngữ cảnh — khoá đó phải
    // tự tách hai kho dù cache vật lý là một — cộng lớp hợp nhất
    // một chiều của isSiteAdmin: ngữ cảnh kho riêng nhận diện cả
    // admin của kho mình và admin platform (lượt đọc ghim platform
    // trả danh sách platform riêng của giả lập).
    const sharedStore = new Map<string, unknown>();
    let contextDatabaseName: string | undefined;
    const { evaluator, state, counters } = makeWorld({
      cacheStore: sharedStore,
      contextDatabaseName: () => contextDatabaseName,
    });
    state.siteAdmins = ['admin-kho-chung'];
    state.platformSiteAdmins = ['admin-kho-chung'];

    // Ngữ cảnh kho chung nạp cache trước: thấy admin của kho chung.
    await expect(evaluator.isSiteAdmin('admin-kho-chung')).resolves.toBe(true);
    const readsAfterSharedPrime = counters.configReads;

    // Chuyển ngữ cảnh sang kho riêng (danh tính kho do khung định
    // tuyến báo): evaluator phải đọc lại từ tầng dữ liệu theo khoá
    // của kho riêng — không dùng mục kho chung vừa nạp — và nhận
    // diện admin của kho riêng; đồng thời lớp phủ platform khiến
    // admin kho chung cũng được nhận diện trong ngữ cảnh này.
    contextDatabaseName = 'lms_space_rieng';
    state.siteAdmins = ['admin-kho-rieng'];
    await expect(evaluator.isSiteAdmin('admin-kho-rieng')).resolves.toBe(true);
    expect(counters.configReads).toBeGreaterThan(readsAfterSharedPrime);
    await expect(evaluator.isSiteAdmin('admin-kho-chung')).resolves.toBe(true);

    // Ghi xuyên trong ngữ cảnh kho riêng chỉ chạm mục của kho
    // riêng: quay lại ngữ cảnh kho chung, danh sách hiệu lực vẫn
    // là danh sách của kho chung, admin ghi ở kho riêng không rò
    // sang.
    await evaluator.setSiteAdmins(['admin-kho-rieng', 'admin-rieng-hai']);
    contextDatabaseName = undefined;
    state.siteAdmins = ['admin-kho-chung'];
    await expect(evaluator.listSiteAdmins()).resolves.toEqual(['admin-kho-chung']);
    await expect(evaluator.isSiteAdmin('admin-rieng-hai')).resolves.toBe(false);
  });
});
