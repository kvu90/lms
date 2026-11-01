/**
 * Hậu kiểm số đếm sau migrate — lưới an toàn thay cho việc tin mã
 * thoát hay dòng log "thành công" (bài học của hệ: một runner chạy
 * sai thư mục làm việc từng in thành công và thoát 0 trong khi
 * không áp gì).
 *
 * Số đếm đọc thẳng từ database đích:
 * - Bảng: số bảng thật (`relkind = 'r'`) trong schema `public`,
 *   TRỪ hai bảng nhật ký của Migrator (`kysely_migration`,
 *   `kysely_migration_lock`) — hai bảng này là sổ sách của bộ máy,
 *   không phải bảng nghiệp vụ, và không có mặt trong số đếm của
 *   đường Drizzle cũ nên phải loại ra thì đối chiếu mới khớp.
 * - Policy RLS: đếm trong schema `public`, cũng loại đối tượng
 *   thuộc hai bảng nhật ký; chỉ kiểm khi kho có kỳ vọng (kho
 *   trung tâm — hai kho còn lại nghiệm thu chỉ cần số bảng và số
 *   dòng nhật ký).
 * - Index: đếm trên CÙNG cơ số đo với mốc kỳ vọng của phương án —
 *   chỉ các index KHÔNG đỡ ràng buộc (không phải index sinh tự
 *   động cho PRIMARY KEY/UNIQUE): mốc 416 của kho trung tâm đo
 *   trên cơ số này (tổng index trong `pg_indexes` là 732 vì cộng
 *   316 index đỡ ràng buộc; các index đỡ ràng buộc sinh tất định
 *   theo bảng/ràng buộc nên được kiểm gián tiếp qua số bảng và đối
 *   chiếu schema, đếm tách ở đây chỉ làm nhiễu cổng).
 * - Dòng nhật ký: số dòng trong `kysely_migration` — bằng đúng số
 *   migration carrier của kho sau migrate-từ-rỗng (migration native
 *   về sau làm số này tăng, nên hậu kiểm này chỉ có ý nghĩa so với
 *   bộ carrier hiện hành tại thời điểm chạy).
 */
import { sql, type Kysely } from 'kysely';
import { MIGRATION_STORES, type MigrationStoreKey } from './stores';

/** Kết quả hậu kiểm một kho. */
export interface VerifyResult {
  /** Kho vừa kiểm. */
  store: MigrationStoreKey;
  /** Số bảng nghiệp vụ đếm được. */
  tables: number;
  /** Số policy RLS đếm được (chỉ kho trung tâm mới đếm; kho khác là `null`). */
  policies: number | null;
  /** Số index đếm được (chỉ kho trung tâm mới đếm; kho khác là `null`). */
  indexes: number | null;
  /** Số dòng trong `kysely_migration`. */
  journalRows: number;
  /** Đạt khi mọi số đếm có kỳ vọng đều khớp. */
  ok: boolean;
  /** Các điểm lệch (rỗng khi đạt) — in nguyên văn ra log để chẩn đoán. */
  mismatches: string[];
}

/** Đếm một giá trị nguyên duy nhất từ một câu SQL. */
async function countOne(db: Kysely<any>, query: string): Promise<number> {
  const { rows } = await sql.raw(query).execute(db) as { rows: Array<{ count: string }> };
  return Number(rows[0]?.count ?? 0);
}

/**
 * Hậu kiểm số đếm của một kho sau migrate.
 *
 * @param db - Handle Kysely trỏ tới database đích.
 * @param store - Kho cần kiểm.
 * @returns Kết quả đếm + cờ đạt; bên gọi (runner) thoát 1 khi `ok`
 *   là false — hàm này không tự thoát tiến trình để spec có thể
 *   kiểm kết quả trực tiếp.
 */
export async function verifyStore(db: Kysely<any>, store: MigrationStoreKey): Promise<VerifyResult> {
  const expected = MIGRATION_STORES[store].expected;
  const tables = await countOne(
    db,
    `select count(*)::text as count from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind = 'r' and c.relname not in ('kysely_migration', 'kysely_migration_lock')`,
  );
  const policies =
    expected.policies === undefined
      ? null
      : await countOne(
          db,
          `select count(*)::text as count from pg_policies where schemaname = 'public' and tablename not in ('kysely_migration', 'kysely_migration_lock')`,
        );
  const indexes =
    expected.indexes === undefined
      ? null
      : await countOne(
          db,
          `select count(*)::text as count from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_namespace ns on ns.oid = ic.relnamespace join pg_class tc on tc.oid = i.indrelid where ns.nspname = 'public' and tc.relname not in ('kysely_migration', 'kysely_migration_lock') and not exists (select 1 from pg_constraint con where con.conindid = i.indexrelid)`,
        );
  const journalRows = await countOne(db, `select count(*)::text as count from kysely_migration`);
  const mismatches: string[] = [];
  if (tables !== expected.tables) mismatches.push(`bảng: đếm được ${tables}, kỳ vọng ${expected.tables}`);
  if (policies !== null && policies !== expected.policies) {
    mismatches.push(`policy RLS: đếm được ${policies}, kỳ vọng ${expected.policies}`);
  }
  if (indexes !== null && indexes !== expected.indexes) {
    mismatches.push(`index: đếm được ${indexes}, kỳ vọng ${expected.indexes}`);
  }
  if (journalRows !== expected.journalRows) {
    mismatches.push(`dòng kysely_migration: đếm được ${journalRows}, kỳ vọng ${expected.journalRows}`);
  }
  return { store, tables, policies, indexes, journalRows, ok: mismatches.length === 0, mismatches };
}
