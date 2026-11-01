import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFleetBackups, runFleetBackup } from '../../../src/modules/fleet/fleet-backup';
import { backupFileName, dumpDatabaseToFile, readDatabaseSchemaVersion } from '../../../src/modules/fleet/fleet-common';
import { runFleetMigration } from '../../../src/modules/fleet/fleet-migration-runner';
import { runFleetRestoreTest } from '../../../src/modules/fleet/fleet-restore-test';
import { runRuntimeRolesSetup } from '../../../src/modules/fleet/runtime-roles-setup';

/**
 * Ca tích hợp của CÔNG CỤ VẬN HÀNH ĐỘI KHO (issue #586): tách role
 * runtime/migration, runner migration theo đợt, sao lưu định kỳ,
 * kiểm thử khôi phục và ngân sách kết nối — kiểm chứng đầu cuối
 * trên một cụm test thật với các database và role TÊN MỚI của
 * riêng ca này.
 *
 * Bố cục: một database control plane riêng (`lms_test_cp_586`, áp
 * bộ migration của control plane từ rỗng như ca của issue #580),
 * một kho nghiệp vụ trầy (`lms_test_biz_586`) cho phần tách role,
 * và BỐN kho đã đăng ký trong sổ — kho nền tảng `trang-chinh-586`,
 * trung tâm canary `tt-a-canary-586`, trung tâm `tt-b-loi-586` bị
 * phá hoại có chủ đích ở lượt migration đầu (một bảng trùng tên với
 * bảng của baseline được tạo trước để bước áp migration của riêng
 * kho đó phải hỏng và dừng ở trạng thái có ghi nhận, trong khi các
 * kho cùng đợt vẫn hoàn tất), và trung tâm `tt-c-586` cùng đợt với
 * kho bị phá. Các kho được đăng ký với `secretRef` trỏ tới URL của
 * role RUNTIME: runner chỉ áp được migration khi nó thay thông tin
 * đăng nhập bằng của role migration theo đúng luật suy ra URL vận
 * hành — role runtime tự nó không có quyền tạo bảng trong các kho.
 *
 * Cô lập hai chiều được kiểm ở ĐÚNG bước mở kết nối bằng đúng các
 * role thật của mô hình mới: role runtime không mở được kết nối
 * vào database control plane, role của control plane không mở
 * được kết nối vào kho nghiệp vụ — sau khi role runtime đã bị hạ
 * khỏi superuser bởi chính script cấp phát của issue này.
 *
 * Shim `uuidv7()` chỉ áp khi server PostgreSQL dưới 18 (môi trường
 * chạy local bằng PG16): PG18 — bản ở CI và production — có sẵn
 * hàm này, shim sẽ che mất hàm gốc nên tuyệt đối không áp ở đó.
 * Tệp sao lưu của ca ghi vào thư mục riêng trong cây làm việc và
 * được dọn ở afterAll, cùng toàn bộ database/role trầy của ca.
 */
const CP_DATABASE = 'lms_test_cp_586';
const CP_ROLE = 'lms_cp_test_586';
const CP_PASSWORD = 'cp-test-586';
const BIZ_DATABASE = 'lms_test_biz_586';
const RUNTIME_ROLE = 'lms_runtime_test_586';
const RUNTIME_PASSWORD = 'runtime-test-586';
const MIGRATOR_ROLE = 'lms_migrator_test_586';
const MIGRATOR_PASSWORD = 'migrator-test-586';
const BASELINE_VERSION = '20261025163710_baseline';
const BACKUP_DIR = join(__dirname, 'fleet-586-artifacts');

const SPACES = [
  { slug: 'trang-chinh-586', kind: 'platform', database: 'lms_test_space_platform_586' },
  { slug: 'tt-a-canary-586', kind: 'center', database: 'lms_test_space_canary_586' },
  { slug: 'tt-b-loi-586', kind: 'center', database: 'lms_test_space_loi_586' },
  { slug: 'tt-c-586', kind: 'center', database: 'lms_test_space_c_586' },
] as const;

const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Dựng URL kết nối tới một database trên cùng cụm với database nghiệp vụ test. */
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

/** Áp shim uuidv7 khi server dưới PostgreSQL 18 (xem ghi chú đầu file). */
async function applyUuidV7ShimIfNeeded(connectionString: string): Promise<void> {
  await withClient(connectionString, async (client) => {
    const version = await client.query<{ server_version_num: string }>('SHOW server_version_num');
    if (Number(version.rows[0]!.server_version_num) < 180000) {
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(UUIDV7_SHIM);
    }
  });
}

/** Áp bộ migration riêng của control plane từ rỗng (đọc chính file SQL đã sinh trong repo). */
async function applyControlPlaneMigrations(connectionString: string): Promise<void> {
  const outDir = join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'control-plane');
  const folders = readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  await applyUuidV7ShimIfNeeded(connectionString);
  await withClient(connectionString, async (client) => {
    for (const folder of folders) {
      const sql = readFileSync(join(outDir, folder, 'migration.sql'), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        const trimmed = statement.trim();
        if (trimmed) await client.query(trimmed);
      }
    }
  });
}

/** Đọc một trường của registry phiên bản schema của một kho theo slug, qua kết nối của role control plane. */
async function registryState(slug: string): Promise<{
  currentVersion: string | null;
  lastBackupStatus: string | null;
  lastBackupAt: Date | null;
  lastRestoreStatus: string | null;
}> {
  return withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
    const result = await client.query<{
      current_version: string | null;
      last_backup_status: string | null;
      last_backup_at: Date | null;
      last_restore_status: string | null;
    }>(
      `SELECT r.current_version, r.last_backup_status, r.last_backup_at, r.last_restore_status
         FROM space_schema_registry r JOIN space_registry s ON s.id = r.space_id
        WHERE s.slug = $1`,
      [slug],
    );
    const row = result.rows[0]!;
    return {
      currentVersion: row.current_version,
      lastBackupStatus: row.last_backup_status,
      lastBackupAt: row.last_backup_at,
      lastRestoreStatus: row.last_restore_status,
    };
  });
}

/** Các lượt chạy migration đã ghi vào nhật ký cho một kho, theo thứ tự thời gian. */
async function migrationRuns(slug: string): Promise<{ status: string; steps: { name: string; status: string }[] }[]> {
  return withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
    const result = await client.query<{ status: string; steps: { name: string; status: string }[] }>(
      `SELECT m.status, m.steps FROM space_schema_migration_runs m
         JOIN space_registry s ON s.id = m.space_id
        WHERE s.slug = $1 ORDER BY m.started_at, m.id`,
      [slug],
    );
    return result.rows;
  });
}

