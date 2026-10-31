import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSpaceProvision, manageCentreInvite } from '../../../src/modules/tenants/space-provision-runner';
import { buildCentreDatabaseUrl, deriveCentreRoleName } from '../../../src/modules/tenants/centre-provision';
import { FleetRegistryWriter } from '../../../src/modules/fleet/fleet-registry-writer';

/**
 * Ca tích hợp của PIPELINE CẤP PHÁT TRUNG TÂM (issue #583): chạy
 * đúng lệnh cấp phát trên cụm Postgres thật — sổ đăng ký control
 * plane riêng, database + role riêng cho trung tâm, baseline nghiệp
 * vụ hiện hành, gói chương trình, tenant + membership + quản trị
 * đầu tiên + lời mời — rồi chạy lại và cấp phát dở dang để khoá
 * tính chạy-lại-an-toàn, và khoá yêu cầu từ chối databaseName
 * trùng (ghi chú điều phối trên issue #583, điểm P1-2b của review
 * PR #594) ở cả tầng ứng dụng lẫn tầng database.
 *
 * Mọi tên đều mang hậu tố ngẫu nhiên theo lượt chạy: chạy lại spec
 * trên cùng cụm không va chạm, và không tái dùng tên database cũ
 * (tránh khoá cache siteadmins cũ trong Redis theo tên database).
 * Cụm test lấy từ `DATABASE_URL` đã được Vitest phân giải (biến
 * `LMS_TEST_DATABASE_URL` ghi đè khi chạy ngoài CI).
 */
const RUN_SUFFIX = Math.random().toString(36).slice(2, 8);
const CP_DATABASE = `lms_test_cp_583_${RUN_SUFFIX}`;
const SLUG = `trung-tam-583-${RUN_SUFFIX}`;
const ADMIN_EMAIL = `admin-583-${RUN_SUFFIX}@example.com`;
const ADMIN_USERNAME = `admin583${RUN_SUFFIX}`;
const DB_PASSWORD = 'Test583CentreDb!';
const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const CENTRE_NAME = 'Trung tâm kiểm chứng 583';

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database test. */
function clusterUrl(database: string, username?: string, secret?: string): string {
  const base = new URL(process.env.DATABASE_URL!);
  base.pathname = `/${database}`;
  if (username) base.username = username;
  if (secret) base.password = secret;
  return base.toString();
}

/** Bọc một định danh Postgres trong dấu nháy kép cho các câu lệnh quản trị của ca test. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function withClient<T>(connectionString: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Áp một file migration SQL (tách theo dấu phân đoạn của Drizzle) lên một database qua kết nối cho trước. */
async function applySqlFile(connectionString: string, filePath: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
    }
    const sqlText = readFileSync(filePath, 'utf8');
    for (const statement of sqlText.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính các file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    await applySqlFile(connectionString, join(outDir, folder, 'migration.sql'));
  }
}

/** Env chạy lệnh cấp phát: sổ control plane riêng + cụm test + mật khẩu role do ca test cấp. */
function provisionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CONTROL_PLANE_DATABASE_URL: clusterUrl(CP_DATABASE),
    DATABASE_URL: process.env.DATABASE_URL!,
    SPACE_PROVISION_DB_PASSWORD: DB_PASSWORD,
    ...extra,
  };
}

const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'drizzle');

