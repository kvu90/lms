import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFleetBackups, runFleetBackup } from '../../../src/fleet-backup';
import { readDatabaseSchemaVersion } from '../../../src/fleet-common';
import { runFleetMigration } from '../../../src/fleet-migration-runner';
import { runFleetRestoreTest } from '../../../src/fleet-restore-test';
import { runRuntimeRolesSetup } from '../../../src/runtime-roles-setup';

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
  const outDir = join(__dirname, '..', '..', '..', 'drizzle-control-plane');
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
      migrationsDir: join(__dirname, '..', '..', '..', 'drizzle'),
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
      expect(brokenBackups.some((name) => name.startsWith('pre-migration-') && name.endsWith('.dump'))).toBe(true);
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
        const dump = files.find((name) => name.startsWith('scheduled-') && name.endsWith('.dump'));
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
        .filter((name) => name.endsWith('.dump'))
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
});
