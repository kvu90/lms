/**
 * Lệnh `db:types` của `@lms/db`: sinh lại cả ba file kiểu Kysely
 * (`src/types/centre-db.d.ts`, `src/types/control-plane-db.d.ts`,
 * `src/types/system-bank-db.d.ts`) từ cơ sở dữ liệu THẬT dựng từ rỗng
 * bằng đúng bộ SQL đang mang dữ liệu hiện hành (carrier), rồi chạy
 * kysely-codegen cho từng kho.
 *
 * Luồng cho mỗi kho:
 *   1. Xoá và tạo mới một database tạm riêng trên cụm đích (tên cố
 *      định `lms_types_<kho>`) qua kết nối quản trị.
 *   2. Nếu cụm chạy PostgreSQL dưới 18: cài shim `uuidv7()` viết tay
 *      TRƯỚC khi áp SQL — bản PG18 có hàm tích hợp nên bỏ qua. Shim
 *      nằm NGOÀI nội dung carrier (carrier giữ nguyên từng byte).
 *   3. Áp toàn bộ thư mục migration của kho theo thứ tự tên thư mục,
 *      tách câu lệnh theo dấu `--> statement-breakpoint` — đúng cách
 *      bộ harness test của repo vẫn replay SQL mang dữ liệu.
 *   4. Chạy CLI kysely-codegen với file cấu hình riêng của kho
 *      (`scripts/codegen/<kho>.json`: override từng cột jsonb có
 *      `$type<…>` bên phía Drizzle + customImports trỏ về nơi định
 *      nghĩa kiểu thật) và ghi ra `src/types/<kho>-db.d.ts`.
 *
 * Kết nối quản trị lấy từ biến môi trường `DB_TYPES_ADMIN_URL`; thiếu
 * biến này thì suy từ `DATABASE_URL` bằng cách thay tên database
 * thành `postgres`. Cả hai đều vắng thì lệnh dừng với lỗi rõ ràng —
 * cổng chống lệch (drift) trong CI chạy lệnh này rồi kiểm
 * `git diff --exit-code` trên `src/types/`, nên đầu ra phải tái lập
 * y hệt trên mọi máy cùng phiên bản PostgreSQL 18.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Hàm `uuidv7()` cho cụm PostgreSQL dưới 18 — trích nguyên văn hằng số
 * `UUIDV7_SHIM` trong `apps/api/src/modules/tenants/centre-provision.ts`
 * (pipeline cấp phát trung tâm dùng đúng chuỗi này; mọi bản sao trong
 * repo phải khớp từng byte với nguồn đó).
 */
const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/** Ba kho dữ liệu và vị trí carrier/codegen tương ứng của từng kho. */
const STORES = [
  {
    key: 'centre',
    database: 'lms_types_centre',
    migrationsDir: join(packageDir, 'migrations', 'centre'),
    configFile: join(packageDir, 'scripts', 'codegen', 'centre.json'),
    outFile: join(packageDir, 'src', 'types', 'centre-db.d.ts'),
  },
  {
    key: 'control-plane',
    database: 'lms_types_control_plane',
    migrationsDir: join(packageDir, 'migrations', 'control-plane'),
    configFile: join(packageDir, 'scripts', 'codegen', 'control-plane.json'),
    outFile: join(packageDir, 'src', 'types', 'control-plane-db.d.ts'),
  },
  {
    key: 'system-bank',
    database: 'lms_types_system_bank',
    migrationsDir: join(packageDir, 'migrations', 'system-bank'),
    configFile: join(packageDir, 'scripts', 'codegen', 'system-bank.json'),
    outFile: join(packageDir, 'src', 'types', 'system-bank-db.d.ts'),
  },
];

/** Suy URL của một database cụ thể từ URL quản trị. */
function databaseUrl(adminUrl, database) {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Lấy URL quản trị: ưu tiên `DB_TYPES_ADMIN_URL`, sau đó suy từ `DATABASE_URL`. */
function resolveAdminUrl() {
  if (process.env.DB_TYPES_ADMIN_URL) return process.env.DB_TYPES_ADMIN_URL;
  if (process.env.DATABASE_URL) return databaseUrl(process.env.DATABASE_URL, 'postgres');
  throw new Error(
    'Thiếu kết nối quản trị: đặt DB_TYPES_ADMIN_URL (hoặc DATABASE_URL) trỏ tới cụm PostgreSQL đích trước khi chạy db:types.',
  );
}

/**
 * Áp một thư mục migration (carrier) vào database vừa tạo: cài shim
 * `uuidv7()` trước nếu cụm dưới PG18, rồi chạy từng câu lệnh của mọi
 * `migration.sql` theo thứ tự tên thư mục.
 */
async function applyCarrier(client, migrationsDir) {
  const { rows } = await client.query('SHOW server_version_num');
  const major = Math.floor(Number(rows[0].server_version_num) / 10000);
  if (major < 18) {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(UUIDV7_SHIM);
  }
  const folders = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const folder of folders) {
    const sql = readFileSync(join(migrationsDir, folder, 'migration.sql'), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  }
}

/** Dựng database của một kho từ rỗng rồi chạy kysely-codegen cho kho đó. */
async function generateStore(adminUrl, store) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${store.database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${store.database}"`);
  } finally {
    await admin.end();
  }

  const storeUrl = databaseUrl(adminUrl, store.database);
  const client = new Client({ connectionString: storeUrl });
  await client.connect();
  try {
    await applyCarrier(client, store.migrationsDir);
  } finally {
    await client.end();
  }

  const require = createRequire(import.meta.url);
  const codegenBin = join(dirname(require.resolve('kysely-codegen/package.json')), 'dist', 'cli', 'bin.js');
  const result = spawnSync(
    process.execPath,
    [codegenBin, '--config-file', store.configFile, '--url', storeUrl, '--out-file', store.outFile],
    { cwd: packageDir, stdio: 'inherit' },
  );
  if (result.status !== 0) {
    throw new Error(`kysely-codegen thất bại cho kho ${store.key} (mã thoát ${result.status}).`);
  }
  console.log(`db:types — đã sinh ${store.outFile} từ database ${store.database}.`);
}

const adminUrl = resolveAdminUrl();
for (const store of STORES) {
  await generateStore(adminUrl, store);
}
