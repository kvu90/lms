/**
 * CLI mỏng chạy migration cho một kho (`run.js <kho>` sau khi build
 * package — chuỗi service `migrate` của compose và script `db:*`
 * của apps/api gọi đúng điểm vào này).
 *
 * Một lượt migrate làm đúng 4 việc, theo thứ tự:
 * 1. Phân giải thư mục migration qua điểm vào chính của package
 *    (`require.resolve('@lms/db')` — đường dẫn TUYỆT ĐỐI, diệt lớp
 *    lỗi "sai thư mục làm việc báo thành công giả": runner không
 *    bao giờ suy thư mục từ cwd).
 * 2. Bước tiền-migration shim `uuidv7()` cho cụm dưới PostgreSQL 18
 *    (ngoài nội dung carrier, không ghi nhật ký).
 * 3. Cấy nhật ký (adoption) cho database đang sống, rồi
 *    `migrateToLatest()`. Kysely KHÔNG BAO GIỜ ném lỗi từ
 *    `migrateToLatest()` — kết quả trả về `{ error, results }` nên
 *    runner PHẢI tự kiểm: `error` khác rỗng hoặc bất kỳ
 *    `results[].status === 'Error'` thì thoát 1 (runner không tự
 *    kiểm là mất cổng).
 * 4. Hậu kiểm số đếm (`verify.ts`) trên database đích; lệch thì
 *    thoát 1 dù migrate báo thành công.
 *
 * Cờ `--verify-only`: chỉ làm việc 4 (đọc số đếm, không cấy, không
 * áp migration) — đường kiểm chứng sau deploy mà runbook dùng.
 *
 * URL kết nối theo kho (mỗi kho một biến, khớp cấu hình Drizzle cũ
 * mà chuỗi migrate đang dùng): kho trung tâm ưu tiên
 * `MIGRATION_DATABASE_URL` rồi `DATABASE_URL`; control plane dùng
 * `CONTROL_PLANE_DATABASE_URL`; ngân hàng hệ thống dùng
 * `SYSTEM_BANK_DATABASE_URL`. Khi `DATABASE_SSL=true`, kết nối đi
 * qua TLS với `rejectUnauthorized: false` (đúng cách đường chạy của
 * API xử lý URL khi nhà cung cấp bắt TLS) thay vì gắn `sslmode`
 * vào chuỗi kết nối.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Kysely } from 'kysely';
import { Pool, type PoolConfig } from 'pg';
import { Migrator } from 'kysely/migration';
import {
  createCentreKysely,
  createControlPlaneKysely,
  createSystemBankKysely,
  type CentreDb,
  type ControlPlaneDb,
  type SystemBankDb,
} from '../client';
import { adoptJournal } from './adopt-journal';
import { FrozenSqlProvider, listCarrierNames } from './frozen-sql-provider';
import { installUuidv7Shim, isMigrationStoreKey, MIGRATION_STORES, type MigrationStoreKey } from './stores';
import { verifyStore } from './verify';

/** Gốc package `@lms/db`: phân giải qua chính package (không qua cwd). */
function packageRoot(): string {
  try {
    const require = createRequire(__filename);
    // Phân giải qua điểm vào chính của package (`exports["."]` →
    // `dist/index.js`) rồi đi lên một cấp: `exports` map của package
    // không khai `./package.json` nên phân giải thẳng
    // `@lms/db/package.json` bị Node từ chối
    // (ERR_PACKAGE_PATH_NOT_EXPORTED — đã kiểm chứng tại thời điểm
    // thi công); điểm vào chính cho cùng kết quả tuyệt đối.
    return join(dirname(require.resolve('@lms/db')), '..');
  } catch {
    // Dự phòng khi chạy từ source chưa qua workspace link: vị trí
    // file này sâu đúng hai cấp dưới gốc package ở cả `src/` và
    // `dist/` (cùng độ sâu), nên suy từ `__dirname` vẫn đúng.
    return join(__dirname, '..', '..');
  }
}

/** Cấu hình pool cho một kho từ biến môi trường (lỗi rõ khi thiếu biến). */
function poolConfigFor(store: MigrationStoreKey): PoolConfig {
  const envVars = MIGRATION_STORES[store].connectionEnvVars;
  const url = envVars.map((name) => process.env[name]).find((value) => value) ?? '';
  if (!url) {
    throw new Error(
      `Thiếu URL kết nối cho kho ${store}: đặt một trong các biến ${envVars.join(', ')} trước khi chạy migrate.`,
    );
  }
  if (process.env.DATABASE_SSL === 'true') {
    // Bỏ tham số sslmode trong URL (pg không hiểu `no-verify`) rồi
    // bật TLS ở cấp Pool — khớp cách API xử lý khi DATABASE_SSL=true.
    const parsed = new URL(url);
    parsed.searchParams.delete('sslmode');
    return { connectionString: parsed.toString(), ssl: { rejectUnauthorized: false } };
  }
  return { connectionString: url };
}

