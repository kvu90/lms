/**
 * Spec tích hợp của bộ máy migration của `@lms/db` (issue #639,
 * hoàn thiện ở #663): chứng minh trên database thật rằng bộ máy áp
 * đủ carrier với đúng số đếm kỳ vọng, hàm đọc nhật ký chỉ đọc
 * `kysely_migration`, runner CLI dừng to tiếng trước database lạ,
 * trạng thái "đã áp carrier, native đang chờ" được áp tiếp đúng
 * phần native, và ngữ nghĩa transaction/khoá mà runner production
 * dựa vào được giữ đúng.
 *
 * Lưu ý về "mô phỏng nhật ký cũ": một ca tự tạo schema `drizzle` +
 * bảng `__drizzle_migrations` rồi chèn tên carrier — đó là mô
 * phỏng nhật ký mà bộ máy cũ ghi, KHÔNG phải chạy bộ máy cũ thật.
 * Điều ca đó chứng minh là hàm đọc nhật ký BỎ QUA nhật ký cũ sau
 * khi gỡ Drizzle (issue #663): nguồn sự thật duy nhất là
 * `kysely_migration`. (Trước #663 package còn bước cấy nhật ký
 * chép tên từ nhật ký cũ sang; cửa sổ chuyển đổi đã đóng nên bước
 * cấy và các ca kiểm của nó đã gỡ cùng PR này.)
 *
 * Môi trường: cụm PostgreSQL quản trị từ `LMS_DB_TEST_ADMIN_URL`
 * (hoặc suy từ `DATABASE_URL` như spec khói của harness). Các
 * database test bị xoá và dựng lại ở đầu suite, xoá hẳn khi xong.
 * Thử nghiệm T-3 chạy tiến trình con `node -e` dùng `kysely` từ
 * `node_modules` của package (không phụ thuộc dist đã build).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { Migrator, type MigrationProvider } from 'kysely/migration';
import { Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestDatabase, dropTestDatabase, withDatabase } from '../test-support/build-test-database';
import { FrozenSqlProvider, listMigrationNames } from './frozen-sql-provider';
import { getAppliedMigrations } from './journal';
import { installUuidv7Shim, MIGRATION_STORES, UUIDV7_SHIM } from './stores';
import { verifyStore } from './verify';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : 'postgres://postgres:postgres@localhost:5432/postgres');

const CENTRE_DB = 'lms_db_migrate_n2_centre';
const STRANGE_DB = 'lms_db_migrate_n2_strange';
const PROD_DB = 'lms_db_migrate_n2_prod';
const T2_DB = 'lms_db_migrate_n2_t2';
const T3_DB = 'lms_db_migrate_n2_t3';

/**
 * Diện carrier đóng băng của kho control plane (định nghĩa tại
 * `stores.ts`). Khác với `listMigrationNames` (mọi migration trong
 * thư mục, gồm cả migration native): diện này dùng để dựng trạng
 * thái "mới áp carrier, native chưa áp" và để hậu kiểm đòi đúng
 * các carrier thật phải có mặt trong nhật ký.
 */
const CP_CARRIERS: string[] = MIGRATION_STORES['control-plane'].carrierNames;

function packageMigrationsDir(store: 'centre' | 'control-plane' | 'system-bank'): string {
  return join(process.cwd(), 'migrations', store);
}

/**
 * Provider chỉ chứa các migration có tên thuộc tập cho trước, dựng
 * trên `FrozenSqlProvider` đầy đủ — dùng để dựng trạng thái "mới áp
 * một phần" (ví dụ database production mới áp carrier, migration
 * native chưa áp) mà provider đầy đủ không dựng được.
 */
function providerOnly(migrationsDir: string, names: readonly string[]): MigrationProvider {
  const inner = new FrozenSqlProvider(migrationsDir);
  return {
    async getMigrations() {
      const all = await inner.getMigrations();
      return Object.fromEntries(Object.entries(all).filter(([name]) => names.includes(name)));
    },
  };
}

