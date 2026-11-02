import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { AccessRepository } from './access';

/**
 * Spec tích hợp của repository phân quyền trên Kysely (issue #651).
 *
 * Database trung tâm dựng từ rỗng bằng chính cầu nối migration
 * của package trên cụm PostgreSQL thật của môi trường test. Mọi
 * ca chạy qua repository production ở `access.ts` — không mô
 * phỏng handle. Kho test không cần GUC platform (như spec của
 * repository lớp học): các phép đọc cổng tenant ở đây là truy
 * vấn thuần, ngữ cảnh platform là trách nhiệm của tầng service.
 *
 * Các tính chất chốt tại đây:
 * - Mọi phương thức của repository cũ đều có mặt với cùng hợp
 *   đồng (tên, tham số, hình dạng dòng) — spec này đi hết bề
 *   mặt: context, capability, role, gán vai, override, config
 *   và bốn phép đọc cổng tenant.
 * - Insert bỏ khoá chính, id trả về khớp regex uuidv7 (phụ lục U).
 * - `count(*)` trả `number` thật (ép `::int`, T-7) và timestamp
 *   đọc thành `Date`.
 * - Ghi đè theo khoá phức hợp, doNothing + đọc lại khớp đúng
 *   nguồn, và các bảo vệ danh sách rỗng đều giữ nguyên ngữ nghĩa
 *   của bản cũ trước chuyển đổi.
 * - Transaction của repository rollback trọn vẹn khi hàm ném lỗi.
 */

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : undefined);

const TEST_DB = 'lms_db_g651_access';

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pool: Pool;
let db: CentreDb;
let repo: AccessRepository;
let tenantId: string;
let systemCtxId: string;
let tenantCtxId: string;
let courseCtxId: string;
let userAId: string;
let userBId: string;
let userCId: string;
let userDId: string;

/** Chèn một context qua repository rồi gán path/depth thật cho nó. */
async function makeContext(contextLevel: number, instanceId: string | null, parentPath: string, parentDepth: number): Promise<string> {
  const row = await repo.insertContext({ contextLevel, instanceId, path: '', depth: 0 });
  const path = `${parentPath}/${row.id}`;
  await repo.updateContextPath(row.id, path, parentDepth + 1);
  return row.id;
}

/** Chèn một role mới với shortName duy nhất. */
async function makeRole(shortName: string): Promise<string> {
  const row = await repo.insertRole({ name: `Vai ${shortName}`, shortName });
  return row.id;
}

