import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCentreKysely, type CentreDb } from '../client';
import { tenantConfig, tenants } from '../tenants.schema';
import { users } from '../users.schema';
import { config } from '../infrastructure.schema';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { AuthRepository } from './auth';
import { CentreIdentityRepository } from './centre-identity';
import { SiteConfigRepository } from './site-config';
import { TenantsRepository } from './tenants';
import { UsersRepository } from './users';

/**
 * Spec tích hợp của nhóm G1 chiến dịch Kysely (issue #641): năm
 * repository của cụm người dùng và trung tâm (auth, users, tenants,
 * centre-identity, site-config) chạy trên database kho trung tâm
 * dựng từ rỗng bằng chính cầu nối migration của package, qua
 * repository production — không mô phỏng handle.
 *
 * Ngoài đối chiếu hành vi từng repository, spec này chốt các điểm
 * đo mà thân issue #641 phân bổ cho nhóm:
 * - Điểm nóng site-config: tương đương của upsert từng phần ở tầng
 *   platform (vị từ chỉ số duy nhất riêng phần trên `plugin_config`)
 *   — cập nhật đúng khi điều kiện đích khớp, dòng tenant trùng
 *   `(plugin, name)` không bị đường ghi platform chạm tới.
 * - T-13 (hai ca điều kiện động của nhóm): `users.search` (nhóm OR
 *   của từ khoá + lọc trạng thái + đếm khớp trang) và
 *   `site-config.listAudit` (có/không có khoá lọc).
 * - T-4: patch cập nhật mang trường `undefined` tường minh không
 *   được ghi đè giá trị đang có.
 * - U5: insert không truyền id nhận id UUIDv7 qua `returning`;
 *   insert có id tường minh giữ nguyên id.
 * - T-7 (mở rộng cho kho trung tâm): cùng một dòng đọc qua Drizzle
 *   và qua Kysely cho kiểu runtime khớp nhau ở các cột đại diện
 *   của cụm (timestamptz, jsonb — object lẫn mảng ở cấp trên cùng,
 *   boolean, uuid, text) và khẳng định bề mặt int8 của cụm: mười
 *   bốn bảng của cụm không có cột bigint nào (đo tại
 *   information_schema), nên luật int8-đọc-là-string không có bề
 *   mặt trong cụm này.
 */
const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL
    ? withDatabase(process.env.DATABASE_URL, 'postgres')
    : 'postgres://postgres:postgres@localhost:5432/postgres');

const CENTRE_DB = 'lms_db_g641_centre';

const UUIDV7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let pool: Pool;
let db: CentreDb;
let drizzleDb: NodePgDatabase;
let authRepo: AuthRepository;
let usersRepo: UsersRepository;
let tenantsRepo: TenantsRepository;
let centreRepo: CentreIdentityRepository;
let siteConfigRepo: SiteConfigRepository;

let tenantId = '';
let otherTenantId = '';

beforeAll(async () => {
  const storeUrl = await buildTestDatabase({ adminUrl, database: CENTRE_DB, store: 'centre' });
  pool = new Pool({ connectionString: storeUrl });
  db = createCentreKysely(pool);
  drizzleDb = drizzle({ client: pool });
  authRepo = new AuthRepository(db);
  usersRepo = new UsersRepository(db);
  tenantsRepo = new TenantsRepository(db);
  centreRepo = new CentreIdentityRepository(db);
  siteConfigRepo = new SiteConfigRepository(db);
  const tenant = await tenantsRepo.insertTenant({ slug: 'g641-chinh', name: 'Trung tâm chính G641', kind: 'center', status: 'active', plan: null });
  tenantId = tenant.id;
  const other = await tenantsRepo.insertTenant({ slug: 'g641-phu', name: 'Trung tâm phụ G641', kind: 'center', status: 'active', plan: null });
  otherTenantId = other.id;
}, 180_000);

afterAll(async () => {
  await db.destroy().catch(() => undefined);
  await dropTestDatabase(adminUrl, CENTRE_DB).catch(() => undefined);
});

/** Tạo một user qua repository với username/email suy từ hậu tố cho trước. */
async function makeUser(suffix: string, patch: { firstName?: string; lastName?: string } = {}) {
  return usersRepo.insertUser({
    username: `g641_${suffix}`,
    email: `g641_${suffix}@example.test`,
    passwordHash: 'hash',
    firstName: patch.firstName ?? 'Tên',
    lastName: patch.lastName ?? suffix,
  });
}