describe('Đội kho: tách role, migration theo đợt, sao lưu, khôi phục và ngân sách kết nối (integration)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'CONTROL_PLANE_DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'DATABASE_ADMIN_URL',
    'FLEET_BACKUP_DIR',
    'FLEET_TEST_SPACE_URL',
    'FLEET_BACKUP_ENCRYPTION_KEY',
  ];

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.CONTROL_PLANE_DATABASE_URL = clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD);
    process.env.MIGRATION_DATABASE_URL = clusterUrl('postgres', MIGRATOR_ROLE, MIGRATOR_PASSWORD);
    process.env.DATABASE_ADMIN_URL = clusterUrl('postgres');
    process.env.FLEET_BACKUP_DIR = BACKUP_DIR;
    process.env.FLEET_TEST_SPACE_URL = clusterUrl('postgres', RUNTIME_ROLE, RUNTIME_PASSWORD);
    // Mã hoá sao lưu là bắt buộc (fail-closed): mọi đường chụp
    // trong ca này phải có khoá, và tệp lưu trên đĩa là `.dump.enc`.
    process.env.FLEET_BACKUP_ENCRYPTION_KEY = 'fleet-test-586-passphrase';
    mkdirSync(BACKUP_DIR, { recursive: true });

    const adminUrl = clusterUrl('postgres');
    await withClient(adminUrl, async (admin) => {
      // Dọn tàn dư của một lượt chạy dở trước đó để ca tự cấp phát
      // lại từ sạch trên cùng tên (tên là của riêng ca này).
      for (const database of [CP_DATABASE, BIZ_DATABASE, ...SPACES.map((space) => space.database)]) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)}`);
      }
      for (const role of [CP_ROLE, RUNTIME_ROLE, MIGRATOR_ROLE]) {
        await admin.query(`DROP OWNED BY ${quoted(role)} CASCADE`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
      await admin.query(`CREATE ROLE ${quoted(CP_ROLE)} LOGIN PASSWORD '${CP_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${quoted(RUNTIME_ROLE)} LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
      await admin.query(`CREATE ROLE ${quoted(MIGRATOR_ROLE)} LOGIN PASSWORD '${MIGRATOR_PASSWORD}'`);
      await admin.query(`CREATE DATABASE ${quoted(CP_DATABASE)} OWNER ${quoted(CP_ROLE)}`);
      await admin.query(`CREATE DATABASE ${quoted(BIZ_DATABASE)}`);
      for (const space of SPACES) {
        await admin.query(`CREATE DATABASE ${quoted(space.database)} OWNER ${quoted(MIGRATOR_ROLE)}`);
      }
    });

    // Database control plane: chỉ role của nó mở được kết nối.
    await withClient(adminUrl, async (admin) => {
      await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(CP_DATABASE)} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE ${quoted(CP_DATABASE)} TO ${quoted(CP_ROLE)}`);
    });
    await applyControlPlaneMigrations(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD));

    // Các kho của đội kho: chủ là role migration; kết nối chỉ cấp
    // tường minh cho role migration và role runtime.
    for (const space of SPACES) {
      await withClient(adminUrl, async (admin) => {
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(space.database)} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(space.database)} TO ${quoted(MIGRATOR_ROLE)}`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(space.database)} TO ${quoted(RUNTIME_ROLE)}`);
      });
      await applyUuidV7ShimIfNeeded(clusterUrl(space.database, MIGRATOR_ROLE, MIGRATOR_PASSWORD));
    }

    // Kho nghiệp vụ trầy ở trạng thái TRƯỚC mô hình role mới: một
    // bảng do chính role quản trị của cụm sở hữu (di sản của thời
    // migration chạy bằng role quản trị).
    await withClient(clusterUrl(BIZ_DATABASE), async (admin) => {
      await admin.query('CREATE TABLE legacy_probe (id integer PRIMARY KEY, note text NOT NULL)');
      await admin.query(`INSERT INTO legacy_probe (id, note) VALUES (1, 'di san truoc tach role')`);
    });

    // Ghi sổ đăng ký cho bốn kho + dòng registry trống cho từng kho.
    await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
      for (const space of SPACES) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref)
           VALUES ($1, $2, $3, 'active', $4, 'dedicated', $5, 'env:FLEET_TEST_SPACE_URL') RETURNING id`,
          [space.slug, `Kho kiem chung ${space.slug}`, space.kind, space.database, MIGRATOR_ROLE],
        );
        await client.query('INSERT INTO space_schema_registry (space_id) VALUES ($1)', [inserted.rows[0]!.id]);
      }
    });
  }, 180_000);

  afterAll(async () => {
    const adminUrl = clusterUrl('postgres');
    await withClient(adminUrl, async (admin) => {
      for (const database of [CP_DATABASE, BIZ_DATABASE, ...SPACES.map((space) => space.database)]) {
        await admin.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [database],
        );
        await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)}`);
      }
      for (const role of [CP_ROLE, RUNTIME_ROLE, MIGRATOR_ROLE]) {
        await admin.query(`DROP OWNED BY ${quoted(role)} CASCADE`).catch(() => undefined);
        await admin.query(`DROP ROLE IF EXISTS ${quoted(role)}`);
      }
    }).catch(() => undefined);
    rmSync(BACKUP_DIR, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }, 120_000);

  describe('tách role runtime và role migration', () => {
    const setupEnv = () => ({
      ...process.env,
      DATABASE_ADMIN_URL: clusterUrl('postgres'),
      MIGRATION_DATABASE_URL: clusterUrl(BIZ_DATABASE, MIGRATOR_ROLE, MIGRATOR_PASSWORD),
      RUNTIME_DATABASE_URL: clusterUrl(BIZ_DATABASE, RUNTIME_ROLE, RUNTIME_PASSWORD),
    });

    it('script cấp phát hạ cả hai role khỏi superuser, chuyển sở hữu kho và đối tượng di sản về role migration', async () => {
      const result = await runRuntimeRolesSetup(setupEnv());
      expect(result.skipped).toBe(false);

      await withClient(clusterUrl('postgres'), async (admin) => {
        const roles = await admin.query<{ rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
          'SELECT rolname, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = ANY($1)',
          [[RUNTIME_ROLE, MIGRATOR_ROLE]],
        );
        expect(roles.rows).toHaveLength(2);
        for (const role of roles.rows) {
          expect(role.rolsuper).toBe(false);
          expect(role.rolcreatedb).toBe(false);
          expect(role.rolcreaterole).toBe(false);
        }
        const owner = await admin.query<{ owner: string }>(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
          [BIZ_DATABASE],
        );
        expect(owner.rows[0]!.owner).toBe(MIGRATOR_ROLE);
      });
      // Chủ sở hữu của bảng di sản phải đọc trong chính kho nghiệp
      // vụ (pg_tables là danh mục theo từng database).
      await withClient(clusterUrl(BIZ_DATABASE), async (admin) => {
        const tableOwner = await admin.query<{ tableowner: string }>(
          `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'legacy_probe'`,
        );
        expect(tableOwner.rows[0]!.tableowner).toBe(MIGRATOR_ROLE);
      });
    }, 60_000);

    it('role runtime đọc ghi được dữ kiện nhưng không tạo được đối tượng và không sở hữu đối tượng nào', async () => {
      await withClient(clusterUrl(BIZ_DATABASE, RUNTIME_ROLE, RUNTIME_PASSWORD), async (runtime) => {
        const read = await runtime.query<{ note: string }>('SELECT note FROM legacy_probe WHERE id = 1');
        expect(read.rows[0]!.note).toBe('di san truoc tach role');
        await runtime.query(`INSERT INTO legacy_probe (id, note) VALUES (2, 'runtime ghi duoc')`);
        await runtime.query(`UPDATE legacy_probe SET note = 'runtime sua duoc' WHERE id = 2`);
        await runtime.query('DELETE FROM legacy_probe WHERE id = 2');
        await expect(runtime.query('CREATE TABLE runtime_khong_duoc_tao (id integer)')).rejects.toThrow(
          /permission denied/,
        );
        const owned = await runtime.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
          [RUNTIME_ROLE],
        );
        expect(owned.rows[0]!.n).toBe(0);
      });
    }, 60_000);

    it('bảng do role migration tạo sau khi cấp phát tự mang quyền dữ liệu cho role runtime qua quyền mặc định', async () => {
      await withClient(clusterUrl(BIZ_DATABASE, MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (migrator) => {
        await migrator.query('CREATE TABLE post_setup_probe (id integer PRIMARY KEY)');
        await migrator.query('INSERT INTO post_setup_probe (id) VALUES (7)');
      });
      await withClient(clusterUrl(BIZ_DATABASE, RUNTIME_ROLE, RUNTIME_PASSWORD), async (runtime) => {
        const read = await runtime.query<{ id: number }>('SELECT id FROM post_setup_probe');
        expect(read.rows.map((row) => row.id)).toEqual([7]);
      });
    }, 60_000);

    it('cô lập ở bước mở kết nối bằng role thật: runtime không vào được control plane, role control plane không vào được kho nghiệp vụ', async () => {
      const runtimeIntoControlPlane = new Client({
        connectionString: clusterUrl(CP_DATABASE, RUNTIME_ROLE, RUNTIME_PASSWORD),
      });
      await expect(runtimeIntoControlPlane.connect()).rejects.toThrow(/permission denied for database/);
      await runtimeIntoControlPlane.end().catch(() => undefined);

      const controlPlaneIntoBusiness = new Client({
        connectionString: clusterUrl(BIZ_DATABASE, CP_ROLE, CP_PASSWORD),
      });
      await expect(controlPlaneIntoBusiness.connect()).rejects.toThrow(/permission denied for database/);
      await controlPlaneIntoBusiness.end().catch(() => undefined);
    }, 60_000);

    it('chạy lại script cấp phát không đổi trạng thái cuối (idempotent)', async () => {
      const result = await runRuntimeRolesSetup(setupEnv());
      expect(result.skipped).toBe(false);
      await withClient(clusterUrl('postgres'), async (admin) => {
        const owner = await admin.query<{ owner: string }>(
          'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
          [BIZ_DATABASE],
        );
        expect(owner.rows[0]!.owner).toBe(MIGRATOR_ROLE);
      });
    }, 60_000);
  });

  describe('runner migration theo đợt', () => {
    const runnerOptions = () => ({
      env: process.env,
      migrationsDir: join(__dirname, '..', '..', '..', '..', '..', 'packages', 'db', 'migrations', 'centre'),
      backupDir: BACKUP_DIR,
      waveSize: 2,
      log: () => undefined,
    });

    it('lượt đầu: kho bị phá hoại dừng ở trạng thái hỏng có ghi nhận, các kho còn lại hoàn tất và sổ khớp sự thật trong từng kho', async () => {
      // Phá hoại có chủ đích: tạo trước một bảng trùng tên với bảng
      // users của baseline trong kho tt-b — bước áp migration của
      // riêng kho đó phải hỏng và cuốn toàn bộ giao dịch của nó về
      // trạng thái chưa có phiên bản.
      await withClient(clusterUrl('lms_test_space_loi_586', MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (client) => {
        await client.query('CREATE TABLE users (id integer)');
      });

      const summary = await runFleetMigration(runnerOptions());
      const bySlug = new Map(summary.outcomes.map((outcome) => [outcome.slug, outcome.outcome]));
      expect(summary.targetVersion).toBe(BASELINE_VERSION);
      expect(bySlug.get('trang-chinh-586')).toBe('migrated');
      expect(bySlug.get('tt-a-canary-586')).toBe('migrated');
      expect(bySlug.get('tt-b-loi-586')).toBe('failed');
      expect(bySlug.get('tt-c-586')).toBe('migrated');
      expect(summary.failedCount).toBe(1);

      // Sổ khớp sự thật trong từng kho sau lượt chạy.
      for (const slug of ['trang-chinh-586', 'tt-a-canary-586', 'tt-c-586']) {
        expect((await registryState(slug)).currentVersion).toBe(BASELINE_VERSION);
      }
      expect((await registryState('tt-b-loi-586')).currentVersion).toBeNull();
      const brokenDbVersion = await withClient(
        clusterUrl('lms_test_space_loi_586', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
        (client) => readDatabaseSchemaVersion(client),
      );
      expect(brokenDbVersion).toBeNull();
      const platformDbVersion = await withClient(
        clusterUrl('lms_test_space_platform_586', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
        (client) => readDatabaseSchemaVersion(client),
      );
      expect(platformDbVersion).toBe(BASELINE_VERSION);

      // Nhật ký: mỗi kho đúng một lượt; lượt của kho hỏng ghi bước
      // áp migration thất bại, bản chốt trước migration của nó vẫn
      // được chụp (điểm khôi phục tồn tại kể cả khi migration hỏng).
      const brokenRuns = await migrationRuns('tt-b-loi-586');
      expect(brokenRuns).toHaveLength(1);
      expect(brokenRuns[0]!.status).toBe('failed');
      expect(brokenRuns[0]!.steps.find((step) => step.name === 'apply-migrations')!.status).toBe('failed');
      expect(brokenRuns[0]!.steps.find((step) => step.name === 'pre-migration-backup')!.status).toBe('success');
      for (const slug of ['trang-chinh-586', 'tt-a-canary-586', 'tt-c-586']) {
        const runs = await migrationRuns(slug);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.status).toBe('success');
      }
      const brokenBackups = readdirSync(join(BACKUP_DIR, 'tt-b-loi-586'));
      expect(brokenBackups.some((name) => name.startsWith('pre-migration-') && name.endsWith('.dump.enc'))).toBe(true);
    }, 300_000);

    it('chạy lại sau khi gỡ phá hoại chỉ xử lý kho chưa đạt đích, và sổ lệch sự thật được đồng bộ lại không bịa lượt chạy', async () => {
      await withClient(clusterUrl('lms_test_space_loi_586', MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (client) => {
        await client.query('DROP TABLE users');
      });
      // Gây lệch sổ có chủ đích cho canary: registry ghi một phiên
      // bản không có thật trong khi database của kho đã ở đích.
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query(
          `UPDATE space_schema_registry SET current_version = 'phien-ban-lech'
            WHERE space_id = (SELECT id FROM space_registry WHERE slug = 'tt-a-canary-586')`,
        );
      });

      const summary = await runFleetMigration(runnerOptions());
      const bySlug = new Map(summary.outcomes.map((outcome) => [outcome.slug, outcome.outcome]));
      expect(bySlug.get('trang-chinh-586')).toBe('skipped');
      expect(bySlug.get('tt-a-canary-586')).toBe('reconciled');
      expect(bySlug.get('tt-b-loi-586')).toBe('migrated');
      expect(bySlug.get('tt-c-586')).toBe('skipped');
      expect(summary.failedCount).toBe(0);

      expect((await registryState('tt-a-canary-586')).currentVersion).toBe(BASELINE_VERSION);
      expect((await registryState('tt-b-loi-586')).currentVersion).toBe(BASELINE_VERSION);
      // Chỉ kho tt-b có thêm lượt chạy thứ hai; các kho khác giữ
      // nguyên một lượt — đồng bộ sổ không bịa lượt chạy.
      expect(await migrationRuns('tt-b-loi-586')).toHaveLength(2);
      expect(await migrationRuns('tt-a-canary-586')).toHaveLength(1);
      expect(await migrationRuns('trang-chinh-586')).toHaveLength(1);
      expect(await migrationRuns('tt-c-586')).toHaveLength(1);
    }, 300_000);
  });

  describe('sao lưu định kỳ và kiểm thử khôi phục', () => {
    it('sao lưu định kỳ chụp đủ mọi kho và control plane, ghi trạng thái vào registry, và chế độ kiểm bắt đúng kho quá hạn', async () => {
      // Gieo tài khoản quản trị vào từng kho trước khi chụp: kiểm
      // tra khói của kiểm thử khôi phục đối chiếu đúng tài khoản
      // gieo sẵn này trong bản khôi phục của mỗi kho.
      for (const space of SPACES) {
        await withClient(clusterUrl(space.database, MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (client) => {
          await client.query(`INSERT INTO users (username, email) VALUES ('admin', $1)`, [
            `admin-${space.slug}@localhost`,
          ]);
        });
      }

      const summary = await runFleetBackup({ env: process.env, backupDir: BACKUP_DIR, log: () => undefined });
      expect(summary.failedCount).toBe(0);
      expect(summary.results.map((result) => result.slug).sort()).toEqual(
        ['control-plane', 'trang-chinh-586', 'tt-a-canary-586', 'tt-b-loi-586', 'tt-c-586'].sort(),
      );
      for (const space of SPACES) {
        const state = await registryState(space.slug);
        expect(state.lastBackupStatus).toBe('success');
        expect(state.lastBackupAt).not.toBeNull();
        const files = readdirSync(join(BACKUP_DIR, space.slug));
        const dump = files.find((name) => name.startsWith('scheduled-') && name.endsWith('.dump.enc'));
        expect(dump).toBeDefined();
        expect(files).toContain(`${dump}.sha256`);
      }
      expect(readdirSync(join(BACKUP_DIR, 'control-plane')).some((name) => name.startsWith('scheduled-'))).toBe(true);

      const healthy = await checkFleetBackups({ env: process.env, backupDir: BACKUP_DIR });
      expect(healthy.overdue).toEqual([]);
      // Đẩy mốc sao lưu của tt-c về quá khứ: chế độ kiểm phải bắt
      // đúng kho đó là quá hạn (đây là điểm móc cảnh báo vận hành).
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query(
          `UPDATE space_schema_registry SET last_backup_at = now() - interval '3 days'
            WHERE space_id = (SELECT id FROM space_registry WHERE slug = 'tt-c-586')`,
        );
      });
      const overdue = await checkFleetBackups({ env: process.env, backupDir: BACKUP_DIR });
      expect(overdue.overdue.map((item) => item.slug)).toEqual(['tt-c-586']);
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query(
          `UPDATE space_schema_registry SET last_backup_at = now()
            WHERE space_id = (SELECT id FROM space_registry WHERE slug = 'tt-c-586')`,
        );
      });
    }, 300_000);

    it('bản sao lưu bị sửa bị kiểm thử khôi phục phát hiện qua đối chiếu băm và ghi nhận thất bại', async () => {
      const files = readdirSync(join(BACKUP_DIR, 'trang-chinh-586'))
        .filter((name) => name.endsWith('.dump.enc'))
        .sort();
      const newest = files[files.length - 1]!;
      const path = join(BACKUP_DIR, 'trang-chinh-586', newest);
      writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('du lieu bi sua')]));

      const result = await runFleetRestoreTest({
        env: process.env,
        backupDir: BACKUP_DIR,
        spaceSlug: 'trang-chinh-586',
        log: () => undefined,
      });
      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/checksum/);
      expect((await registryState('trang-chinh-586')).lastRestoreStatus).toBe('failed');
    }, 120_000);

    it('kiểm thử khôi phục trên kho lành khôi phục đủ bảng, qua kiểm tra khói tài khoản quản trị gieo sẵn và dọn database tạm', async () => {
      const result = await runFleetRestoreTest({
        env: process.env,
        backupDir: BACKUP_DIR,
        spaceSlug: 'tt-a-canary-586',
        log: () => undefined,
      });
      expect(result.status).toBe('success');
      expect(result.tableCount).toBeGreaterThan(0);
      expect(result.tempDatabase).toBeDefined();
      const remaining = await withClient(clusterUrl('postgres'), async (admin) => {
        const counted = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [
          result.tempDatabase,
        ]);
        return counted.rows[0]!.n;
      });
      expect(remaining).toBe(0);
      expect((await registryState('tt-a-canary-586')).lastRestoreStatus).toBe('success');
    }, 300_000);

    it('vòng xoay kiểm thử khôi phục chọn kho có lượt kiểm cũ nhất (chưa từng kiểm đi trước, hoà theo slug)', async () => {
      await withClient(clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        await client.query(
          `UPDATE space_schema_registry SET last_restore_at = NULL
            WHERE space_id IN (SELECT id FROM space_registry WHERE slug IN ('tt-b-loi-586', 'tt-c-586'))`,
        );
      });
      const result = await runFleetRestoreTest({ env: process.env, backupDir: BACKUP_DIR, log: () => undefined });
      expect(result.slug).toBe('tt-b-loi-586');
      expect(result.status).toBe('success');
    }, 300_000);
  });

  describe('ngân sách kết nối', () => {
    it('tổng kết nối mở dưới tải đồng thời không vượt tổng trần của các pool, và kho nhàn rỗi không giữ kết nối nào', async () => {
      const idleTimeoutMillis = 150;
      const canaryPool = new Pool({
        connectionString: clusterUrl('lms_test_space_canary_586', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
        max: 3,
        idleTimeoutMillis,
      });
      const cPool = new Pool({
        connectionString: clusterUrl('lms_test_space_c_586', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
        max: 3,
        idleTimeoutMillis,
      });
      const cpPool = new Pool({
        connectionString: clusterUrl(CP_DATABASE, CP_ROLE, CP_PASSWORD),
        max: 2,
        idleTimeoutMillis,
      });
      const countConnections = async (database: string): Promise<number> =>
        withClient(clusterUrl('postgres'), async (admin) => {
          // Chỉ đếm backend của client: các tiến trình nền của
          // chính server (autovacuum, phân tích) cũng mang tên
          // database trong pg_stat_activity nhưng không thuộc ngân
          // sách kết nối của ứng dụng.
          const counted = await admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid() AND backend_type = 'client backend'`,
            [database],
          );
          return counted.rows[0]!.n;
        });
      try {
        // Bắn đồng thời nhiều truy vấn giữ kết nối hơn trần của
        // từng pool: số kết nối thật mở tới mỗi kho không bao giờ
        // vượt trần của pool đó, và tổng không vượt tổng ngân sách
        // 3 + 3 + 2 đã cấu hình.
        const loads = [
          ...Array.from({ length: 6 }, () => canaryPool.query('SELECT pg_sleep(0.6)')),
          ...Array.from({ length: 6 }, () => cPool.query('SELECT pg_sleep(0.6)')),
          ...Array.from({ length: 5 }, () => cpPool.query('SELECT pg_sleep(0.6)')),
        ];
        await new Promise((resolve) => setTimeout(resolve, 250));
        const canaryCount = await countConnections('lms_test_space_canary_586');
        const cCount = await countConnections('lms_test_space_c_586');
        const cpCount = await countConnections(CP_DATABASE);
        expect(canaryCount).toBeGreaterThan(0);
        expect(canaryCount).toBeLessThanOrEqual(3);
        expect(cCount).toBeLessThanOrEqual(3);
        expect(cpCount).toBeLessThanOrEqual(2);
        expect(canaryCount + cCount + cpCount).toBeLessThanOrEqual(8);
        await Promise.all(loads);

        // Sau khi hết việc và qua thời gian thu hồi kết nối nhàn,
        // các kho không còn giữ kết nối nào.
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(await countConnections('lms_test_space_canary_586')).toBe(0);
        expect(await countConnections('lms_test_space_c_586')).toBe(0);
        expect(await countConnections(CP_DATABASE)).toBe(0);
      } finally {
        await canaryPool.end();
        await cPool.end();
        await cpPool.end();
      }
    }, 120_000);
  });

  describe('hồi quy vòng sửa: cô lập lỗi theo kho, tập migration còn thiếu, sao lưu fail-closed và kiểm tra khói', () => {
    // Bộ ca này dùng sổ control plane RIÊNG (`lms_test_cp_fx595`)
    // và các kho riêng để không chạm vào trạng thái registry của
    // các bộ ca trên; role dùng lại bộ role của ca chính (được tạo
    // ở beforeAll ngoài cùng và dọn ở afterAll ngoài cùng). Bộ
    // migration tổng hợp hai thư mục: một migration "cũ" và một
    // migration "đích" — kho fx595-d được áp trước RIÊNG thư mục
    // đích để dựng đúng hình kho có migration mới nhất mà thiếu
    // migration cũ.
    const FX_CP_DATABASE = 'lms_test_cp_fx595';
    const FX_BACKUP_DIR = join(__dirname, 'fleet-fx595-artifacts');
    const FX_MIGRATIONS_FULL = join(__dirname, 'fleet-fx595-migrations-full');
    const FX_MIGRATIONS_TARGET_ONLY = join(__dirname, 'fleet-fx595-migrations-target-only');
    const FX_OLDER_VERSION = '20260101000000_fx_older';
    const FX_TARGET_VERSION = '20260202000000_fx_target';
    const FX_ENCRYPTION_KEY = 'fleet-test-fx595-passphrase';
    const FX_SPACES = [
      { slug: 'fx595-nen-tang', kind: 'platform', database: 'lms_test_fx595_platform' },
      { slug: 'fx595-a-canary', kind: 'center', database: 'lms_test_fx595_canary' },
      { slug: 'fx595-b-chet', kind: 'center', database: 'lms_test_fx595_dead' },
      { slug: 'fx595-c-tot', kind: 'center', database: 'lms_test_fx595_good' },
      { slug: 'fx595-d-thieu-cu', kind: 'center', database: 'lms_test_fx595_stale' },
    ] as const;
    const FX_NOUSERS_SPACE = { slug: 'fx595-e-khong-users', kind: 'center', database: 'lms_test_fx595_nousers' } as const;
    const FX_DEADCONNECT_SPACE = { slug: 'fx595-f-loi-ket-noi', kind: 'center', database: 'lms_test_fx595_deadconnect' } as const;

    const fxEnv = (): NodeJS.ProcessEnv => ({
      ...process.env,
      CONTROL_PLANE_DATABASE_URL: clusterUrl(FX_CP_DATABASE, CP_ROLE, CP_PASSWORD),
      FLEET_BACKUP_ENCRYPTION_KEY: FX_ENCRYPTION_KEY,
    });

    async function fxRegistryState(slug: string): Promise<{
      currentVersion: string | null;
      lastBackupStatus: string | null;
      lastBackupAt: Date | null;
      lastRestoreStatus: string | null;
    }> {
      return withClient(clusterUrl(FX_CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        const result = await client.query<{
          current_version: string | null;
          last_backup_status: string | null;
          last_backup_at: Date | null;
          last_restore_status: string | null;
        }>(
          `SELECT r.current_version, r.last_backup_status, r.last_backup_at, r.last_restore_status
             FROM space_schema_registry r JOIN space_registry s ON s.id = r.space_id
            WHERE s.slug = $1`,
          [slug],
        );
        const row = result.rows[0]!;
        return {
          currentVersion: row.current_version,
          lastBackupStatus: row.last_backup_status,
          lastBackupAt: row.last_backup_at,
          lastRestoreStatus: row.last_restore_status,
        };
      });
    }

    async function fxMigrationRuns(slug: string): Promise<{ status: string }[]> {
      return withClient(clusterUrl(FX_CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        const result = await client.query<{ status: string }>(
          `SELECT m.status FROM space_schema_migration_runs m
             JOIN space_registry s ON s.id = m.space_id
            WHERE s.slug = $1 ORDER BY m.started_at, m.id`,
          [slug],
        );
        return result.rows;
      });
    }

    async function fxRegisterSpace(space: { slug: string; kind: string; database: string }): Promise<void> {
      await withClient(clusterUrl(FX_CP_DATABASE, CP_ROLE, CP_PASSWORD), async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO space_registry (slug, name, kind, status, database_name, storage_mode, connection_role_ref, secret_ref)
           VALUES ($1, $2, $3, 'active', $4, 'dedicated', $5, 'env:FLEET_TEST_SPACE_URL') RETURNING id`,
          [space.slug, `Kho hoi quy ${space.slug}`, space.kind, space.database, MIGRATOR_ROLE],
        );
        await client.query('INSERT INTO space_schema_registry (space_id) VALUES ($1)', [inserted.rows[0]!.id]);
      });
    }

    beforeAll(async () => {
      mkdirSync(join(FX_MIGRATIONS_FULL, FX_OLDER_VERSION), { recursive: true });
      mkdirSync(join(FX_MIGRATIONS_FULL, FX_TARGET_VERSION), { recursive: true });
      mkdirSync(join(FX_MIGRATIONS_TARGET_ONLY, FX_TARGET_VERSION), { recursive: true });
      writeFileSync(
        join(FX_MIGRATIONS_FULL, FX_OLDER_VERSION, 'migration.sql'),
        'CREATE TABLE "fx_older_probe" ("id" integer PRIMARY KEY);\n',
      );
      writeFileSync(
        join(FX_MIGRATIONS_FULL, FX_TARGET_VERSION, 'migration.sql'),
        'CREATE TABLE "fx_target_probe" ("id" integer PRIMARY KEY);\n',
      );
      writeFileSync(
        join(FX_MIGRATIONS_TARGET_ONLY, FX_TARGET_VERSION, 'migration.sql'),
        'CREATE TABLE "fx_target_probe" ("id" integer PRIMARY KEY);\n',
      );
      mkdirSync(FX_BACKUP_DIR, { recursive: true });

      const adminUrl = clusterUrl('postgres');
      await withClient(adminUrl, async (admin) => {
        for (const database of [FX_CP_DATABASE, ...FX_SPACES.map((space) => space.database), FX_NOUSERS_SPACE.database]) {
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [database],
          );
          await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)}`);
        }
        await admin.query(`CREATE DATABASE ${quoted(FX_CP_DATABASE)} OWNER ${quoted(CP_ROLE)}`);
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(FX_CP_DATABASE)} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(FX_CP_DATABASE)} TO ${quoted(CP_ROLE)}`);
        // Kho chết fx595-b KHÔNG được tạo database: mọi kết nối tới
        // nó phải hỏng ngay ở bước mở kết nối của bước thăm dò.
        for (const space of FX_SPACES) {
          if (space.slug === 'fx595-b-chet') continue;
          await admin.query(`CREATE DATABASE ${quoted(space.database)} OWNER ${quoted(MIGRATOR_ROLE)}`);
          await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(space.database)} FROM PUBLIC`);
          await admin.query(`GRANT CONNECT ON DATABASE ${quoted(space.database)} TO ${quoted(MIGRATOR_ROLE)}`);
          await admin.query(`GRANT CONNECT ON DATABASE ${quoted(space.database)} TO ${quoted(RUNTIME_ROLE)}`);
        }
      });
      await applyControlPlaneMigrations(clusterUrl(FX_CP_DATABASE, CP_ROLE, CP_PASSWORD));
      for (const space of FX_SPACES) {
        if (space.slug === 'fx595-b-chet') continue;
        await applyUuidV7ShimIfNeeded(clusterUrl(space.database, MIGRATOR_ROLE, MIGRATOR_PASSWORD));
      }
      for (const space of FX_SPACES) {
        await fxRegisterSpace(space);
      }
      // Dựng hình kho thiếu migration cũ: chỉ áp thư mục đích vào
      // kho fx595-d — nhật ký của nó có migration mới nhất nhưng
      // không có migration cũ.
      const stalePool = new Pool({
        connectionString: clusterUrl('lms_test_fx595_stale', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
      });
      try {
        await migrate(drizzle({ client: stalePool }), { migrationsFolder: FX_MIGRATIONS_TARGET_ONLY });
      } finally {
        await stalePool.end();
      }
    }, 180_000);

    afterAll(async () => {
      const adminUrl = clusterUrl('postgres');
      await withClient(adminUrl, async (admin) => {
        for (const database of [
          FX_CP_DATABASE,
          ...FX_SPACES.map((space) => space.database),
          FX_NOUSERS_SPACE.database,
          FX_DEADCONNECT_SPACE.database,
        ]) {
          await admin.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [database],
          );
          await admin.query(`DROP DATABASE IF EXISTS ${quoted(database)}`);
        }
      }).catch(() => undefined);
      rmSync(FX_BACKUP_DIR, { recursive: true, force: true });
      rmSync(FX_MIGRATIONS_FULL, { recursive: true, force: true });
      rmSync(FX_MIGRATIONS_TARGET_ONLY, { recursive: true, force: true });
    }, 120_000);

    it('kho không kết nối được bị ghi nhận failed và không chặn kho cùng đợt; kho có migration mới nhất nhưng thiếu migration cũ được áp đúng phần thiếu; chạy lại chỉ xử lý kho lỗi', async () => {
      const summary = await runFleetMigration({
        env: fxEnv(),
        migrationsDir: FX_MIGRATIONS_FULL,
        backupDir: FX_BACKUP_DIR,
        waveSize: 3,
        log: () => undefined,
      });
      const bySlug = new Map(summary.outcomes.map((outcome) => [outcome.slug, outcome.outcome]));
      expect(summary.targetVersion).toBe(FX_TARGET_VERSION);
      expect(bySlug.get('fx595-nen-tang')).toBe('migrated');
      expect(bySlug.get('fx595-a-canary')).toBe('migrated');
      // Kho chết hỏng ngay ở bước thăm dò (mở kết nối) nhưng vẫn có
      // ghi nhận failed của chính nó trong registry...
      expect(bySlug.get('fx595-b-chet')).toBe('failed');
      // ...và hai kho CÙNG ĐỢT với nó vẫn hoàn tất bình thường.
      expect(bySlug.get('fx595-c-tot')).toBe('migrated');
      expect(bySlug.get('fx595-d-thieu-cu')).toBe('migrated');
      expect(summary.failedCount).toBe(1);

      const deadRuns = await fxMigrationRuns('fx595-b-chet');
      expect(deadRuns).toHaveLength(1);
      expect(deadRuns[0]!.status).toBe('failed');
      expect((await fxRegistryState('fx595-b-chet')).currentVersion).toBeNull();

      // Kho thiếu migration cũ: sau lượt chạy, bảng của migration
      // cũ tồn tại trong kho, nhật ký đủ cả hai migration và sổ
      // ghi đúng phiên bản đích.
      const staleRuns = await fxMigrationRuns('fx595-d-thieu-cu');
      expect(staleRuns).toHaveLength(1);
      expect(staleRuns[0]!.status).toBe('success');
      expect((await fxRegistryState('fx595-d-thieu-cu')).currentVersion).toBe(FX_TARGET_VERSION);
      await withClient(clusterUrl('lms_test_fx595_stale', MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (client) => {
        const tables = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('fx_older_probe', 'fx_target_probe') ORDER BY tablename`,
        );
        expect(tables.rows.map((row) => row.tablename)).toEqual(['fx_older_probe', 'fx_target_probe']);
      });

      // Chạy lại: kho đã đạt đích bị bỏ qua hết, chỉ kho lỗi bị xử
      // lý lại và nhận thêm đúng một ghi nhận failed nữa.
      const rerun = await runFleetMigration({
        env: fxEnv(),
        migrationsDir: FX_MIGRATIONS_FULL,
        backupDir: FX_BACKUP_DIR,
        waveSize: 3,
        log: () => undefined,
      });
      const rerunBySlug = new Map(rerun.outcomes.map((outcome) => [outcome.slug, outcome.outcome]));
      expect(rerunBySlug.get('fx595-b-chet')).toBe('failed');
      expect(rerunBySlug.get('fx595-c-tot')).toBe('skipped');
      expect(rerunBySlug.get('fx595-d-thieu-cu')).toBe('skipped');
      expect(await fxMigrationRuns('fx595-b-chet')).toHaveLength(2);
      expect(await fxMigrationRuns('fx595-c-tot')).toHaveLength(1);
      expect(await fxMigrationRuns('fx595-d-thieu-cu')).toHaveLength(1);
    }, 300_000);

    it('kho chỉ có các lượt sao lưu thất bại vẫn bị chế độ kiểm liệt kê quá hạn, vì mốc sao lưu thành công không bị lượt hỏng đẩy lên', async () => {
      const backup = await runFleetBackup({ env: fxEnv(), backupDir: FX_BACKUP_DIR, log: () => undefined });
      const deadResult = backup.results.find((result) => result.slug === 'fx595-b-chet');
      expect(deadResult?.status).toBe('failed');
      expect(backup.results.find((result) => result.slug === 'fx595-c-tot')?.status).toBe('success');

      const deadState = await fxRegistryState('fx595-b-chet');
      expect(deadState.lastBackupStatus).toBe('failed');
      // Mốc của cổng kiểm vẫn là null: kho này chưa từng sao lưu
      // thành công, lượt hỏng vừa rồi không được tự gia hạn cho nó.
      expect(deadState.lastBackupAt).toBeNull();

      const check = await checkFleetBackups({ env: fxEnv(), backupDir: FX_BACKUP_DIR });
      expect(check.overdue.map((item) => item.slug)).toEqual(['fx595-b-chet']);
    }, 300_000);

    it('chụp sao lưu thiếu khoá mã hoá bị từ chối trước khi dump và không sinh tệp nào trên đĩa', async () => {
      const dir = join(FX_BACKUP_DIR, 'direct-nokey');
      await expect(
        dumpDatabaseToFile({
          url: clusterUrl('lms_test_fx595_good', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
          dir,
          kind: 'scheduled',
          runId: 'fx595-nokey',
          at: new Date(),
          env: fxEnv(),
        }),
      ).rejects.toThrow(/FLEET_BACKUP_ENCRYPTION_KEY/);
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }, 60_000);

    it('lỗi ở bước ghi tệp mã hoá khiến tệp thô bị xoá sạch khỏi đĩa', async () => {
      const dir = join(FX_BACKUP_DIR, 'direct-encfail');
      const at = new Date();
      const runId = 'fx595-encfail';
      // Ép lỗi ở đúng bước ghi tệp mã hoá: chiếm trước đường dẫn
      // của tệp .enc bằng một THƯ MỤC cùng tên.
      const encName = backupFileName('scheduled', runId, at, true);
      mkdirSync(join(dir, encName), { recursive: true });
      await expect(
        dumpDatabaseToFile({
          url: clusterUrl('lms_test_fx595_good', MIGRATOR_ROLE, MIGRATOR_PASSWORD),
          dir,
          kind: 'scheduled',
          runId,
          at,
          encryptionKey: FX_ENCRYPTION_KEY,
          env: fxEnv(),
        }),
      ).rejects.toThrow();
      // Trên đĩa chỉ còn thư mục chiếm chỗ; tệp thô của pg_dump
      // không được phép ở lại sau bất kỳ đường lỗi nào.
      expect(readdirSync(dir)).toEqual([encName]);
    }, 60_000);

    it('bản khôi phục thiếu bảng users khiến kiểm thử khôi phục thất bại tường minh dù số bảng khớp mục lục, và chỉ tắt được bằng FLEET_SMOKE_CHECK=off', async () => {
      const adminUrl = clusterUrl('postgres');
      await withClient(adminUrl, async (admin) => {
        await admin.query(`CREATE DATABASE ${quoted(FX_NOUSERS_SPACE.database)} OWNER ${quoted(MIGRATOR_ROLE)}`);
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(FX_NOUSERS_SPACE.database)} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(FX_NOUSERS_SPACE.database)} TO ${quoted(MIGRATOR_ROLE)}`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(FX_NOUSERS_SPACE.database)} TO ${quoted(RUNTIME_ROLE)}`);
      });
      await applyUuidV7ShimIfNeeded(clusterUrl(FX_NOUSERS_SPACE.database, MIGRATOR_ROLE, MIGRATOR_PASSWORD));
      // Kho có bảng nghiệp vụ thật nhưng TUYỆT ĐỐI không có bảng
      // users — đúng hình bản sao mà kiểm tra khói không đối
      // chiếu được gì.
      await withClient(clusterUrl(FX_NOUSERS_SPACE.database, MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (client) => {
        await client.query('CREATE TABLE fx_business_probe (id integer PRIMARY KEY, note text NOT NULL)');
        await client.query(`INSERT INTO fx_business_probe (id, note) VALUES (1, 'du kien that')`);
      });
      await fxRegisterSpace(FX_NOUSERS_SPACE);
      await dumpDatabaseToFile({
        url: clusterUrl(FX_NOUSERS_SPACE.database),
        dir: join(FX_BACKUP_DIR, FX_NOUSERS_SPACE.slug),
        kind: 'scheduled',
        runId: 'fx595-nousers',
        at: new Date(),
        encryptionKey: FX_ENCRYPTION_KEY,
        env: fxEnv(),
      });

      const result = await runFleetRestoreTest({
        env: fxEnv(),
        backupDir: FX_BACKUP_DIR,
        spaceSlug: FX_NOUSERS_SPACE.slug,
        log: () => undefined,
      });
      expect(result.status).toBe('failed');
      expect(result.detail).toMatch(/users/);
      expect((await fxRegistryState(FX_NOUSERS_SPACE.slug)).lastRestoreStatus).toBe('failed');

      // Đường tắt hợp lệ duy nhất: tắt tường minh kiểm tra khói.
      const bypassed = await runFleetRestoreTest({
        env: { ...fxEnv(), FLEET_SMOKE_CHECK: 'off' },
        backupDir: FX_BACKUP_DIR,
        spaceSlug: FX_NOUSERS_SPACE.slug,
        log: () => undefined,
      });
      expect(bypassed.status).toBe('success');
    }, 300_000);

    it('kết nối quản trị hỏng khi kiểm thử khôi phục: lượt chạy được ghi nhận failed và không để lại tệp dump thô ở thư mục sao lưu', async () => {
      const adminUrl = clusterUrl('postgres');
      await withClient(adminUrl, async (admin) => {
        await admin.query(`CREATE DATABASE ${quoted(FX_DEADCONNECT_SPACE.database)} OWNER ${quoted(MIGRATOR_ROLE)}`);
        await admin.query(`REVOKE CONNECT ON DATABASE ${quoted(FX_DEADCONNECT_SPACE.database)} FROM PUBLIC`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(FX_DEADCONNECT_SPACE.database)} TO ${quoted(MIGRATOR_ROLE)}`);
        await admin.query(`GRANT CONNECT ON DATABASE ${quoted(FX_DEADCONNECT_SPACE.database)} TO ${quoted(RUNTIME_ROLE)}`);
      });
      // Kho có dữ kiện thật (bảng users với tài khoản quản trị
      // gieo sẵn như một kho đang vận hành) để bản sao lưu của nó
      // là một bản dump hoàn chỉnh — đúng thứ sẽ bị bỏ lại ở dạng
      // thô nếu đường dọn dẹp của kiểm thử khôi phục bị hở.
      await withClient(clusterUrl(FX_DEADCONNECT_SPACE.database, MIGRATOR_ROLE, MIGRATOR_PASSWORD), async (client) => {
        await client.query('CREATE TABLE users (id integer PRIMARY KEY, username text NOT NULL)');
        await client.query(`INSERT INTO users (id, username) VALUES (1, 'admin')`);
      });
      await fxRegisterSpace(FX_DEADCONNECT_SPACE);
      await dumpDatabaseToFile({
        url: clusterUrl(FX_DEADCONNECT_SPACE.database),
        dir: join(FX_BACKUP_DIR, FX_DEADCONNECT_SPACE.slug),
        kind: 'scheduled',
        runId: 'fx595-deadconnect',
        at: new Date(),
        encryptionKey: FX_ENCRYPTION_KEY,
        env: fxEnv(),
      });
      expect((await fxRegistryState(FX_DEADCONNECT_SPACE.slug)).lastRestoreStatus).toBeNull();

      // Ép kết nối quản trị hỏng: URL quản trị trỏ vào một cổng
      // không có tiến trình nào nghe, nên bước mở kết nối tới
      // database tạm hỏng ngay — tại thời điểm đó tệp dump thô
      // trung gian đã được ghi xuống thư mục sao lưu rồi.
      const deadAdmin = new URL(clusterUrl('postgres'));
      deadAdmin.port = '59999';
      const result = await runFleetRestoreTest({
        env: { ...fxEnv(), DATABASE_ADMIN_URL: deadAdmin.toString() },
        backupDir: FX_BACKUP_DIR,
        spaceSlug: FX_DEADCONNECT_SPACE.slug,
        log: () => undefined,
      });

      // Lượt hỏng được ghi nhận như mọi lỗi vận hành sau khi đã
      // chọn kho, thay vì để ngoại lệ thoát thẳng làm mất dấu.
      expect(result.status).toBe('failed');
      expect((await fxRegistryState(FX_DEADCONNECT_SPACE.slug)).lastRestoreStatus).toBe('failed');
      // Tệp dump thô trung gian không được ở lại trên đĩa ở bất
      // kỳ đường ra nào: nó là toàn bộ dữ kiện của kho ở dạng
      // đọc được, và tên của nó không khớp khuôn tệp sao lưu nên
      // không cơ chế dọn theo hạn nào nhìn thấy nó.
      expect(readdirSync(FX_BACKUP_DIR).filter((name) => name.startsWith('.restore-'))).toEqual([]);
    }, 120_000);
  });
});