beforeAll(async () => {
  if (!adminUrl) {
    throw new Error('Thiếu kết nối quản trị cho spec Kysely #651: đặt LMS_DB_TEST_ADMIN_URL hoặc DATABASE_URL.');
  }
  const storeUrl = await buildTestDatabase({ adminUrl, database: TEST_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  repo = new AccessRepository(db);

  const tenant = await db
    .insertInto('tenants')
    .values({ slug: 'g651-access', name: 'Trung tâm spec access', kind: 'center', status: 'active' })
    .returning('id')
    .executeTakeFirstOrThrow();
  tenantId = tenant.id;
  const users = await db
    .insertInto('users')
    .values([
      { username: 'g651-a', email: 'g651-a@example.com', first_name: 'Nguyen', last_name: 'Van A' },
      { username: 'g651-b', email: 'g651-b@example.com', first_name: 'Tran', last_name: 'Thi B' },
      { username: 'g651-c', email: 'g651-c@example.com', first_name: 'Le', last_name: 'Van C', suspended: true },
      { username: 'g651-d', email: 'g651-d@example.com', first_name: 'Pham', last_name: 'Van D', deleted: true },
    ])
    .returning('id')
    .execute();
  // Seed chèn đúng 4 user; chỉ số mảng + id đều khẳng định non-null
  // theo khuôn `rows[0]!` của package (noUncheckedIndexedAccess).
  userAId = users[0]!.id!;
  userBId = users[1]!.id!;
  userCId = users[2]!.id!;
  userDId = users[3]!.id!;
  await db
    .insertInto('tenant_memberships')
    .values([
      { tenant_id: tenantId, user_id: userAId, status: 'active' },
      { tenant_id: tenantId, user_id: userBId, status: 'active' },
    ])
    .execute();
  systemCtxId = await makeContext(10, null, '', 0);
  tenantCtxId = await makeContext(20, tenantId, `/${systemCtxId}`, 1);
  courseCtxId = await makeContext(50, randomUUID(), `/${systemCtxId}/${tenantCtxId}`, 2);
}, 180_000);

afterAll(async () => {
  if (db) await db.destroy().catch(() => undefined);
  if (pool) await pool.end().catch(() => undefined);
  if (adminUrl) await dropTestDatabase(adminUrl, TEST_DB);
});

describe('context', () => {
  it('chèn context và đọc lại theo id, theo cặp level/instance và theo danh sách id; id sinh khớp uuidv7', async () => {
    const row = await repo.insertContext({ contextLevel: 50, instanceId: randomUUID(), path: '', depth: 0 });
    expect(row.id).toMatch(UUIDV7_RE);
    await expect(repo.getContextById(row.id)).resolves.toMatchObject({ id: row.id, contextLevel: 50 });
    await expect(repo.getContextByLevelInstance(50, row.instanceId)).resolves.toMatchObject({ id: row.id });
    await expect(repo.getContextsByIds([row.id, systemCtxId])).resolves.toHaveLength(2);
    await expect(repo.getContextsByIds([])).resolves.toEqual([]);
  });

  it('getContextByLevelInstance với instance null dùng is null — không khớp instance khác, không khớp level khác', async () => {
    await expect(repo.getContextByLevelInstance(10, null)).resolves.toMatchObject({ id: systemCtxId });
    await expect(repo.getContextByLevelInstance(10, randomUUID())).resolves.toBeUndefined();
    await expect(repo.getContextByLevelInstance(20, null)).resolves.toBeUndefined();
  });

  it('getContextsByLevelInstances trả đúng các context của lô instance, lô rỗng trả rỗng', async () => {
    const rows = await repo.getContextsByLevelInstances(20, [tenantId, randomUUID()]);
    expect(rows.map((r) => r.id)).toEqual([tenantCtxId]);
    await expect(repo.getContextsByLevelInstances(20, [])).resolves.toEqual([]);
  });

  it('listContexts sắp theo path', async () => {
    const rows = await repo.listContexts();
    const paths = rows.map((r) => r.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths).toContain(`/${systemCtxId}`);
  });

  it('bumpContextVersions tăng version của chính context và mọi con cháu theo tiền tố path, không chạm context khác', async () => {
    const parent = await makeContext(40, randomUUID(), `/${systemCtxId}`, 1);
    const parentPath = `/${systemCtxId}/${parent}`;
    const child = await makeContext(50, randomUUID(), parentPath, 2);
    const childPath = `${parentPath}/${child}`;
    const grandchild = await makeContext(70, randomUUID(), childPath, 3);
    const unrelated = await makeContext(40, randomUUID(), `/${systemCtxId}`, 1);
    const before = new Map(
      (await repo.getContextsByIds([parent, child, grandchild, unrelated])).map((r) => [r.id, r.version]),
    );
    await repo.bumpContextVersions(parentPath);
    const after = new Map(
      (await repo.getContextsByIds([parent, child, grandchild, unrelated])).map((r) => [r.id, r.version]),
    );
    expect(after.get(parent)).toBe(before.get(parent)! + 1);
    expect(after.get(child)).toBe(before.get(child)! + 1);
    expect(after.get(grandchild)).toBe(before.get(grandchild)! + 1);
    expect(after.get(unrelated)).toBe(before.get(unrelated));
  });

  it('xoá context thì đọc lại không còn', async () => {
    const row = await repo.insertContext({ contextLevel: 50, instanceId: randomUUID(), path: '', depth: 0 });
    await repo.deleteContext(row.id);
    await expect(repo.getContextById(row.id)).resolves.toBeUndefined();
  });
});

describe('capability', () => {
  it('upsertCapability chèn mới và cập nhật đúng trường khi trùng tên; listCapabilities sắp theo tên', async () => {
    const name = `g651-cap-${randomUUID()}`;
    await repo.upsertCapability({ name, capType: 'read', contextLevel: 50, component: 'test' });
    await repo.upsertCapability({ name, capType: 'write', contextLevel: 50, component: 'test' });
    const rows = await repo.listCapabilities();
    const found = rows.filter((r) => r.name === name);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name, capType: 'write', contextLevel: 50, component: 'test' });
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });

  it('deleteCapabilitiesNotIn chỉ xoá tên ngoài danh sách giữ lại', async () => {
    const keep = `g651-keep-${randomUUID()}`;
    const drop = `g651-drop-${randomUUID()}`;
    await repo.upsertCapability({ name: keep, capType: 'read', contextLevel: 50, component: 'test' });
    await repo.upsertCapability({ name: drop, capType: 'read', contextLevel: 50, component: 'test' });
    await repo.deleteCapabilitiesNotIn([keep]);
    const names = (await repo.listCapabilities()).map((r) => r.name);
    expect(names).toContain(keep);
    expect(names).not.toContain(drop);
  });
});