/** Đọc DEFAULT hiện tại của `space_registry_history.created_at` từ `information_schema`. */
async function registryCreatedAtDefault(dbUrl: string): Promise<string | null> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'space_registry_history' AND column_name = 'created_at'`,
    );
    return result.rows[0]?.column_default ?? null;
  } finally {
    await client.end();
  }
}

/** Tạo database trống (xoá nếu có) và trả connection string tới nó. */
async function freshDatabase(name: string): Promise<string> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return withDatabase(adminUrl, name);
}

/** Dựng nhật ký của bộ máy cũ mô phỏng với đúng tập tên cho trước (để chứng minh hàm đọc nhật ký bỏ qua nó sau #663). */
async function mockLegacyJournal(dbUrl: string, names: string[]): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query(
      'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at numeric, name text)',
    );
    for (const name of names) {
      await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ($1, $2, $3)', [
        `mock-hash-${name}`,
        0,
        name,
      ]);
    }
  } finally {
    await client.end();
  }
}

/** Dựng bảng `kysely_migration` với đúng tập tên cho trước (trạng thái nhật ký lạ cho ca CLI). */
async function mockKyselyJournal(dbUrl: string, names: string[]): Promise<void> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)');
    for (const name of names) {
      await client.query('INSERT INTO kysely_migration (name, timestamp) VALUES ($1, $2)', [
        name,
        new Date(0).toISOString(),
      ]);
    }
  } finally {
    await client.end();
  }
}

async function kyselyNames(dbUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query<{ name: string }>('SELECT name FROM kysely_migration ORDER BY name');
    return result.rows.map((row) => row.name);
  } finally {
    await client.end();
  }
}

async function tableExists(dbUrl: string, table: string): Promise<boolean> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const result = await client.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [
      'public',
      table,
    ]);
    return result.rows.length > 0;
  } finally {
    await client.end();
  }
}

async function countPublic(dbUrl: string, kind: 'tables' | 'policies' | 'indexes'): Promise<number> {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    if (kind === 'tables') {
      const result = await client.query(
        `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('kysely_migration', 'kysely_migration_lock')`,
      );
      return result.rows[0].n as number;
    }
    if (kind === 'policies') {
      const result = await client.query(
        `SELECT count(*)::int AS n FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public'`,
      );
      return result.rows[0].n as number;
    }
    // Cùng cơ số đo với hậu kiểm của package (mốc 416): chỉ index
    // không đỡ ràng buộc PK/UNIQUE.
    const result = await client.query(
      `SELECT count(*)::int AS n FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_namespace ns ON ns.oid = ic.relnamespace
       JOIN pg_class tc ON tc.oid = i.indrelid
       WHERE ns.nspname = 'public'
         AND tc.relname NOT IN ('kysely_migration', 'kysely_migration_lock')
         AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)`,
    );
    return result.rows[0].n as number;
  } finally {
    await client.end();
  }
}

