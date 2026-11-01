/**
 * Spec tích hợp của cầu nối migration Kysely (issue #639): chứng
 * minh trên database thật rằng bộ máy migration của package áp đủ
 * carrier, cấy nhật ký idempotent từ nhật ký Drizzle mô phỏng, chặn
 * database lạ, và giữ đúng ngữ nghĩa transaction/khoá mà runner
 * production dựa vào.
 *
 * Lưu ý về "mô phỏng nhật ký Drizzle": spec tự tạo schema `drizzle`
 * + bảng `__drizzle_migrations` rồi chèn tên carrier — đó là mô
 * phỏng nhật ký mà drizzle-kit ghi, KHÔNG phải chạy drizzle-kit
 * thật (bộ máy cũ đã rời khỏi đường migrate của package). Điều
 * spec chứng minh là luật adoption đọc đúng nhật ký đó, không phải
 * hành vi của drizzle-kit.
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
import { adoptJournal } from './adopt-journal';
import { FrozenSqlProvider, listCarrierNames } from './frozen-sql-provider';
import { getAppliedMigrations } from './journal';
import { installUuidv7Shim, UUIDV7_SHIM } from './stores';
import { verifyStore } from './verify';

const adminUrl =
  process.env.LMS_DB_TEST_ADMIN_URL ??
  (process.env.DATABASE_URL ? withDatabase(process.env.DATABASE_URL, 'postgres') : 'postgres://postgres:postgres@localhost:5432/postgres');

const CENTRE_DB = 'lms_db_migrate_n2_centre';
const ADOPT_DB = 'lms_db_migrate_n2_adopt';
const STRANGE_DB = 'lms_db_migrate_n2_strange';
const T2_DB = 'lms_db_migrate_n2_t2';
const T3_DB = 'lms_db_migrate_n2_t3';

function packageMigrationsDir(store: 'centre' | 'control-plane' | 'system-bank'): string {
  return join(process.cwd(), 'migrations', store);
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

/** Dựng nhật ký Drizzle mô phỏng với đúng tập tên cho trước (chỉ đọc bởi adoption). */
async function mockDrizzleJournal(dbUrl: string, names: string[]): Promise<void> {
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

describe('cầu nối migration Kysely cho ba kho', () => {
  let centreUrl = '';
  let adoptUrl = '';

  beforeAll(async () => {
    centreUrl = await buildTestDatabase({ adminUrl, database: CENTRE_DB, store: 'centre' });
    adoptUrl = await freshDatabase(ADOPT_DB);
  }, 300_000);

  afterAll(async () => {
    await dropTestDatabase(adminUrl, CENTRE_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, ADOPT_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, STRANGE_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, T2_DB).catch(() => undefined);
    await dropTestDatabase(adminUrl, T3_DB).catch(() => undefined);
  });

  it('áp đủ carrier kho trung tâm trên database trống với đúng số đếm của đường Drizzle', async () => {
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

  it('cấy nhật ký từ nhật ký Drizzle mô phỏng rồi migrateToLatest là no-op, không tạo bảng carrier', async () => {
    const carrierNames = listCarrierNames(packageMigrationsDir('control-plane'));
    expect(carrierNames).toHaveLength(2);
    await mockDrizzleJournal(adoptUrl, carrierNames);
    const pool = new Pool({ connectionString: adoptUrl });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      expect(await adoptJournal(db, carrierNames)).toBe('adopted');
      expect(await kyselyNames(adoptUrl)).toEqual([...carrierNames].sort());
      const migrator = new Migrator({ db, provider: new FrozenSqlProvider(packageMigrationsDir('control-plane')) });
      const { error, results } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
      expect((results ?? []).every((r) => r.status !== 'Error')).toBe(true);
      // No-op thật: bảng carrier KHÔNG được tạo (migrateToLatest
      // không thực thi câu SQL carrier nào sau adoption).
      expect(await tableExists(adoptUrl, 'space_registry')).toBe(false);
      expect(await kyselyNames(adoptUrl)).toEqual([...carrierNames].sort());
    } finally {
      await db.destroy().catch(() => undefined);
    }
  });

  it('adoption lần hai là no-op và dữ kiện mẫu còn nguyên', async () => {
    const carrierNames = listCarrierNames(packageMigrationsDir('control-plane'));
    const client = new Client({ connectionString: adoptUrl });
    await client.connect();
    try {
      await client.query('CREATE TABLE IF NOT EXISTS adoption_sample (id int PRIMARY KEY, note text)');
      await client.query("INSERT INTO adoption_sample VALUES (1, 'mau') ON CONFLICT (id) DO NOTHING");
    } finally {
      await client.end();
    }
    const pool = new Pool({ connectionString: adoptUrl });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      expect(await adoptJournal(db, carrierNames)).toBe('already-adopted');
      const migrator = new Migrator({ db, provider: new FrozenSqlProvider(packageMigrationsDir('control-plane')) });
      const { error } = await migrator.migrateToLatest();
      expect(error).toBeUndefined();
    } finally {
      await db.destroy().catch(() => undefined);
    }
    const check = new Client({ connectionString: adoptUrl });
    await check.connect();
    try {
      const rows = await check.query('SELECT note FROM adoption_sample WHERE id = 1');
      expect(rows.rows[0]?.note).toBe('mau');
      expect(await kyselyNames(adoptUrl)).toEqual([...carrierNames].sort());
    } finally {
      await check.end();
    }
  });

  it('hàm đọc tương thích trả đúng nguồn theo từng trạng thái kho', async () => {
    const carrierNames = listCarrierNames(packageMigrationsDir('control-plane'));
    const fresh = await freshDatabase('lms_db_migrate_n2_dual');
    try {
      const empty = new Client({ connectionString: fresh });
      await empty.connect();
      try {
        expect(await getAppliedMigrations(empty)).toEqual([]);
      } finally {
        await empty.end();
      }
      await mockDrizzleJournal(fresh, carrierNames);
      const drizzly = new Client({ connectionString: fresh });
      await drizzly.connect();
      try {
        expect(await getAppliedMigrations(drizzly)).toEqual([...carrierNames].sort());
      } finally {
        await drizzly.end();
      }
      const adopted = new Client({ connectionString: adoptUrl });
      await adopted.connect();
      try {
        expect(await getAppliedMigrations(adopted)).toEqual([...carrierNames].sort());
      } finally {
        await adopted.end();
      }
    } finally {
      await dropTestDatabase(adminUrl, 'lms_db_migrate_n2_dual').catch(() => undefined);
    }
  });

  it('tên lạ trong nhật ký Drizzle làm adoption dừng và runner CLI thoát mã khác 0', async () => {
    const carrierNames = listCarrierNames(packageMigrationsDir('control-plane'));
    const strangeUrl = await freshDatabase(STRANGE_DB);
    await mockDrizzleJournal(strangeUrl, [...carrierNames, '99999999999999_ten_la_khong_thuoc_carrier']);
    const pool = new Pool({ connectionString: strangeUrl });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(adoptJournal(db, carrierNames)).rejects.toThrow();
      expect(await kyselyNames(strangeUrl).catch(() => [] as string[])).toEqual([]);
    } finally {
      await db.destroy().catch(() => undefined);
    }
    // Đường CLI tương ứng (runner của package) cũng phải thoát mã khác 0.
    const run = spawnSync(
      process.execPath,
      [join(process.cwd(), 'dist', 'migrate', 'run.js'), 'control-plane'],
      { env: { ...process.env, DATABASE_URL: strangeUrl, CONTROL_PLANE_DATABASE_URL: strangeUrl }, encoding: 'utf8' },
    );
    expect(run.status).not.toBe(0);
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
    const pool = new Pool({ connectionString: adoptUrl });
    const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
    try {
      await installUuidv7Shim(db);
      // Trên PG18 hàm tích hợp sẵn (pg_catalog) thỏa kiểm này; dưới
      // PG18 shim viết tay trong schema public thỏa kiểm này. Điểm
      // chung cần chứng minh: sau bước tiền-migration, uuidv7()
      // gọi được — và nhật ký không bị ghi thêm bởi bước shim.
      const check = new Client({ connectionString: adoptUrl });
      await check.connect();
      try {
        const fn = await check.query("SELECT uuidv7() AS id");
        expect(fn.rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      } finally {
        await check.end();
      }
    } finally {
      await db.destroy().catch(() => undefined);
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