describe('role', () => {
  it('chèn role và đọc lại theo id và shortname; bỏ qua description/sortOrder thì nhận mặc định của bảng', async () => {
    const shortName = `g651-role-${randomUUID()}`;
    const row = await repo.insertRole({ name: 'Vai kiểm', shortName });
    expect(row.id).toMatch(UUIDV7_RE);
    expect(row.description).toBe('');
    expect(row.sortOrder).toBe(0);
    await expect(repo.getRoleById(row.id)).resolves.toMatchObject({ shortName });
    await expect(repo.getRoleByShortname(shortName)).resolves.toMatchObject({ id: row.id });
    await expect(repo.getRoleByShortname(`missing-${randomUUID()}`)).resolves.toBeUndefined();
  });

  it('listRoles sắp theo sortOrder; updateRole đổi đúng trường đã cho và giữ nguyên trường còn lại', async () => {
    const first = await repo.insertRole({ name: 'Vai sau', shortName: `g651-s1-${randomUUID()}`, sortOrder: 20 });
    const second = await repo.insertRole({ name: 'Vai trước', shortName: `g651-s2-${randomUUID()}`, sortOrder: 10 });
    const rows = await repo.listRoles();
    const idx = (id: string) => rows.findIndex((r) => r.id === id);
    expect(idx(second.id)).toBeLessThan(idx(first.id));
    await repo.updateRole(first.id, { name: 'Vai sau đã đổi' });
    await expect(repo.getRoleById(first.id)).resolves.toMatchObject({ name: 'Vai sau đã đổi', sortOrder: 20 });
  });

  it('deleteRole xoá role kèm gán và override của nó', async () => {
    const roleId = await makeRole(`g651-del-${randomUUID()}`);
    await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:view', permission: 1 });
    await repo.deleteRole(roleId);
    await expect(repo.getRoleById(roleId)).resolves.toBeUndefined();
    await expect(repo.listAssignmentsByRole(roleId)).resolves.toEqual([]);
    await expect(repo.listRoleCapabilities(roleId)).resolves.toEqual([]);
  });

  it('countDistinctUsersByRole đếm mỗi người một lần dù giữ cùng role ở nhiều context, trả number thật', async () => {
    const roleId = await makeRole(`g651-cnt-${randomUUID()}`);
    await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId, userId: userAId, contextId: tenantCtxId });
    await repo.insertAssignment({ roleId, userId: userBId, contextId: courseCtxId });
    const counts = await repo.countDistinctUsersByRole();
    const found = counts.find((c) => c.roleId === roleId);
    expect(found?.userCount).toBe(2);
    expect(typeof found?.userCount).toBe('number');
  });
});