/** Dựng handle Kysely của kho trên pool đã cấp (đúng factory của package). */
function createStoreKysely(store: MigrationStoreKey, pool: Pool): Kysely<any> {
  switch (store) {
    case 'centre':
      return createCentreKysely(pool) as CentreDb as Kysely<any>;
    case 'control-plane':
      return createControlPlaneKysely(pool) as ControlPlaneDb as Kysely<any>;
    case 'system-bank':
      return createSystemBankKysely(pool) as SystemBankDb as Kysely<any>;
  }
}

/** In hướng dẫn dùng rồi trả mã thoát cho lỗi tham số (không ném stack dài cho lỗi gõ lệnh). */
function usage(): number {
  console.error(
    `Cách dùng: node dist/migrate/run.js <kho> [--verify-only]\nKho: centre | control-plane | system-bank\n--verify-only: chỉ hậu kiểm số đếm, không cấy nhật ký, không áp migration.`,
  );
  return 1;
}

async function main(argv: string[]): Promise<number> {
  const [storeArg, ...flags] = argv;
  if (!storeArg || !isMigrationStoreKey(storeArg)) return usage();
  const verifyOnly = flags.includes('--verify-only');
  const unknownFlags = flags.filter((flag) => flag !== '--verify-only');
  if (unknownFlags.length > 0) {
    console.error(`Cờ lạ: ${unknownFlags.join(', ')}`);
    return usage();
  }
  const store = storeArg as MigrationStoreKey;
  const migrationsDir = join(packageRoot(), 'migrations', MIGRATION_STORES[store].migrationsDirName);
  const pool = new Pool(poolConfigFor(store));
  const db = createStoreKysely(store, pool);
  try {
    if (verifyOnly) {
      const result = await verifyStore(db, store);
      console.log(
        `verify ${store}: bảng=${result.tables} policy=${result.policies ?? '-'} index=${result.indexes ?? '-'} kysely_migration=${result.journalRows}`,
      );
      if (!result.ok) {
        console.error(`verify ${store} LỆCH: ${result.mismatches.join('; ')}`);
        return 1;
      }
      return 0;
    }
    const shim = await installUuidv7Shim(db);
    console.log(`tiền-migration ${store}: shim uuidv7 ${shim === 'installed' ? 'đã cài (cụm dưới PG18)' : 'bỏ qua (cụm PG18+)'}`);
    const carrierNames = listCarrierNames(migrationsDir);
    const adoption = await adoptJournal(db, carrierNames);
    console.log(`adoption ${store}: ${adoption}`);
    const migrator = new Migrator({ db, provider: new FrozenSqlProvider(migrationsDir) });
    const { error, results } = await migrator.migrateToLatest();
    for (const result of results ?? []) {
      console.log(`migration ${result.migrationName}: ${result.status}`);
    }
    if (error || (results ?? []).some((result) => result.status === 'Error')) {
      console.error(`migrate ${store} THẤT BẠI: ${error ? (error as Error).message ?? String(error) : 'có migration báo Error'}`);
      return 1;
    }
    const verified = await verifyStore(db, store);
    console.log(
      `verify ${store}: bảng=${verified.tables} policy=${verified.policies ?? '-'} index=${verified.indexes ?? '-'} kysely_migration=${verified.journalRows}`,
    );
    if (!verified.ok) {
      console.error(`verify ${store} LỆCH: ${verified.mismatches.join('; ')}`);
      return 1;
    }
    return 0;
  } finally {
    // `destroy()` của Kysely đóng luôn pool đã truyền vào (hành vi
    // của PostgresDialect) nên chỉ cần huỷ instance, không đóng
    // pool riêng thêm lần nữa.
    await db.destroy().catch(() => undefined);
  }
}

// Điểm vào CLI: chỉ chạy khi file được gọi trực tiếp (không chạy
// khi module bị import từ spec — spec import các hàm qua module
// khác, không import file này).
if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}

// Xuất cho spec tích hợp dùng lại logic phân giải (không chạy main khi import).
export { packageRoot, poolConfigFor };