describe('AuthRepository — họ refresh token, TOTP, liên kết OAuth, nhật ký đăng nhập', () => {
  it('tạo family: insert không truyền id nhận id UUIDv7 qua returning, đọc lại được bằng hash hiện tại', async () => {
    const user = await makeUser('auth-family');
    const family = await authRepo.createFamily({
      familyId: 'fam-g641-1',
      userId: user.id,
      tenantId,
      ip: '127.0.0.1',
      userAgent: 'vitest',
      currentTokenHash: 'hash-hien-tai-1',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    expect(family.id).toMatch(UUIDV7_PATTERN);
    expect(family.familyId).toBe('fam-g641-1');
    expect(family.tenantId).toBe(tenantId);
    expect(family.revoked).toBe(false);
    expect(family.createdAt).toBeInstanceOf(Date);

    const byHash = await authRepo.getFamilyByHash('hash-hien-tai-1');
    expect(byHash?.id).toBe(family.id);
    const byId = await authRepo.getFamilyByFamilyId('fam-g641-1');
    expect(byId?.id).toBe(family.id);
  });

  it('xoay family: hash cũ vẫn tra được family, thu hồi từng family và toàn bộ family của user có hiệu lực', async () => {
    const user = await makeUser('auth-rotate');
    const family = await authRepo.createFamily({
      familyId: 'fam-g641-2',
      userId: user.id,
      currentTokenHash: 'hash-cu-2',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await authRepo.rotateFamily(family.id, 'hash-moi-2', 'hash-cu-2');
    const rotated = await authRepo.getFamilyByHash('hash-cu-2');
    expect(rotated?.id).toBe(family.id);
    expect(rotated?.currentTokenHash).toBe('hash-moi-2');
    expect(rotated?.previousTokenHash).toBe('hash-cu-2');

    const active = await authRepo.listActiveFamiliesByUser(user.id);
    expect(active.map((f) => f.id)).toContain(family.id);

    const kept = await authRepo.revokeOthersForUser(user.id, 'fam-khac');
    expect(kept).toBe(1);
    expect(await authRepo.listActiveFamiliesByUser(user.id)).toHaveLength(0);

    const second = await authRepo.createFamily({
      familyId: 'fam-g641-3',
      userId: user.id,
      currentTokenHash: 'hash-3',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await authRepo.setFamilyTenant(second.id, otherTenantId);
    expect((await authRepo.getFamilyById('fam-g641-3'))?.tenantId).toBe(otherTenantId);
    await authRepo.revokeAllForUser(user.id);
    expect(await authRepo.listActiveFamiliesByUser(user.id)).toHaveLength(0);
  });

  it('TOTP: upsert lần đầu chèn mới, upsert lại thay secret và đưa trạng thái về chưa xác nhận trên cùng một dòng', async () => {
    const user = await makeUser('auth-totp');
    const first = await authRepo.upsertPendingTotp(user.id, 'secret-ma-hoa-1');
    expect(first.confirmed).toBe(false);
    await authRepo.confirmTotp(user.id);
    const confirmed = await authRepo.getTotpByUserId(user.id);
    expect(confirmed?.confirmed).toBe(true);
    expect(confirmed?.confirmedAt).toBeInstanceOf(Date);

    const replaced = await authRepo.upsertPendingTotp(user.id, 'secret-ma-hoa-2');
    expect(replaced.id).toBe(first.id);
    expect(replaced.secretEncrypted).toBe('secret-ma-hoa-2');
    expect(replaced.confirmed).toBe(false);
    expect(replaced.confirmedAt).toBeNull();

    await authRepo.deleteTotp(user.id);
    expect(await authRepo.getTotpByUserId(user.id)).toBeUndefined();
  });

  it('liên kết OAuth: tạo, tra theo tài khoản provider, liệt kê theo user và xoá', async () => {
    const user = await makeUser('auth-oauth');
    const link = await authRepo.createOauthLink({
      userId: user.id,
      issuer: 'https://issuer.example.test',
      issuerUserId: 'subject-1',
      email: 'ngoai@example.test',
    });
    expect(link.id).toMatch(UUIDV7_PATTERN);
    const bySubject = await authRepo.getOauthLinkBySubject('https://issuer.example.test', 'subject-1');
    expect(bySubject?.id).toBe(link.id);
    expect(await authRepo.listOauthLinksByUser(user.id)).toHaveLength(1);
    expect((await authRepo.getOauthLinkById(link.id))?.email).toBe('ngoai@example.test');
    await authRepo.deleteOauthLink(link.id);
    expect(await authRepo.getOauthLinkById(link.id)).toBeUndefined();
  });

  it('nhật ký đăng nhập: lần thử thất bại gần đây mới nhất trước, và thời điểm đăng nhập thành công gần nhất', async () => {
    const user = await makeUser('auth-attempts');
    const since = new Date(Date.now() - 60_000);
    await authRepo.recordAttempt({ userId: user.id, username: user.username, success: false, ip: '10.0.0.1' });
    await authRepo.recordAttempt({ userId: user.id, username: user.username, success: true, ip: '10.0.0.1' });
    await authRepo.recordAttempt({ userId: user.id, username: user.username, success: false });
    const failed = await authRepo.recentFailedAttempts(user.id, since);
    expect(failed).toHaveLength(2);
    expect(failed.every((a) => a.success === false)).toBe(true);
    const lastOk = await authRepo.lastSuccessfulAttemptAt(user.id);
    expect(lastOk).toBeInstanceOf(Date);
  });
});

describe('UsersRepository — hồ sơ, transaction, tìm kiếm động (T-13) và tuỳ chọn', () => {
  it('U5: insert có id tường minh giữ nguyên id; đọc theo username/email/danh sách id', async () => {
    const explicitId = '01a19887-6b35-7760-8e64-a5960bfd0875';
    const user = await usersRepo.insertUser({
      id: explicitId,
      username: 'g641_explicit',
      email: 'g641_explicit@example.test',
      passwordHash: null,
    });
    expect(user.id).toBe(explicitId);
    expect((await usersRepo.getByUsername('g641_explicit'))?.id).toBe(explicitId);
    expect((await usersRepo.getByEmail('g641_explicit@example.test'))?.id).toBe(explicitId);
    const batch = await usersRepo.getByIds([explicitId, '01a19887-6b35-7760-8e64-a5960bfd0999']);
    expect(batch).toHaveLength(1);
    expect(await usersRepo.getByIds([])).toEqual([]);
  });

  it('T-4: cập nhật từng phần chỉ đổi trường có mặt — trường undefined tường minh không ghi đè giá trị đang có', async () => {
    const user = await makeUser('t4-patch', { firstName: 'Trước', lastName: 'GiữNguyên' });
    await usersRepo.updateUser(user.id, { firstName: 'Sau', lastName: undefined });
    const after = await usersRepo.getById(user.id);
    expect(after?.firstName).toBe('Sau');
    expect(after?.lastName).toBe('GiữNguyên');
    expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(user.updatedAt.getTime());
  });

  it('transaction của repository: commit giữ dữ kiện và trả giá trị của callback, rollback xoá sạch dữ kiện đã ghi trong transaction', async () => {
    const committed = await usersRepo.transaction(async (tx) => {
      const created = await usersRepo.insertUser(
        { username: 'g641_tx_commit', email: 'g641_tx_commit@example.test', passwordHash: 'hash' },
        tx,
      );
      return created;
    });
    expect((await usersRepo.getById(committed.id))?.username).toBe('g641_tx_commit');

    await expect(usersRepo.transaction(async (tx) => {
      await usersRepo.insertUser(
        { username: 'g641_tx_rollback', email: 'g641_tx_rollback@example.test', passwordHash: 'hash' },
        tx,
      );
      throw new Error('ép rollback');
    })).rejects.toThrow('ép rollback');
    expect(await usersRepo.getByUsername('g641_tx_rollback')).toBeUndefined();
  });

  it('T-13 search: nhóm OR của từ khoá khớp username/email/họ tên, lọc trạng thái và tổng đếm khớp với trang trả về', async () => {
    const an = await usersRepo.insertUser({ username: 'timkiem_an', email: 'an.tim@example.test', passwordHash: 'h', firstName: 'An', lastName: 'Nguyễn' });
    const binh = await usersRepo.insertUser({ username: 'timkiem_binh', email: 'binh@example.test', passwordHash: 'h', firstName: 'Bình', lastName: 'Trần' });
    await usersRepo.updateUser(binh.id, { suspended: true });
    const cuong = await usersRepo.insertUser({ username: 'timkiem_cuong', email: 'cuong@example.test', passwordHash: 'h', firstName: 'Cường', lastName: 'An' });
    await usersRepo.updateUser(cuong.id, { deleted: true, suspended: true });

    // Từ khoá "timkiem" khớp cả ba qua username nhưng mặc định ẩn tài khoản đã xoá.
    const all = await usersRepo.search('timkiem', 1, 10);
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.id).sort()).toEqual([an.id, binh.id].sort());

    // Nhóm OR: từ khoá chỉ khớp qua họ (lastName) vẫn tìm thấy.
    const byName = await usersRepo.search('Nguyễn', 1, 10);
    expect(byName.rows.map((r) => r.id)).toContain(an.id);

    // Lọc trạng thái: active loại tài khoản đình chỉ, suspended chỉ lấy đình chỉ, deleted chỉ lấy đã xoá.
    const active = await usersRepo.search('timkiem', 1, 10, { status: 'active' });
    expect(active.rows.map((r) => r.id)).toEqual([an.id]);
    const suspended = await usersRepo.search('timkiem', 1, 10, { status: 'suspended' });
    expect(suspended.rows.map((r) => r.id)).toEqual([binh.id]);
    const deleted = await usersRepo.search('timkiem', 1, 10, { status: 'deleted' });
    expect(deleted.rows.map((r) => r.id)).toEqual([cuong.id]);

    // Phân trang: tổng đếm giữ nguyên khi cắt trang.
    const page2 = await usersRepo.search('timkiem', 2, 1);
    expect(page2.total).toBe(2);
    expect(page2.rows).toHaveLength(1);
  });

  it('T-13 search: sắp xếp theo tên/tạo/đăng nhập với chiều chỉ định và neo id tăng dần ở cuối', async () => {
    const older = await usersRepo.insertUser({
      username: 'sapxep_cu', email: 'sapxep_cu@example.test', passwordHash: 'h',
      firstName: 'Bê', lastName: 'Hai', createdAt: new Date('2026-01-01T00:00:00.000Z'), lastLogin: new Date('2026-02-01T00:00:00.000Z'),
    });
    const newer = await usersRepo.insertUser({
      username: 'sapxep_moi', email: 'sapxep_moi@example.test', passwordHash: 'h',
      firstName: 'A', lastName: 'Một', createdAt: new Date('2026-03-01T00:00:00.000Z'), lastLogin: new Date('2026-01-01T00:00:00.000Z'),
    });
    const byName = await usersRepo.search('sapxep', 1, 10, { sortBy: 'name' });
    expect(byName.rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    const byCreatedDesc = await usersRepo.search('sapxep', 1, 10, { sortBy: 'createdAt', sortDirection: 'desc' });
    expect(byCreatedDesc.rows.map((r) => r.id)).toEqual([newer.id, older.id]);
    const byLoginAsc = await usersRepo.search('sapxep', 1, 10, { sortBy: 'lastLogin' });
    expect(byLoginAsc.rows.map((r) => r.id)).toEqual([newer.id, older.id]);
  });

  it('tuỳ chọn cá nhân: ghi lần đầu chèn mới, ghi lại cùng tên cập nhật giá trị, đọc tên chưa đặt cho undefined', async () => {
    const user = await makeUser('prefs');
    expect(await usersRepo.getPreference(user.id, 'theme')).toBeUndefined();
    await usersRepo.setPreference(user.id, 'theme', 'dark');
    expect(await usersRepo.getPreference(user.id, 'theme')).toBe('dark');
    await usersRepo.setPreference(user.id, 'theme', null);
    expect(await usersRepo.getPreference(user.id, 'theme')).toBeNull();
  });
});

describe('TenantsRepository — vòng đời tenant, membership và cấu hình jsonb', () => {
  it('cập nhật tenant từng phần: chỉ trường có mặt đổi, mốc updated_at được đóng dấu lại', async () => {
    const tenant = await tenantsRepo.insertTenant({ slug: 'g641-sua', name: 'Tên cũ', kind: 'center', status: 'active', plan: 'basic' });
    await tenantsRepo.updateTenant(tenant.id, { name: 'Tên mới', plan: undefined });
    const after = await tenantsRepo.getTenant(tenant.id);
    expect(after?.name).toBe('Tên mới');
    expect(after?.plan).toBe('basic');
    expect(after?.slug).toBe('g641-sua');
    const listed = await tenantsRepo.listTenants();
    expect(listed.map((t) => t.id)).toContain(tenant.id);
  });

  it('membership: tạo, tra theo cặp tenant+user, liệt kê hai chiều và cập nhật trạng thái kết thúc', async () => {
    const user = await makeUser('membership');
    const membership = await tenantsRepo.insertMembership({ tenantId, userId: user.id, status: 'active' });
    expect(membership.id).toMatch(UUIDV7_PATTERN);
    expect((await tenantsRepo.getMembership(tenantId, user.id))?.id).toBe(membership.id);
    expect((await tenantsRepo.listMembershipsForUser(user.id)).map((m) => m.id)).toContain(membership.id);
    expect((await tenantsRepo.listMembershipsForTenant(tenantId)).map((m) => m.id)).toContain(membership.id);
    const endedAt = new Date();
    await tenantsRepo.updateMembership(membership.id, { status: 'ended', endedAt });
    const after = await tenantsRepo.getMembership(tenantId, user.id);
    expect(after?.status).toBe('ended');
    expect(after?.endedAt?.toISOString()).toBe(endedAt.toISOString());
  });

  it('cấu hình tenant: upsert giá trị jsonb dạng object và dạng mảng ở cấp trên cùng, đọc lại khớp, xoá thì hết', async () => {
    await tenantsRepo.upsertConfigValue(tenantId, 'g641.object', { muc: [1, 2], bat: true });
    const objectRow = await tenantsRepo.getConfigValue(tenantId, 'g641.object');
    expect(objectRow?.value).toEqual({ muc: [1, 2], bat: true });

    // Mảng ở cấp cao nhất là ca driver pg xử lý khác object thường —
    // helper serialize + ::jsonb của repository phải giữ nguyên giá trị.
    await tenantsRepo.upsertConfigValue(tenantId, 'g641.array', ['a', 'b']);
    const arrayRow = await tenantsRepo.getConfigValue(tenantId, 'g641.array');
    expect(arrayRow?.value).toEqual(['a', 'b']);

    await tenantsRepo.upsertConfigValue(tenantId, 'g641.object', { muc: [3], bat: false });
    expect((await tenantsRepo.getConfigValue(tenantId, 'g641.object'))?.value).toEqual({ muc: [3], bat: false });
    const forTenant = await tenantsRepo.listConfigForTenant(tenantId);
    expect(forTenant.map((r) => r.key)).toEqual(expect.arrayContaining(['g641.object', 'g641.array']));

    await tenantsRepo.deleteConfigValue(tenantId, 'g641.array');
    expect(await tenantsRepo.getConfigValue(tenantId, 'g641.array')).toBeUndefined();
  });
});

describe('CentreIdentityRepository — nhận diện, lời mời và danh sách quản trị của kho', () => {
  it('nhận diện: tạo mới khi chưa có, cập nhật từng phần giữ nguyên trường không truyền', async () => {
    const created = await centreRepo.upsertIdentity(tenantId, { displayName: 'Trung tâm G641', logoPath: null, brandColor: '#123456' });
    expect(created.displayName).toBe('Trung tâm G641');
    const updated = await centreRepo.upsertIdentity(tenantId, { brandColor: '#654321' });
    expect(updated.id).toBe(created.id);
    expect(updated.displayName).toBe('Trung tâm G641');
    expect(updated.brandColor).toBe('#654321');
    expect((await centreRepo.getIdentity(tenantId))?.id).toBe(created.id);
    expect(await centreRepo.getIdentity(otherTenantId)).toBeUndefined();
  });

  it('lời mời: đánh dấu đã dùng là nguyên tử — lượt thứ hai không đốt lại được; thu hồi chỉ chạm lời mời đang chờ', async () => {
    const user = await makeUser('invite');
    const expires = new Date(Date.now() + 3_600_000);
    const inserted = await db
      .insertInto('centre_invites')
      .values({ tenant_id: tenantId, user_id: user.id, email: user.email, token_hash: 'hash-moi-1', expires_at: expires })
      .returning(['id'])
      .execute();
    const inviteId = inserted[0]!.id;
    const found = await centreRepo.findInviteByTokenHash('hash-moi-1');
    expect(found?.id).toBe(inviteId);

    const used = await centreRepo.markInviteUsed(inviteId);
    expect(used?.usedAt).toBeInstanceOf(Date);
    expect(await centreRepo.markInviteUsed(inviteId)).toBeUndefined();

    const second = await db
      .insertInto('centre_invites')
      .values({ tenant_id: tenantId, user_id: user.id, email: user.email, token_hash: 'hash-moi-2', expires_at: expires })
      .returning(['id'])
      .execute();
    await centreRepo.revokePendingInvites(user.id);
    const afterRevoke = await centreRepo.findInviteByTokenHash('hash-moi-2');
    expect(afterRevoke?.revokedAt).toBeInstanceOf(Date);
    expect(afterRevoke?.id).toBe(second[0]!.id);
    // Lời mời đã dùng không bị thu hồi kéo theo.
    const usedAfter = await centreRepo.findInviteByTokenHash('hash-moi-1');
    expect(usedAfter?.revokedAt).toBeNull();
  });

  it('danh sách quản trị đọc thẳng từ config của kho: chỉ giữ phần tử chuỗi của mảng jsonb', async () => {
    await siteConfigRepo.storeValue('core', 'siteadmins', ['admin-1', 'admin-2', 42, null]);
    expect(await centreRepo.listSiteAdmins()).toEqual(['admin-1', 'admin-2']);
  });
});

describe('SiteConfigRepository — điểm nóng upsert từng phần, vết audit và điều kiện động (T-13)', () => {
  it('điểm nóng plugin: ghi lần đầu chèn dòng platform, ghi lại cập nhật đúng dòng đó thay vì tạo dòng thứ hai', async () => {
    await siteConfigRepo.storeValue('g641plug', 'mau', { nen: 'xanh' });
    expect(await siteConfigRepo.getStoredValue('g641plug', 'mau')).toEqual({ nen: 'xanh' });
    await siteConfigRepo.storeValue('g641plug', 'mau', { nen: 'do' });
    expect(await siteConfigRepo.getStoredValue('g641plug', 'mau')).toEqual({ nen: 'do' });
    const rows = await db
      .selectFrom('plugin_config')
      .select(['id'])
      .where('plugin', '=', 'g641plug')
      .where('name', '=', 'mau')
      .where('tenant_id', 'is', null)
      .execute();
    expect(rows).toHaveLength(1);
  });

  it('điểm nóng plugin: dòng tenant trùng (plugin, name) không bị đường ghi platform chạm tới và ngược lại khi xoá', async () => {
    await db
      .insertInto('plugin_config')
      .values({ plugin: 'g641plug', name: 'rieng', tenant_id: tenantId, value: JSON.stringify({ phamVi: 'tenant' }) })
      .execute();
    await siteConfigRepo.storeValue('g641plug', 'rieng', { phamVi: 'platform' });
    expect(await siteConfigRepo.getStoredValue('g641plug', 'rieng')).toEqual({ phamVi: 'platform' });
    const tenantRow = await db
      .selectFrom('plugin_config')
      .select(['value'])
      .where('plugin', '=', 'g641plug')
      .where('name', '=', 'rieng')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    expect(tenantRow?.value).toBe(JSON.stringify({ phamVi: 'tenant' }));

    await siteConfigRepo.deleteValue('g641plug', 'rieng');
    expect(await siteConfigRepo.getStoredValue('g641plug', 'rieng')).toBeUndefined();
    const tenantAfter = await db
      .selectFrom('plugin_config')
      .select(['value'])
      .where('plugin', '=', 'g641plug')
      .where('name', '=', 'rieng')
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    expect(tenantAfter?.value).toBe(JSON.stringify({ phamVi: 'tenant' }));
  });

  it('core: ghi/đọc/xoá giá trị jsonb dạng object và dạng mảng qua bảng config', async () => {
    await siteConfigRepo.storeValue('core', 'g641.core.object', { bat: true, danhSach: [1, 2] });
    expect(await siteConfigRepo.getStoredValue('core', 'g641.core.object')).toEqual({ bat: true, danhSach: [1, 2] });
    await siteConfigRepo.storeValue('core', 'g641.core.array', ['x', 'y']);
    expect(await siteConfigRepo.getStoredValue('core', 'g641.core.array')).toEqual(['x', 'y']);
    await siteConfigRepo.deleteValue('core', 'g641.core.object');
    expect(await siteConfigRepo.getStoredValue('core', 'g641.core.object')).toBeUndefined();
  });

  it('T-13 listAudit: không khoá lọc trả mọi vết mới nhất trước; có khoá lọc chỉ trả vết của khoá đó', async () => {
    await siteConfigRepo.insertAudit({ settingKey: 'g641.audit.mot', oldValue: null, newValue: { v: 1 }, changedBy: 'admin-g641' });
    await siteConfigRepo.insertAudit({ settingKey: 'g641.audit.hai', oldValue: { v: 1 }, newValue: ['a'], changedBy: 'admin-g641', tenantId });
    const all = await siteConfigRepo.listAudit();
    const mine = all.filter((r) => r.settingKey.startsWith('g641.audit.'));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.settingKey).toBe('g641.audit.hai');
    expect(mine[0]!.newValue).toEqual(['a']);
    expect(mine[0]!.tenantId).toBe(tenantId);
    expect(mine[1]!.oldValue).toBeNull();

    const filtered = await siteConfigRepo.listAudit('g641.audit.mot');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.newValue).toEqual({ v: 1 });
    expect(filtered[0]!.changedBy).toBe('admin-g641');
  });
});

describe('T-7 mở rộng cho kho trung tâm — contract hai ORM trên các bảng đại diện của cụm', () => {
  it('T-7: dòng users ghi qua Drizzle đọc qua Kysely cho kiểu runtime khớp từng cột đại diện', async () => {
    const [drizzleRow] = await drizzleDb
      .insert(users)
      .values({
        username: 'g641_t7_user',
        email: 'g641_t7_user@example.test',
        passwordHash: 'hash-t7',
        firstName: 'T7',
        lastName: 'Hợp đồng',
        suspended: true,
        lastLogin: new Date('2026-02-02T03:04:05.000Z'),
      })
      .returning();
    const kyselyRow = await usersRepo.getById(drizzleRow!.id);
    expect(kyselyRow).toBeDefined();
    expect(typeof kyselyRow!.id).toBe('string');
    expect(kyselyRow!.id).toBe(drizzleRow!.id);
    expect(kyselyRow!.createdAt).toBeInstanceOf(Date);
    expect(drizzleRow!.createdAt).toBeInstanceOf(Date);
    expect(kyselyRow!.createdAt.toISOString()).toBe(drizzleRow!.createdAt.toISOString());
    expect(kyselyRow!.lastLogin?.toISOString()).toBe('2026-02-02T03:04:05.000Z');
    expect(typeof kyselyRow!.suspended).toBe('boolean');
    expect(kyselyRow!.suspended).toBe(true);
    expect(kyselyRow!.deleted).toBe(false);
    expect(kyselyRow!.image).toBeNull();
  });

  it('T-7: jsonb của tenant_config và config khớp hai chiều ghi Drizzle đọc Kysely và ghi Kysely đọc Drizzle', async () => {
    const [drizzleTenant] = await drizzleDb
      .insert(tenants)
      .values({ slug: 'g641-t7', name: 'T7 tenant', kind: 'center', status: 'active', plan: null })
      .returning();
    await drizzleDb.insert(tenantConfig).values({
      tenantId: drizzleTenant!.id,
      key: 't7.drizzle-write',
      value: { sau: [1, { hai: 'ba' }] },
    });
    const viaRepo = await tenantsRepo.getConfigValue(drizzleTenant!.id, 't7.drizzle-write');
    expect(viaRepo?.value).toEqual({ sau: [1, { hai: 'ba' }] });
    expect(viaRepo?.updatedAt).toBeInstanceOf(Date);

    await tenantsRepo.upsertConfigValue(drizzleTenant!.id, 't7.kysely-write', ['mảng', 7]);
    const [drizzleRead] = await drizzleDb
      .select()
      .from(tenantConfig)
      .where(eq(tenantConfig.key, 't7.kysely-write'));
    expect(drizzleRead!.value).toEqual(['mảng', 7]);

    await siteConfigRepo.storeValue('core', 't7.config-array', [{ a: 1 }]);
    const [drizzleConfig] = await drizzleDb.select().from(config).where(eq(config.key, 't7.config-array'));
    expect(drizzleConfig!.value).toEqual([{ a: 1 }]);
    expect(drizzleConfig!.updatedAt).toBeInstanceOf(Date);
  });

  it('T-7: mười bốn bảng của cụm không có cột bigint nào — luật int8 đọc là string không có bề mặt trong cụm', async () => {
    const result = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name IN ('users','user_preferences','refresh_token_family','login_attempts','user_oauth_links','user_totp','tenants','tenant_memberships','tenant_config','centre_identity','centre_invites','config','plugin_config','admin_setting_audit')
         AND data_type = 'bigint'`,
    );
    expect(result.rows[0]!.n).toBe(0);
  });
});