describe('gán vai', () => {
  it('insertAssignment chèn gán; chèn trùng unique trả về dòng đã có thay vì lỗi, và đọc lại khớp đúng nguồn', async () => {
    const roleId = await makeRole(`g651-asg-${randomUUID()}`);
    const first = await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    expect(first.id).toMatch(UUIDV7_RE);
    expect(first.updatedAt).toBeInstanceOf(Date);
    const again = await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    expect(again.id).toBe(first.id);
    // Nguồn khác (component enrol) là dòng khác, và chèn trùng nguồn
    // đó phải đọc lại đúng dòng enrol — không được trả nhầm dòng tay.
    // itemId là cột uuid nên phải là uuid thật (id của instance enrol),
    // không dùng chuỗi giả như 'inst-1' (Postgres từ chối).
    const enrolItemId = randomUUID();
    const enrol = await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId, component: 'enrol', itemId: enrolItemId });
    expect(enrol.id).not.toBe(first.id);
    const enrolAgain = await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId, component: 'enrol', itemId: enrolItemId });
    expect(enrolAgain.id).toBe(enrol.id);
    await expect(repo.getAssignment(first.id)).resolves.toMatchObject({ id: first.id });
    await repo.deleteAssignment(enrol.id);
    await expect(repo.getAssignment(enrol.id)).resolves.toBeUndefined();
  });

  it('listAssignments lọc theo user và context; listAssignmentsByRole liệt kê mọi gán của role', async () => {
    const roleId = await makeRole(`g651-lst-${randomUUID()}`);
    await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId, userId: userBId, contextId: tenantCtxId });
    // Spec chạy chung một DB cho cả file nên userA/context tenant đã mang
    // gán từ các test trước — khẳng định lọc trên tập của chính role mới
    // tạo trong test này (cùng khuôn lọc theo roleId như test
    // listAllRoleCapabilitiesAtContext), không khẳng định tổng toàn cục.
    const byUser = (await repo.listAssignments({ userId: userAId })).filter((r) => r.roleId === roleId);
    expect(byUser).toHaveLength(1);
    const byContext = (await repo.listAssignments({ contextId: tenantCtxId })).filter((r) => r.roleId === roleId);
    expect(byContext).toHaveLength(1);
    await expect(repo.listAssignmentsByRole(roleId)).resolves.toHaveLength(2);
    await expect(repo.listAssignments({})).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ roleId })]));
  });

  it('getAssignmentsForUserInContexts chỉ trả gán trong các context đã cho; lô rỗng trả rỗng', async () => {
    const roleId = await makeRole(`g651-ctx-${randomUUID()}`);
    await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId, userId: userAId, contextId: tenantCtxId });
    const rows = await repo.getAssignmentsForUserInContexts(userAId, [courseCtxId]);
    // Như test trên: chỉ xét tập của role mới tạo, vì userA đã mang gán
    // ở courseCtxId từ các test trước trong cùng file.
    expect(rows.filter((r) => r.roleId === roleId).map((r) => r.contextId)).toEqual([courseCtxId]);
    await expect(repo.getAssignmentsForUserInContexts(userAId, [])).resolves.toEqual([]);
  });

  it('listAssignmentsPage: lọc, tìm kiếm theo tên đầy đủ ghép họ tên, dòng gán mồ côi vẫn liệt kê kèm tên null, phân trang và tổng số', async () => {
    const roleId = await makeRole(`g651-pg-${randomUUID()}`);
    await repo.insertAssignment({ roleId, userId: userAId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId, userId: userBId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId, userId: randomUUID(), contextId: courseCtxId });
    const page = await repo.listAssignmentsPage({ roleId }, 1, 2);
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(2);
    const all = await repo.listAssignmentsPage({ roleId }, 1, 10);
    expect(all.rows).toHaveLength(3);
    const orphan = all.rows.find((r) => r.userName === null);
    expect(orphan).toMatchObject({ userEmail: null });
    const byFullName = await repo.listAssignmentsPage({ roleId, search: 'Van A' }, 1, 10);
    expect(byFullName.rows.map((r) => r.userId)).toEqual([userAId]);
    const byEmail = await repo.listAssignmentsPage({ roleId, search: 'g651-b@' }, 1, 10);
    expect(byEmail.rows.map((r) => r.userId)).toEqual([userBId]);
    const secondPage = await repo.listAssignmentsPage({ roleId }, 2, 2);
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.total).toBe(3);
  });

  it('listUsersWithAssignmentsPage: trạng thái suy từ cờ, lọc vai bằng EXISTS không cắt mảng gán, phân trang theo người dùng', async () => {
    const roleX = await makeRole(`g651-ux-${randomUUID()}`);
    const roleY = await makeRole(`g651-uy-${randomUUID()}`);
    await repo.insertAssignment({ roleId: roleX, userId: userAId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId: roleY, userId: userAId, contextId: tenantCtxId });
    await repo.insertAssignment({ roleId: roleX, userId: userCId, contextId: courseCtxId });
    await repo.insertAssignment({ roleId: roleX, userId: userDId, contextId: courseCtxId });
    const filtered = await repo.listUsersWithAssignmentsPage({ roleId: roleX, status: 'active' }, 1, 10);
    expect(filtered.rows.map((r) => r.id)).toEqual([userAId]);
    // Người A vẫn mang đủ cả hai gán dù lọc theo roleX — mảng gán trả về
    // là toàn bộ gán của người đó nên chỉ xét tập của hai role mới tạo
    // trong test này (userA đã mang gán từ các test trước cùng file).
    const ownAssignments = filtered.rows[0]!.assignments.filter((a) => a.roleId === roleX || a.roleId === roleY);
    expect(ownAssignments.map((a) => a.roleId).sort()).toEqual([roleX, roleY].sort());
    expect(ownAssignments[0]).toMatchObject({ roleName: expect.any(String), contextLevel: expect.any(Number) });
    const suspended = await repo.listUsersWithAssignmentsPage({ status: 'suspended' }, 1, 10);
    expect(suspended.rows.map((r) => r.id)).toContain(userCId);
    expect(suspended.rows.map((r) => r.id)).not.toContain(userAId);
    const deleted = await repo.listUsersWithAssignmentsPage({ status: 'deleted' }, 1, 10);
    expect(deleted.rows.map((r) => r.id)).toContain(userDId);
    const noStatus = await repo.listUsersWithAssignmentsPage({}, 1, 10);
    expect(noStatus.rows.map((r) => r.id)).toContain(userAId);
    expect(noStatus.rows.map((r) => r.id)).toContain(userCId);
    expect(noStatus.rows.map((r) => r.id)).not.toContain(userDId);
    const searched = await repo.listUsersWithAssignmentsPage({ search: 'Van A' }, 1, 10);
    expect(searched.rows.map((r) => r.id)).toEqual([userAId]);
    const paged = await repo.listUsersWithAssignmentsPage({ roleId: roleX }, 1, 1);
    expect(paged.rows).toHaveLength(1);
    expect(paged.total).toBe(2);
  });
});

