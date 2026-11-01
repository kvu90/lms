/**
 * Harness dựng database test từ rỗng cho `@lms/db` (điểm vào
 * test-support, chỉ dùng trong test — không phải mã chạy production).
 *
 * Từ hạng mục nền thứ hai (issue #639), harness dựng database bằng
 * CHÍNH bộ máy migration của package (Migrator + provider đọc
 * carrier đóng băng), thay vì replay SQL thủ công như trước: cùng
 * một bộ máy, cùng bước tiền-migration shim `uuidv7()` cho cụm
 * dưới PG18, cùng thứ tự áp — nên database test luôn khớp hình
 * dạng mà runner production tạo ra, kể cả bảng nhật ký
 * `kysely_migration` mà Migrator ghi.
 *
 *   1. Xoá (nếu có) và tạo mới database theo tên được chỉ định qua
 *      kết nối quản trị.
 *   2. Cụm PostgreSQL dưới 18: cài shim `uuidv7()` viết tay TRƯỚC
 *      carrier (PG18 có hàm tích hợp). Shim nằm ngoài carrier —
 *      nội dung carrier giữ nguyên từng byte.
 *   3. Áp bộ carrier của kho bằng Migrator của package (kèm bước
 *      cấy nhật ký — trên database trống thì bước này là no-op vì
 *      chưa có nhật ký Drizzle để cấy).
 *
 * Đường dẫn carrier trỏ vào `packages/db/migrations/<kho>` — vị trí
 * của bộ SQL sau khi dời khỏi `apps/api/drizzle*` ở hạng mục nền
 * thứ hai.
 */
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { Migrator } from 'kysely/migration';
import { createCentreKysely, createControlPlaneKysely, createSystemBankKysely } from '../client';
import { adoptJournal } from '../migrate/adopt-journal';
import { FrozenSqlProvider, listCarrierNames } from '../migrate/frozen-sql-provider';
import { installUuidv7Shim } from '../migrate/stores';
import type { Kysely } from 'kysely';

/** Ba kho có thể dựng bằng harness này, khớp ba factory trong `client.ts`. */
export type TestStoreKind = 'centre' | 'control-plane' | 'system-bank';

/**
 * Gốc của package `packages/db`, suy từ vị trí file này: đúng cho cả
 * khi chạy từ `src/test-support` (Vitest trong package) lẫn từ
 * `dist/test-support` (app import bản đã build) vì hai vị trí sâu
 * bằng nhau so với gốc package.
 */
function packageRoot(): string {
  return join(__dirname, '..', '..');
}

/** Thư mục carrier của từng kho, tính từ gốc package. */
function migrationsDirFor(store: TestStoreKind): string {
  return join(packageRoot(), 'migrations', store);
}

/** Factory Kysely của kho tương ứng trên một pool. */
function createStoreKysely(store: TestStoreKind, pool: Pool): Kysely<any> {
  switch (store) {
    case 'centre':
      return createCentreKysely(pool);
    case 'control-plane':
      return createControlPlaneKysely(pool);
    case 'system-bank':
      return createSystemBankKysely(pool);
  }
}

/** Thay tên database trong một connection string, giữ nguyên phần còn lại. */
export function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * Áp carrier của một kho vào database đã tạo bằng bộ máy migration
 * của package: cài shim `uuidv7()` trước nếu cụm dưới PG18, cấy
 * nhật ký (no-op trên database trống), rồi `migrateToLatest()`.
 * Lỗi migrate (Kysely không ném mà trả `{ error, results }`) được
 * chuyển thành ngoại lệ rõ ràng — harness im lặng bỏ qua lỗi áp
 * là database test thiếu bảng mà spec không biết.
 */
async function applyCarrier(storeUrl: string, store: TestStoreKind): Promise<void> {
  const pool = new Pool({ connectionString: storeUrl });
  const db = createStoreKysely(store, pool);
  try {
    await installUuidv7Shim(db);
    await adoptJournal(db, listCarrierNames(migrationsDirFor(store)));
    const migrator = new Migrator({ db, provider: new FrozenSqlProvider(migrationsDirFor(store)) });
    const { error, results } = await migrator.migrateToLatest();
    if (error || (results ?? []).some((result) => result.status === 'Error')) {
      throw new Error(
        `Harness không áp được carrier của kho ${store}: ${error ? (error as Error).message ?? String(error) : 'có migration báo Error'}`,
      );
    }
  } finally {
    await db.destroy().catch(() => undefined);
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
  await applyCarrier(storeUrl, options.store);
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
