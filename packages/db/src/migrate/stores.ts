/**
 * Định nghĩa ba kho và bước tiền-migration dùng chung cho bộ máy
 * migration của `@lms/db` (runner `run.ts`, hậu kiểm `verify.ts`,
 * harness test dựng database từ rỗng).
 *
 * Ba kho có bộ carrier riêng (thư mục migration đóng băng trong
 * `packages/db/migrations/`), số đếm kỳ vọng riêng và biến môi
 * trường kết nối riêng — bảng này là nơi duy nhất ghi các giá trị
 * đó, để runner, hậu kiểm và harness không tự chế bản sao lệch
 * nhau. Số đếm kỳ vọng đo lại tại thời điểm thi công PR-N2 từ
 * database dựng bằng đường Drizzle (mốc phương án: trung tâm 202
 * bảng + 21 policy RLS + 416 index, control plane 6 bảng, ngân
 * hàng hệ thống 10 bảng).
 */
import { sql, type Kysely } from 'kysely';

/** Ba kho dữ liệu của hệ — khớp ba factory trong `client.ts`. */
export type MigrationStoreKey = 'centre' | 'control-plane' | 'system-bank';

/** Số đếm kỳ vọng của một kho sau khi migrator áp đủ bộ carrier. */
export interface ExpectedStoreCounts {
  /** Số bảng nghiệp vụ trong schema `public` (không tính hai bảng nhật ký của Migrator). */
  tables: number;
  /** Số policy RLS trong schema `public`; chỉ kiểm khi có giá trị (kho trung tâm). */
  policies?: number;
  /** Số index trong schema `public` (không tính index của hai bảng nhật ký); chỉ kiểm khi có giá trị. */
  indexes?: number;
  /** Số dòng trong `kysely_migration` sau khi áp đủ (bằng số migration carrier của kho). */
  journalRows: number;
}

/** Mô tả một kho cho bộ máy migration. */
export interface MigrationStore {
  /** Tên thư mục carrier của kho trong `packages/db/migrations/`. */
  migrationsDirName: string;
  /** Số đếm kỳ vọng sau migrate-từ-rỗng. */
  expected: ExpectedStoreCounts;
  /** Biến môi trường chứa URL kết nối của kho cho runner (theo thứ tự ưu tiên ghi trong `run.ts`). */
  connectionEnvVars: string[];
}

/** Bảng định nghĩa ba kho — nguồn sự thật duy nhất cho runner/hậu kiểm. */
export const MIGRATION_STORES: Record<MigrationStoreKey, MigrationStore> = {
  centre: {
    migrationsDirName: 'centre',
    expected: { tables: 202, policies: 21, indexes: 416, journalRows: 1 },
    connectionEnvVars: ['MIGRATION_DATABASE_URL', 'DATABASE_URL'],
  },
  'control-plane': {
    migrationsDirName: 'control-plane',
    expected: { tables: 6, journalRows: 2 },
    connectionEnvVars: ['CONTROL_PLANE_DATABASE_URL'],
  },
  'system-bank': {
    migrationsDirName: 'system-bank',
    expected: { tables: 10, journalRows: 1 },
    connectionEnvVars: ['SYSTEM_BANK_DATABASE_URL'],
  },
};

/** Các khoá kho hợp lệ — dùng để báo lỗi rõ khi CLI nhận tên kho lạ. */
export const MIGRATION_STORE_KEYS = Object.keys(MIGRATION_STORES) as MigrationStoreKey[];

/** Kiểm tra một chuỗi có phải khoá kho hợp lệ không (tránh lỗi gõ tên kho thành lỗi kết nối khó hiểu). */
export function isMigrationStoreKey(value: string): value is MigrationStoreKey {
  return (Object.keys(MIGRATION_STORES) as string[]).includes(value);
}

/**
 * Hàm `uuidv7()` cho cụm PostgreSQL dưới 18 — trích nguyên văn hằng
 * số `UUIDV7_SHIM` trong
 * `apps/api/src/modules/tenants/centre-provision.ts` (nguồn duy nhất
 * của chuỗi này trong repo; mọi bản sao khác phải khớp từng byte
 * với nguồn đó — kiểm chứng bằng đối chiếu chuỗi trong spec của
 * bộ máy migration).
 *
 * Shim này chỉ cài ở bước tiền-migration, NGOÀI nội dung carrier:
 * nó không sửa byte/hash của file carrier, không ghi vào
 * `kysely_migration` và không tham gia bước cấy nhật ký.
 */
export const UUIDV7_SHIM = `CREATE OR REPLACE FUNCTION uuidv7() RETURNS uuid AS $$ DECLARE ts_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; b bytea; BEGIN b := decode(lpad(to_hex(ts_ms), 12, '0'), 'hex') || gen_random_bytes(10); b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112); b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128); RETURN encode(b, 'hex')::uuid; END; $$ LANGUAGE plpgsql VOLATILE`;

/**
 * Bước tiền-migration cho mọi đường dựng database từ rỗng bằng
 * migrator của package (U3): đọc phiên bản server thật của cụm
 * đích rồi quyết định theo đúng khuôn production hiện hành —
 * cụm dưới PostgreSQL 18 cài `pgcrypto` + shim `uuidv7()` viết
 * tay (vì các mặc định `DEFAULT uuidv7()` trong carrier cần hàm
 * này mà PG dưới 18 chưa có sẵn); cụm từ 18 trở lên có hàm tích
 * hợp nên bỏ qua hoàn toàn, không chạm gì thêm vào database.
 *
 * @param db - Handle Kysely trỏ tới database đích (đã tạo nhưng
 *   chưa áp migration nào).
 * @returns `'installed'` khi đã cài shim, `'skipped-pg18'` khi cụm
 *   từ 18 trở lên và bước này không làm gì.
 */
export async function installUuidv7Shim(db: Kysely<any>): Promise<'installed' | 'skipped-pg18'> {
  const { rows } = await sql<{ server_version_num: string }>`SHOW server_version_num`.execute(db);
  const major = Math.floor(Number(rows[0]?.server_version_num ?? '0') / 10000);
  if (major >= 18) return 'skipped-pg18';
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db);
  await sql.raw(UUIDV7_SHIM).execute(db);
  return 'installed';
}