describe('override capability', () => {
  it('upsertRoleCapability chèn mới và ghi đè theo khoá phức hợp 3 cột; deleteRoleCapability xoá đúng dòng', async () => {
    const roleId = await makeRole(`g651-ov-${randomUUID()}`);
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:view', permission: 1 });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:view', permission: -1 });
    const rows = await repo.listRoleCapabilities(roleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ capability: 'test:view', permission: -1 });
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
    await repo.deleteRoleCapability(courseCtxId, roleId, 'test:view');
    await expect(repo.listRoleCapabilities(roleId)).resolves.toEqual([]);
  });

  it('getOverridesForRoles và getOverridesForRolesInContexts: bảo vệ rỗng, lọc đúng capability và đúng tập context', async () => {
    const roleId = await makeRole(`g651-ov2-${randomUUID()}`);
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:view', permission: 1 });
    await repo.upsertRoleCapability({ contextId: tenantCtxId, roleId, capability: 'test:edit', permission: 1 });
    await expect(repo.getOverridesForRoles([], 'test:view', [courseCtxId])).resolves.toEqual([]);
    await expect(repo.getOverridesForRoles([roleId], 'test:view', [])).resolves.toEqual([]);
    await expect(repo.getOverridesForRoles([roleId], 'test:view', [courseCtxId, tenantCtxId])).resolves.toHaveLength(1);
    await expect(repo.getOverridesForRolesInContexts([roleId], [courseCtxId, tenantCtxId])).resolves.toHaveLength(2);
    await expect(repo.getOverridesForRolesInContexts([roleId], [courseCtxId])).resolves.toHaveLength(1);
  });

  it('deleteRoleCapabilitiesAtContext chỉ xoá tên trong danh sách tại đúng context; deleteRoleCapabilitiesInContext xoá trọn tập của cặp role-context', async () => {
    const roleId = await makeRole(`g651-ov3-${randomUUID()}`);
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:a', permission: 1 });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:b', permission: 1 });
    await repo.upsertRoleCapability({ contextId: tenantCtxId, roleId, capability: 'test:a', permission: 1 });
    await repo.deleteRoleCapabilitiesAtContext(roleId, courseCtxId, ['test:a']);
    await expect(repo.listRoleCapabilitiesAtContext(roleId, courseCtxId)).resolves.toHaveLength(1);
    await expect(repo.listRoleCapabilitiesAtContext(roleId, tenantCtxId)).resolves.toHaveLength(1);
    await repo.deleteRoleCapabilitiesInContext(roleId, tenantCtxId);
    await expect(repo.listRoleCapabilitiesAtContext(roleId, tenantCtxId)).resolves.toEqual([]);
    await expect(repo.listRoleCapabilitiesAtContext(roleId, courseCtxId)).resolves.toHaveLength(1);
  });

  it('listAllRoleCapabilitiesAtContext chỉ trả ghi đè của đúng context, sắp theo tên năng lực', async () => {
    const roleId = await makeRole(`g651-ov4-${randomUUID()}`);
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:z', permission: 1 });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:a', permission: 1 });
    await repo.upsertRoleCapability({ contextId: tenantCtxId, roleId, capability: 'test:m', permission: 1 });
    const rows = await repo.listAllRoleCapabilitiesAtContext(courseCtxId);
    expect(rows.filter((r) => r.roleId === roleId).map((r) => r.capability)).toEqual(['test:a', 'test:z']);
  });

  it('deleteRoleCapabilitiesNotIn xoá override trỏ tới capability ngoài danh sách giữ lại', async () => {
    const roleId = await makeRole(`g651-ov5-${randomUUID()}`);
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:keep', permission: 1 });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'test:drop', permission: 1 });
    await repo.deleteRoleCapabilitiesNotIn(['test:keep']);
    await expect(repo.listRoleCapabilities(roleId)).resolves.toHaveLength(1);
  });

  it('getRoleOverrideAggregates: tổng, read/write theo capType, resource theo tiền tố trước dấu hai chấm; capability ngoài danh mục tính vào tổng và resource nhưng không vào read/write', async () => {
    const roleId = await makeRole(`g651-agg-${randomUUID()}`);
    const readCap = `g651-agg-read-${randomUUID()}`;
    const writeCap = `g651-agg-write-${randomUUID()}`;
    await repo.upsertCapability({ name: readCap, capType: 'read', contextLevel: 50, component: 'test' });
    await repo.upsertCapability({ name: writeCap, capType: 'write', contextLevel: 50, component: 'test' });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: readCap, permission: 1 });
    await repo.upsertRoleCapability({ contextId: tenantCtxId, roleId, capability: readCap, permission: 1 });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: writeCap, permission: 1 });
    await repo.upsertRoleCapability({ contextId: courseCtxId, roleId, capability: 'unknown:thing', permission: 1 });
    const aggregates = await repo.getRoleOverrideAggregates();
    const found = aggregates.find((a) => a.roleId === roleId);
    // Resource = `split_part(capability, ':', 1)` trên MỌI ghi đè (đúng
    // hành vi bản cũ trước chuyển đổi, PR #549): hai tên không có dấu hai chấm
    // thành hai resource riêng, cộng `unknown` từ `unknown:thing` = 3.
    // Chỉ cột read/write mới loại capability ngoài danh mục (ghép trái
    // không thấy capType); ghi đè ngoài danh mục vẫn tính vào tổng.
    expect(found).toMatchObject({ overrideCount: 4, readOverrideCount: 2, writeOverrideCount: 1, resourceCount: 3 });
  });
});