describe('bộ máy migration của package cho ba kho', () => {
  let centreUrl = '';

  beforeAll(async () => {
    centreUrl = await buildTestDatabase({ adminUrl, database: CENTRE_DB, store: 'centre' });
  }, 300_000);

  afterAll(async () => {
    await dropTestDatabase(adminUrl, CENTRE_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, STRANGE_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, PROD_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, T2_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, T3_DB).catch(() => undefined);
  });

  it('áp đủ carrier kho trung tâm trên database trống với đúng số đếm kỳ vọng', async () => {
    const verifyPool = new Pool({ connectionString: centreUrl });
    const verifyDb = new Kysely({ dialect: new PostgresDialect({ pool: verifyPool }) });
    const result = await verifyStore(verifyDb, 'centre');
    await verifyDb.destroy().catch(() => undefined);
    expect(result.ok).toBe(true);
    expect(result.tables).toBe(202);
    expect(result.policies).toBe(21);
    expect(result.indexes).toBe(416);
    expect(result.journalRows).toBe(1);
    expect(await countPublic(centreUrl, 'tables')).toBe(202);
    expect(await countPublic(centreUrl, 'policies')).toBe(21);
    expect(await countPublic(centreUrl, 'indexes')).toBe(416);
  });

  it('hàm đọc nhật ký chỉ đọc kysely_migration: database trống trả tập rỗng, nhật ký cũ bị bỏ qua, nhật ký Kysely trả đúng tập tên', async () => {
    const carrierNames = [...CP_CARRIERS];
    const fresh = await freshDatabase('lms_db_migrate_n2_dual');
    try {
      const empty = new Client({ connectionString: fresh });
      await empty.connect();
      try {
        expect(await getAppliedMigrations(empty)).toEqual([]);
      } finally {
        await empty.end();
      }
      // Database CHỈ có nhật ký của bộ máy cũ (chưa từng qua bộ máy
      // này): sau #663 không còn đường đọc dự phòng — tập đã áp là
      // rỗng, đúng hệ quả đã chốt khi đóng cửa sổ chuyển đổi.
      await mockLegacyJournal(fresh, carrierNames);
      const legacyOnly = new Client({ connectionString: fresh });
      await legacyOnly.connect();
      try {
        expect(await getAppliedMigrations(legacyOnly)).toEqual([]);
      } finally {
        await legacyOnly.end();
      }
      const migrated = new Client({ connectionString: centreUrl });
      await migrated.connect();
      try {
        expect(await getAppliedMigrations(migrated)).toEqual(['20261025163710_baseline']);
      } finally {
        await migrated.end();
      }
    } finally {
      await dropTestDatabase(adminUrl, 'lms_db_migrate_n2_dual').catch(() => undefined);
    }
  });

  it('tên lạ trong nhật ký Kysely làm runner CLI thoát mã khác 0', async () => {
    const strangeUrl = await freshDatabase(STRANGE_DB);
    await mockKyselyJournal(strangeUrl, ['99999999999999_ten_la_khong_thuoc_bo_migration']);
    // Đường CLI của package phải dừng to tiếng trước database lạ
    // (Migrator từ chối tập đã áp lạ, hoặc hậu kiểm lệch số dòng
    // nhật ký kỳ vọng) — thoát mã khác 0, không áp lặng lẽ.
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), 'dist', 'migrate', 'run.js'), 'control-plane'],
      { env: { ...process.env, DATABASE_URL: strangeUrl, CONTROL_PLANE_DATABASE_URL: strangeUrl }, encoding: 'utf8' },
    );
    expect(run.status).not.toBe(0);
  });

  it('database có nhật ký chỉ gồm carrier và migration native đang chờ: migrateToLatest áp native, chạy lại là no-op', async () => {
    // Ca tái hiện sự cố deploy sau PR #687 (issue #689): trạng thái
    // của database production lúc lỗi — schema đã dựng bằng carrier,
    // nhật ký chỉ có các dòng carrier, migration native của kho chưa
    // áp. Runner phải áp native thay vì dừng vì "thiếu carrier".
    const dir = packageMigrationsDir('control-plane');
    const allNames = listMigrationNames(dir);
    const nativeNames = allNames.filter((name) => !CP_CARRIERS.includes(name));
    expect(nativeNames).toHaveLength(1);
    const prodUrl = await freshDatabase(PROD_DB);
    const pool = new Pool({ connectionString: prodUrl });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      // Dựng trạng thái production: shim trên database trống, rồi
      // chỉ áp carrier bằng provider lọc — trạng thái cuối tương
      // đương database production đã áp carrier (schema do chính
      // SQL carrier dựng, nhật ký chỉ có carrier).
      await installUuidv7Shim(db);
      const carrierMigrator = new Migrator({ db, provider: providerOnly(dir, CP_CARRIERS) });
      const firstRun = await carrierMigrator.migrateToLatest();
      expect(firstRun.error).toBeUndefined();
      expect(await kyselyNames(prodUrl)).toEqual([...CP_CARRIERS].sort());
      expect(await registryCreatedAtDefault(prodUrl)).toContain('now()');

      // Lượt runner trên trạng thái production: migrateToLatest áp
      // đúng migration native đang chờ (không đòi gì thêm ở nhật ký).
      const migrator = new Migrator({ db, provider: new FrozenSqlProvider(dir) });
      const { error, results } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
      expect((results ?? []).map((r) => r.migrationName)).toEqual(nativeNames);
      expect((results ?? []).every((r) => r.status === 'Success')).toBe(true);
      expect(await kyselyNames(prodUrl)).toEqual([...allNames].sort());
      expect(await registryCreatedAtDefault(prodUrl)).toContain('clock_timestamp()');
      const verified = await verifyStore(db, 'control-plane');
      expect(verified.ok).toBe(true);

      // Chạy lại toàn trình trên database đã áp đủ: no-op sạch.
      const again = await migrator.migrateToLatest();
      expect(again.error).toBeUndefined();
      expect(again.results ?? []).toHaveLength(0);
      expect(await kyselyNames(prodUrl)).toEqual([...allNames].sort());
    } finally {
      await db.destroy().catch(() => undefined);
    }
  });

  it('down() của carrier ném lỗi tường minh thay vì chế tác SQL ngược', async () => {
    const provider = new FrozenSqlProvider(packageMigrationsDir('control-plane'));
    const migrations = await provider.getMigrations();
    const first = Object.values(migrations)[0]!;
    await expect(first.down!(null as unknown as Kysely<any>)).rejects.toThrow(/không có down/);
  });

  it('chuỗi shim uuidv7 trong package khớp từng byte với hằng trong centre-provision', () => {
    const provisionPath = join(process.cwd(), '..', '..', 'apps', 'api', 'src', 'modules', 'tenants', 'centre-provision.ts');
    const source = readFileSync(provisionPath, 'utf8');
    const match = source.match(/UUIDV7_SHIM\s*=\s*`([\s\S]*?)`;/);
    expect(match).not.toBeNull();
    expect(UUIDV7_SHIM).toBe(match![1]);
  });

  it('shim được cài ngoài carrier: hàm uuidv7() gọi được mà không ghi vào nhật ký', async () => {
    const shimUrl = await freshDatabase('lms_db_migrate_n2_shim');
    const pool = new Pool({ connectionString: shimUrl });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      await installUuidv7Shim(db);
      // Trên PG18 hàm tích hợp sẵn (pg_catalog) thỏa kiểm này; dưới
      // PG18 shim viết tay trong schema public thỏa kiểm này. Điểm
      // chung cần chứng minh: sau bước tiền-migration, uuidv7()
      // gọi được — và nhật ký không bị ghi thêm bởi bước shim.
      const check = new Client({ connectionString: shimUrl });
      await check.connect();
      try {
        const fn = await check.query("SELECT uuidv7() AS id");
        expect(fn.rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      } finally {
        await check.end();
      }
    } finally {
      await db.destroy().catch(() => undefined);
      await dropTestDatabase(adminUrl, 'lms_db_migrate_n2_shim').catch(() => undefined);
    }
  });

  it('T-2: migration thứ hai lỗi thì toàn bộ lượt migrate rollback (độ hạt transaction)', async () => {
    const t2Url = await freshDatabase(T2_DB);
    const pool = new Pool({ connectionString: t2Url });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    const provider: MigrationProvider = {
      async getMigrations() {
        return {
          '0001_tao_bang': {
            async up(db2: Kysely<any>) {
              await db2.schema.createTable('t2_first').addColumn('id', 'integer').execute();
            },
          },
          '0002_co_y_loi': {
            async up() {
              throw new Error('loi co y cua T-2');
            },
          },
        };
      },
    };
    try {
      const migrator = new Migrator({ db, provider });
      const { error, results } = await migrator.migrateToLatest();
      expect(error).toBeDefined();
      console.log('T-2 results:', JSON.stringify(results?.map((r) => ({ name: r.migrationName, status: r.status }))));
      console.log('T-2 bang t2_first ton tai:', await tableExists(t2Url, 't2_first'));
      console.log('T-2 dong kysely_migration:', await kyselyNames(t2Url).catch(() => ['<bang chua ton tai>']));
      // Kết luận đo được (ghi vào thân PR): toàn bộ lượt migrate
      // nằm trong MỘT transaction nên bảng của migration 1 cũng
      // rollback và nhật ký không ghi dòng nào.
      expect(await tableExists(t2Url, 't2_first')).toBe(false);
      expect(await kyselyNames(t2Url).catch(() => [] as string[])).toEqual([]);
    } finally {
      await db.destroy().catch(() => undefined);
    }
  });

  it('T-3: kill tiến trình đang migrate rồi chạy lại ngay thì khoá tự giải phóng', async () => {
    const t3Url = await freshDatabase(T3_DB);
    const childCode = `
const { Pool } = require('pg');
const { Kysely, PostgresDialect, sql } = require('kysely');
const { Migrator } = require('kysely/migration');
(async () => {
  const pool = new Pool({ connectionString: process.env.MIGRATE_T3_URL });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const m = new Migrator({ db, provider: { getMigrations: async () => ({
    '0001_sleep': { async up(d) { await sql\`select pg_sleep(120)\`.execute(d); } },
    '0002_probe': { async up(d) { await d.schema.createTable('t3_probe').addColumn('id', 'integer').execute(); } },
  }) } });
  const r = await m.migrateToLatest();
  console.log(JSON.stringify(r));
  await db.destroy();
})().catch((e) => { console.error(e); process.exit(1); });
`;
    const child: ChildProcess = spawn(process.execPath, ['-e', childCode], {
      env: { ...process.env, MIGRATE_T3_URL: t3Url },
      cwd: process.cwd(),
    });
    // Chờ backend của tiến trình con vào trạng thái pg_sleep (đang
    // giữ khoá advisory của Migrator) rồi SIGKILL.
    const watcher = new Client({ connectionString: t3Url });
    await watcher.connect();
    try {
      let sleeping = false;
      for (let i = 0; i < 150 && !sleeping; i++) {
        const found = await watcher.query(
          "SELECT 1 FROM pg_stat_activity WHERE query ILIKE '%pg_sleep%' AND state = 'active'",
        );
        sleeping = found.rows.length > 0;
        if (!sleeping) await new Promise((r) => setTimeout(r, 200));
      }
      expect(sleeping).toBe(true);
    } finally {
      await watcher.end();
    }
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    // Chạy lại ngay với provider chỉ còn migration tạo bảng: nếu
    // khoá advisory còn giữ, Migrator sẽ chờ tới hết timeout khoá
    // (1 giờ) mới báo lỗi — hoàn tất nhanh chứng minh khoá cấp
    // session tự giải phóng khi tiến trình chết.
    const started = Date.now();
    const pool = new Pool({ connectionString: t3Url });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      const migrator = new Migrator({
        db,
        provider: {
          async getMigrations() {
            return {
              '0002_probe': {
                async up(db2: Kysely<any>) {
                  await db2.schema.createTable('t3_probe').addColumn('id', 'integer').execute();
                },
              },
            };
          },
        },
      });
      const { error } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
      const elapsed = Date.now() - started;
      console.log('T-3 thoi gian chay lai (ms):', elapsed);
      expect(elapsed).toBeLessThan(120_000);
      expect(await tableExists(t3Url, 't3_probe')).toBe(true);
      expect(await kyselyNames(t3Url)).toEqual(['0002_probe']);
    } finally {
      await db.destroy().catch(() => undefined);
    }
  }, 300_000);
});