describe('Cấp phát trung tâm mới (tích hợp)', () => {
  let writer: FleetRegistryWriter;
  let provisioned: Awaited<ReturnType<typeof runSpaceProvision>>;

  beforeAll(async () => {
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`CREATE DATABASE ${quoted(CP_DATABASE)}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE));
    writer = new FleetRegistryWriter(provisionEnv());
    provisioned = await runSpaceProvision({
      slug: SLUG,
      name: CENTRE_NAME,
      adminEmail: ADMIN_EMAIL,
      adminUsername: ADMIN_USERNAME,
      databasePassword: DB_PASSWORD,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    });
  }, 120000);

  afterAll(async () => {
    if (writer) await writer.close();
    await withClient(clusterUrl('postgres'), async (admin) => {
      if (provisioned) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(provisioned.databaseName)} WITH (FORCE)`);
        await admin.query(`DROP ROLE IF EXISTS ${quoted(provisioned.connectionRole)}`);
      }
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(CP_DATABASE)} WITH (FORCE)`);
    });
  });

  it('cấp phát trọn vẹn: sổ đăng ký + database riêng + role riêng + schema hiện hành + gói chương trình + quản trị đầu tiên + lời mời', async () => {
    expect(provisioned.status).toBe('active');
    expect(provisioned.slug).toBe(SLUG);
    expect(provisioned.tenantId).toBeTruthy();
    expect(provisioned.adminUserId).toBeTruthy();
    expect(provisioned.inviteToken).toBeTruthy();
    expect(provisioned.inviteExpiresAt).not.toBeNull();

    // Sổ đăng ký: dòng dedicated, trạng thái active, bí mật chỉ ghi tham chiếu.
    const space = await writer.findSpaceBySlug(SLUG);
    expect(space).toBeTruthy();
    expect(space!.storageMode).toBe('dedicated');
    expect(space!.status).toBe('active');
    expect(space!.databaseName).toBe(provisioned.databaseName);
    expect(space!.connectionRoleRef).toBe(provisioned.connectionRole);
    expect(space!.secretRef).toBe(`env:${provisioned.secretEnvVar}`);
    expect(space!.secretRef).not.toContain(DB_PASSWORD);

    // Database riêng thuộc role riêng, PUBLIC không còn quyền CONNECT.
    await withClient(clusterUrl('postgres'), async (admin) => {
      const owner = await admin.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [provisioned.databaseName],
      );
      expect(owner.rows[0]!.owner).toBe(provisioned.connectionRole);
      // PUBLIC không phải role nên không dùng được has_database_privilege
      // với nó — kiểm tra trực tiếp danh sách quyền của database: sau
      // REVOKE CONNECT FROM PUBLIC, không còn mục nào của PUBLIC (mục
      // bắt đầu bằng `=`) mang quyền CONNECT (ký tự `c`).
      const acl = await admin.query<{ datacl: string | null }>('SELECT datacl FROM pg_database WHERE datname = $1', [
        provisioned.databaseName,
      ]);
      // pg trả cột aclitem[] dạng chuỗi `{mục,mục}` (không parse thành
      // mảng): tách tay theo dấu phẩy — chuỗi quyền không chứa phẩy.
      const raw = acl.rows[0]!.datacl ?? '';
      const entries = raw.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
      expect(entries.some((entry) => /^=[^/]*c/.test(entry))).toBe(false);
    });

    // Kho trung tâm: 3 bảng mới của issue #583 + gói chương trình đã
    // cài + tenant/membership/quản trị/lời mời đúng hình.
    const centreUrl = clusterUrl(provisioned.databaseName, provisioned.connectionRole, DB_PASSWORD);
    await withClient(centreUrl, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('centre_identity', 'centre_invites', 'program_package_installs')`,
      );
      expect(tables.rows.map((r) => r.table_name).sort()).toEqual([
        'centre_identity',
        'centre_invites',
        'program_package_installs',
      ]);
      const subjects = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM subjects');
      expect(Number(subjects.rows[0]!.c)).toBeGreaterThan(0);
      const install = await client.query('SELECT version, checksum FROM program_package_installs');
      expect(install.rows.length).toBe(1);
      const tenant = await client.query('SELECT id, slug, kind, status FROM tenants WHERE slug = $1', [SLUG]);
      expect(tenant.rows[0]).toMatchObject({ slug: SLUG, kind: 'center', status: 'active' });
      expect(tenant.rows[0]!.id).toBe(provisioned.tenantId);
      const membership = await client.query('SELECT status FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2', [
        provisioned.tenantId,
        provisioned.adminUserId,
      ]);
      expect(membership.rows[0]?.status).toBe('active');
      const admin = await client.query('SELECT username, email, password_hash FROM users WHERE id = $1', [provisioned.adminUserId]);
      expect(admin.rows[0]).toMatchObject({ username: ADMIN_USERNAME, email: ADMIN_EMAIL, password_hash: null });
      const siteadmins = await client.query<{ value: unknown }>(`SELECT value FROM config WHERE key = 'siteadmins'`);
      expect(siteadmins.rows[0]!.value).toContain(provisioned.adminUserId);
      const identity = await client.query('SELECT display_name FROM centre_identity WHERE tenant_id = $1', [provisioned.tenantId]);
      expect(identity.rows[0]?.display_name).toBe(CENTRE_NAME);
      const invite = await client.query('SELECT token_hash, used_at, revoked_at FROM centre_invites WHERE user_id = $1', [
        provisioned.adminUserId,
      ]);
      expect(invite.rows.length).toBe(1);
      expect(invite.rows[0]!.token_hash).toBe(createHash('sha256').update(provisioned.inviteToken!).digest('hex'));
      expect(invite.rows[0]!.used_at).toBeNull();
      expect(invite.rows[0]!.revoked_at).toBeNull();
    });
  });

  it('chạy lại trên trung tâm đã active thì không đổi gì và không tạo trùng', async () => {
    const again = await runSpaceProvision({
      slug: SLUG,
      name: CENTRE_NAME,
      adminEmail: ADMIN_EMAIL,
      adminUsername: ADMIN_USERNAME,
      databasePassword: DB_PASSWORD,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    });
    expect(again.status).toBe('already-active');
    expect(again.tenantId).toBeNull();
    expect(again.adminUserId).toBeNull();
    expect(again.inviteToken).toBeNull();
    const centreUrl = clusterUrl(provisioned.databaseName, provisioned.connectionRole, DB_PASSWORD);
    await withClient(centreUrl, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const users = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM users');
      expect(Number(users.rows[0]!.c)).toBe(1);
      const invites = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM centre_invites');
      expect(Number(invites.rows[0]!.c)).toBe(1);
      const installs = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM program_package_installs');
      expect(Number(installs.rows[0]!.c)).toBe(1);
    });
  });

  it('cấp phát lại khi đã có database + role nhưng chưa có sổ đăng ký thì hoàn tất mà không tạo trùng', async () => {
    // Giả lập cấp phát dở dang giữa bước 1 và bước 2: xoá dòng đăng
    // ký nhưng giữ nguyên database + role + dữ kiện trong kho.
    await withClient(clusterUrl(CP_DATABASE), async (client) => {
      // Các bảng con tham chiếu sổ với onDelete restrict: phải dọn
      // chúng trước mới xoá được dòng đăng ký.
      await client.query('DELETE FROM space_schema_migration_runs');
      await client.query('DELETE FROM space_schema_registry');
      await client.query('DELETE FROM space_registry_history');
      await client.query('DELETE FROM space_registry WHERE slug = $1', [SLUG]);
    });
    const resumed = await runSpaceProvision({
      slug: SLUG,
      name: CENTRE_NAME,
      adminEmail: ADMIN_EMAIL,
      adminUsername: ADMIN_USERNAME,
      databasePassword: DB_PASSWORD,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    });
    expect(resumed.status).toBe('active');
    expect(resumed.databaseName).toBe(provisioned.databaseName);
    expect(resumed.connectionRole).toBe(provisioned.connectionRole);
    const centreUrl = clusterUrl(provisioned.databaseName, provisioned.connectionRole, DB_PASSWORD);
    await withClient(centreUrl, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const users = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM users');
      expect(Number(users.rows[0]!.c)).toBe(1);
      const invites = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM centre_invites');
      expect(Number(invites.rows[0]!.c)).toBe(1);
    });
  });

  it('từ chối databaseName trùng với trung tâm kho riêng khác (cả khi tên do vận hành ghi đè)', async () => {
    const otherSlug = `trung-tam-khac-${RUN_SUFFIX}`;
    await expect(
      runSpaceProvision({
        slug: otherSlug,
        name: 'Trung tâm khác',
        adminEmail: `khac-583-${RUN_SUFFIX}@example.com`,
        databaseName: provisioned.databaseName,
        databasePassword: DB_PASSWORD,
        actorId: ACTOR_ID,
        migrationsDir: MIGRATIONS_DIR,
        env: provisionEnv(),
        log: () => undefined,
      }),
    ).rejects.toThrow(`Database name ${provisioned.databaseName} is already used by space ${SLUG}`);
    expect(await writer.findSpaceBySlug(otherSlug)).toBeUndefined();
  });

  it('từ chối databaseName trùng với dòng kho chung trong sổ (chỉ mục từng phần không bắt được ca này)', async () => {
    // Dòng kho chung trỏ về database dùng chung — ghi trực tiếp vào
    // sổ (đường seedExistingSpaces tạo ra các dòng này trong thực
    // tế, không qua cấp phát).
    const sharedDb = `lms_shared_583_${RUN_SUFFIX}`;
    await withClient(clusterUrl(CP_DATABASE), async (client) => {
      await client.query(
        `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version, plan)
         VALUES ('trang-chung-583-${RUN_SUFFIX}', 'Trang chung', 'platform', 'active', $1, 'shared', 'shared_role', 'env:SHARED_URL', NULL, NULL)`,
        [sharedDb],
      );
    });
    const otherSlug = `trung-tam-shared-${RUN_SUFFIX}`;
    await expect(
      runSpaceProvision({
        slug: otherSlug,
        name: 'Trung tâm va kho chung',
        adminEmail: `shared-583-${RUN_SUFFIX}@example.com`,
        databaseName: sharedDb,
        databasePassword: DB_PASSWORD,
        actorId: ACTOR_ID,
        migrationsDir: MIGRATIONS_DIR,
        env: provisionEnv(),
        log: () => undefined,
      }),
    ).rejects.toThrow(`Database name ${sharedDb} is already used by space trang-chung-583-${RUN_SUFFIX}`);
    expect(await writer.findSpaceBySlug(otherSlug)).toBeUndefined();
  });

  it('chỉ mục unique từng phần ở tầng database: hai dòng dedicated trùng tên bị chặn, hai dòng shared trùng tên vẫn được', async () => {
    const dbName = `lms_dup_583_${RUN_SUFFIX}`;
    await withClient(clusterUrl(CP_DATABASE), async (client) => {
      await client.query(
        `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version, plan)
         VALUES ('ded-a-583-${RUN_SUFFIX}', 'A', 'center', 'active', $1, 'dedicated', 'role_a', 'env:A_URL', NULL, NULL)`,
        [dbName],
      );
      await expect(
        client.query(
          `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version, plan)
           VALUES ('ded-b-583-${RUN_SUFFIX}', 'B', 'center', 'active', $1, 'dedicated', 'role_b', 'env:B_URL', NULL, NULL)`,
          [dbName],
        ),
      ).rejects.toThrow(/space_registry_database_name_dedicated_unique/);
      await client.query(
        `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref, schema_version, plan)
         VALUES ('shared-a-583-${RUN_SUFFIX}', 'SA', 'platform', 'active', $1, 'shared', 'shared_role', 'env:SA_URL', NULL, NULL),
                ('shared-b-583-${RUN_SUFFIX}', 'SB', 'platform', 'active', $1, 'shared', 'shared_role', 'env:SB_URL', NULL, NULL)`,
        [dbName],
      );
      const rows = await client.query<{ c: string }>('SELECT COUNT(*) AS c FROM space_registry WHERE database_name = $1', [dbName]);
      expect(Number(rows.rows[0]!.c)).toBe(3);
    });
  });

  it('lệnh lời mời: phát hành lại huỷ lời mời cũ đang chờ và cấp token mới', async () => {
    const centreUrl = clusterUrl(provisioned.databaseName, provisioned.connectionRole, DB_PASSWORD);
    const env = provisionEnv({ [provisioned.secretEnvVar]: centreUrl });
    const result = await manageCentreInvite({ slug: SLUG, email: ADMIN_EMAIL, env, log: () => undefined });
    expect(result.revokedCount).toBe(1);
    expect(result.inviteToken).toBeTruthy();
    expect(result.inviteToken).not.toBe(provisioned.inviteToken);
    await withClient(centreUrl, async (client) => {
      await client.query(`SELECT set_config('app.platform', 'on', false)`);
      const oldInvite = await client.query('SELECT revoked_at FROM centre_invites WHERE token_hash = $1', [
        createHash('sha256').update(provisioned.inviteToken!).digest('hex'),
      ]);
      expect(oldInvite.rows[0]!.revoked_at).not.toBeNull();
      const newInvite = await client.query('SELECT used_at, revoked_at FROM centre_invites WHERE token_hash = $1', [
        createHash('sha256').update(result.inviteToken!).digest('hex'),
      ]);
      expect(newInvite.rows[0]).toMatchObject({ used_at: null, revoked_at: null });
    });
    const revoked = await manageCentreInvite({ slug: SLUG, email: ADMIN_EMAIL, revokeOnly: true, env, log: () => undefined });
    expect(revoked.revokedCount).toBe(1);
    expect(revoked.inviteToken).toBeNull();
  });

  it('role đã tồn tại mang quyền đặc quyền thì bị từ chối nhận nuôi, cả thuộc tính lẫn tư cách thành viên', async () => {
    // Mỗi lượt cấp phát vấp ở bước 2 đều để lại một dòng đăng ký
    // ở trạng thái provisioning trong database control plane riêng
    // của lượt chạy này (database đó bị dọn ở afterAll) nên không
    // ảnh hưởng các ca khác; chỉ role tạo sẵn mới cần dọn tay.
    const adminConn = clusterUrl('postgres');
    const superSlug = `trung-tam-sieu-${RUN_SUFFIX}`;
    const superRole = deriveCentreRoleName(superSlug);
    await withClient(adminConn, async (admin) => {
      await admin.query(`CREATE ROLE ${quoted(superRole)} LOGIN SUPERUSER PASSWORD 'tam-611-super'`);
    });
    try {
      await expect(
        runSpaceProvision({
          slug: superSlug,
          name: 'Trung tâm siêu quyền',
          adminEmail: `sieu-611-${RUN_SUFFIX}@example.com`,
          databasePassword: DB_PASSWORD,
          actorId: ACTOR_ID,
          migrationsDir: MIGRATIONS_DIR,
          env: provisionEnv(),
          log: () => undefined,
        }),
      ).rejects.toThrow(/privileged/);
      // Từ chối trước mọi ALTER nên role đặc quyền còn nguyên vẹn,
      // không bị chuẩn hoá lén thành role thường.
      await withClient(adminConn, async (admin) => {
        const kept = await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname = $1', [superRole]);
        expect(kept.rows[0]?.rolsuper).toBe(true);
      });
    } finally {
      await withClient(adminConn, async (admin) => {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(superRole)}`);
      });
    }
    // Tư cách thành viên: role trung tâm tự nó sạch nhưng là thành
    // viên của một role đặc quyền thì vẫn bị từ chối.
    const memberSlug = `trung-tam-thanh-vien-${RUN_SUFFIX}`;
    const memberRole = deriveCentreRoleName(memberSlug);
    const privilegedRole = `lms_quyen_611_${RUN_SUFFIX}`;
    await withClient(adminConn, async (admin) => {
      await admin.query(`CREATE ROLE ${quoted(privilegedRole)} LOGIN SUPERUSER PASSWORD 'tam-611-quyen'`);
      await admin.query(`CREATE ROLE ${quoted(memberRole)} LOGIN PASSWORD 'tam-611-thanh-vien'`);
      await admin.query(`GRANT ${quoted(privilegedRole)} TO ${quoted(memberRole)}`);
    });
    try {
      await expect(
        runSpaceProvision({
          slug: memberSlug,
          name: 'Trung tâm thành viên đặc quyền',
          adminEmail: `thanh-vien-611-${RUN_SUFFIX}@example.com`,
          databasePassword: DB_PASSWORD,
          actorId: ACTOR_ID,
          migrationsDir: MIGRATIONS_DIR,
          env: provisionEnv(),
          log: () => undefined,
        }),
      ).rejects.toThrow(/privileged/);
    } finally {
      await withClient(adminConn, async (admin) => {
        await admin.query(`DROP ROLE IF EXISTS ${quoted(memberRole)}`);
        await admin.query(`DROP ROLE IF EXISTS ${quoted(privilegedRole)}`);
      });
    }
  });

  it('chạy lại cấp phát trên trung tâm đã đình chỉ hoặc đã đóng thì bị từ chối, không tự mở lại', async () => {
    const slug = `trung-tam-dinh-chi-${RUN_SUFFIX}`;
    const lifecycleArgs = {
      slug,
      name: 'Trung tâm đình chỉ',
      adminEmail: `dinh-chi-611-${RUN_SUFFIX}@example.com`,
      databasePassword: DB_PASSWORD,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    };
    const created = await runSpaceProvision(lifecycleArgs);
    expect(created.status).toBe('active');
    const space = await writer.findSpaceBySlug(slug);
    expect(space).toBeTruthy();
    await writer.changeSpaceStatus(space!.id, 'suspended', ACTOR_ID);
    await expect(runSpaceProvision(lifecycleArgs)).rejects.toThrow(/suspended/);
    await writer.changeSpaceStatus(space!.id, 'closed', ACTOR_ID);
    await expect(runSpaceProvision(lifecycleArgs)).rejects.toThrow(/closed/);
    // Mở lại chỉ được qua thao tác vòng đời tường minh: đổi lại
    // active bằng writer rồi chạy lại thì vẫn về already-active.
    await writer.changeSpaceStatus(space!.id, 'active', ACTOR_ID);
    const again = await runSpaceProvision(lifecycleArgs);
    expect(again.status).toBe('already-active');
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(created.databaseName)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${quoted(created.connectionRole)}`);
    });
  }, 120000);

  it('cấp phát với mật khẩu chứa ký tự phần trăm thì thành công và kết nối được bằng đúng mật khẩu đó', async () => {
    // Mật khẩu thô mang %40 (vốn sẽ thành @ nếu giải mã hai lần)
    // và %25 cùng một ký tự % trần (vốn sẽ vấp URIError nếu giải
    // mã hai lần): toàn bộ pipeline bước 3–6 đều kết nối bằng URL
    // dựng từ mật khẩu này nên cấp phát thành công đã chứng minh
    // mật khẩu không bị biến dạng.
    const percentPassword = 'p%40ss%25%word';
    const slug = `trung-tam-phan-tram-${RUN_SUFFIX}`;
    const created = await runSpaceProvision({
      slug,
      name: 'Trung tâm phần trăm',
      adminEmail: `phan-tram-611-${RUN_SUFFIX}@example.com`,
      databasePassword: percentPassword,
      actorId: ACTOR_ID,
      migrationsDir: MIGRATIONS_DIR,
      env: provisionEnv(),
      log: () => undefined,
    });
    expect(created.status).toBe('active');
    // Kết nối kiểm chứng phải đi qua đúng hàm dựng URL của
    // production: helper clusterUrl dùng bộ gán password của WHATWG
    // URL, vốn giữ nguyên các dãy %XX có sẵn nên pg giải mã một lần
    // thành mật khẩu khác ('p@ss%%word') và vấp lỗi xác thực — đó
    // là lỗi của helper test, không phải của pipeline (pipeline
    // dùng buildCentreDatabaseUrl và đã cấp phát thành công trước
    // khi tới bước kiểm chứng này, như lần tái hiện lỗi đã chứng
    // minh: cấp phát chạy đủ ~26s rồi mới rớt ở kết nối kiểm chứng).
    const baseUrl = new URL(process.env.DATABASE_URL!);
    const centreUrl = buildCentreDatabaseUrl({
      host: baseUrl.hostname,
      port: Number(baseUrl.port),
      role: created.connectionRole,
      password: percentPassword,
      databaseName: created.databaseName,
    });
    await withClient(centreUrl, async (client) => {
      await client.query('SELECT 1');
    });
    await withClient(clusterUrl('postgres'), async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${quoted(created.databaseName)} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${quoted(created.connectionRole)}`);
    });
  }, 120000);
});