describe('config', () => {
  it('getConfigValue trả undefined khi chưa có; setConfigValue chèn và ghi đè theo key, giữ nguyên mảng jsonb cấp cao nhất', async () => {
    const key = `g651-cfg-${randomUUID()}`;
    await expect(repo.getConfigValue(key)).resolves.toBeUndefined();
    await repo.setConfigValue(key, ['user-a', 'user-b']);
    await expect(repo.getConfigValue(key)).resolves.toEqual(['user-a', 'user-b']);
    await repo.setConfigValue(key, { version: 2 });
    await expect(repo.getConfigValue(key)).resolves.toEqual({ version: 2 });
  });
});

describe('cổng tenant', () => {
  it('getTenantGateInfo(s) và getMembershipStatus(es) đọc thuần đúng dữ kiện, vắng mặt trả undefined/rỗng, lô rỗng trả rỗng', async () => {
    await expect(repo.getTenantGateInfo(tenantId)).resolves.toEqual({ kind: 'center', status: 'active' });
    await expect(repo.getTenantGateInfo(randomUUID())).resolves.toBeUndefined();
    await expect(repo.getMembershipStatus(tenantId, userAId)).resolves.toBe('active');
    await expect(repo.getMembershipStatus(tenantId, userCId)).resolves.toBeUndefined();
    await expect(repo.getTenantGateInfos([tenantId])).resolves.toEqual([{ id: tenantId, kind: 'center', status: 'active' }]);
    await expect(repo.getTenantGateInfos([])).resolves.toEqual([]);
    await expect(repo.getMembershipStatuses([tenantId], userAId)).resolves.toEqual([{ tenantId, status: 'active' }]);
    await expect(repo.getMembershipStatuses([], userAId)).resolves.toEqual([]);
  });
});

describe('transaction', () => {
  it('transaction rollback huỷ toàn bộ ghi khi hàm ném lỗi', async () => {
    const instanceId = randomUUID();
    const shortName = `g651-tx-${randomUUID()}`;
    await expect(repo.transaction(async (tx) => {
      await repo.insertContext({ contextLevel: 50, instanceId, path: '', depth: 0 }, tx);
      await repo.insertRole({ name: 'Vai rollback', shortName }, tx);
      throw new Error('rollback-test');
    })).rejects.toThrow('rollback-test');
    await expect(repo.getContextByLevelInstance(50, instanceId)).resolves.toBeUndefined();
    await expect(repo.getRoleByShortname(shortName)).resolves.toBeUndefined();
  });

  it('ghi trong transaction thấy được sau khi commit', async () => {
    const instanceId = randomUUID();
    const row = await repo.transaction(async (tx) => {
      const created = await repo.insertContext({ contextLevel: 50, instanceId, path: '', depth: 0 }, tx);
      await repo.updateContextPath(created.id, `/${created.id}`, 1, tx);
      return created;
    });
    await expect(repo.getContextById(row.id)).resolves.toMatchObject({ path: `/${row.id}`, depth: 1 });
  });
});
