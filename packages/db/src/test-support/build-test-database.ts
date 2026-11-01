/**
 * Harness dựng database test từ rỗng cho `@lms/db` (điểm vào
 * test-support, chỉ dùng trong test — không phải mã chạy production).
 *
 * Vì sao dựng từ SQL mang dữ liệu (carrier) thay vì qua Migrator của
 * Kysely: bộ máy migration native của Kysely (Migrator +
 * FileMigrationProvider + cầu nối lịch sử) thuộc hạng mục nền tiếp
 * theo của chiến dịch chuyển ORM; tới khi bộ máy đó có mặt, harness
 * này áp đúng bộ SQL đang mang dữ liệu hiện hành của từng kho —
 * cùng cách các spec phía `apps/api` vẫn replay `migration.sql` —
 * để DB test luôn khớp hình dạng production:
 *
 *   1. Xoá (nếu có) và tạo mới database theo tên được chỉ định qua
 *      kết nối quản trị.
 *   2. Cụm PostgreSQL dưới 18: cài shim `uuidv7()` viết tay TRƯỚC
 *      carrier (PG18 có hàm tích hợp). Shim nằm ngoài carrier —
 *      nội dung carrier giữ nguyên từng byte.
 *   3. Áp mọi thư mục migration của kho theo thứ tự tên, tách câu
 *      lệnh theo dấu `--> statement-breakpoint`.
 *
 * Đường dẫn carrier trỏ vào `apps/api/drizzle*` — vị trí hiện hành
 * của bộ SQL khi harness này ra đời; khi carrier dời vào
 * `packages/db/migrations` (hạng mục nền tiếp theo), hằng số đường
 * dẫn ở đây là điểm duy nhất phải sửa.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

/** Ba kho có thể dựng bằng harness này, khớp ba factory trong `client.ts`. */
export type TestStoreKind = 'centre' | 'control-plane' | 'system-bank';

/**
 * Hàm `uuidv7()` cho cụm PostgreSQL dưới 18 — trích nguyên văn hằng số
 * `UUIDV7_SHIM` trong `apps/api/src/modules/tenants/centre-provision.ts`
 * (mọi bản sao trong repo phải khớp từng byte với nguồn đó).
 */
const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/**
 * Gốc của package `packages/db`, suy từ vị trí file này: đúng cho cả
 * khi chạy từ `src/test-support` (Vitest trong package) lẫn từ
 * `dist/test-support` (app import bản đã build) vì hai vị trí sâu
 * bằng nhau so với gốc package.
 */
function packageRoot(): string {
  return join(__dirname, '..', '..');
}

/** Thư mục carrier hiện hành của từng kho, tính từ gốc repo. */
function migrationsDirFor(store: TestStoreKind): string {
  const apiDir = join(packageRoot(), '..', '..', 'apps', 'api');
  switch (store) {
    case 'centre':
      return join(apiDir, 'drizzle');
    case 'control-plane':
      return join(apiDir, 'drizzle-control-plane');
    case 'system-bank':
      return join(apiDir, 'drizzle-system-bank');
  }
}

/** Thay tên database trong một connection string, giữ nguyên phần còn lại. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Áp carrier của một kho vào database đã tạo: cài shim `uuidv7()`
 * trước nếu cụm dưới PG18, rồi chạy từng câu lệnh của mọi
 * `migration.sql` theo thứ tự tên thư mục.
 */
async function applyCarrier(client: Client, store: TestStoreKind): Promise<void> {
  const { rows } = await client.query<{ server_version_num: string }>('SHOW server_version_num');
  const major = Math.floor(Number(rows[0]?.server_version_num ?? '0') / 10000);
  if (major < 18) {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(UUIDV7_SHIM);
  }
  const migrationsDir = migrationsDirFor(store);
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

/** Tham số dựng một database test từ rỗng. */
export interface BuildTestDatabaseOptions {
  /** Connection string quản trị (tới database `postgres` của cụm đích). */
  adminUrl: string;
  /** Tên database test sẽ xoá-nếu-có rồi tạo mới. */
  database: string;
  /** Kho cần dựng — quyết định bộ carrier được áp. */
  store: TestStoreKind;
}

/**
 * Dựng database test của một kho từ rỗng và trả về connection string
 * trỏ thẳng tới database đó (giữ nguyên thông tin đăng nhập của
 * `adminUrl`).
 */
export async function buildTestDatabase(options: BuildTestDatabaseOptions): Promise<string> {
  const admin = new Client({ connectionString: options.adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${options.database}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${options.database}"`);
  } finally {
    await admin.end();
  }
  const storeUrl = withDatabase(options.adminUrl, options.database);
  const client = new Client({ connectionString: storeUrl });
  await client.connect();
  try {
    await applyCarrier(client, options.store);
  } finally {
    await client.end();
  }
  return storeUrl;
}

/** Xoá một database test đã dựng bằng `buildTestDatabase` (dọn dẹp sau test). */
export async function dropTestDatabase(adminUrl: string, database: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
