/**
 * Bước cấy nhật ký (adoption) cho database đang sống. (Hàm đọc
 * tương thích cho fleet/provision nằm ở `journal.ts` cùng thư mục.)
 *
 * Bài toán: database đang chạy production đã được áp bộ carrier
 * bằng bộ máy Drizzle — nhật ký của nó nằm ở bảng
 * `drizzle.__drizzle_migrations`, còn bộ máy Kysely chỉ nhìn bảng
 * `kysely_migration` của nó. Nếu để Migrator chạy thẳng, nó sẽ áp
 * lại toàn bộ carrier lên database đang sống (bảng đã tồn tại →
 * lỗi, hoặc tệ hơn là ghi đè). Bước này cấy đúng tập tên đã áp vào
 * `kysely_migration` TRƯỚC khi `migrateToLatest()` chạy, để lượt
 * migrate đầu tiên trên database đang sống là no-op về mặt SQL
 * nghiệp vụ: không một câu nào của carrier được thực thi lại.
 *
 * Luật cấy (idempotent, chỉ đọc nhật ký Drizzle, không bao giờ ghi
 * vào nó):
 * 1. `kysely_migration` đã có dòng: đối sánh — mọi tên carrier đều
 *    phải đã có mặt (tập carrier là tập con của tập đã ghi; tên
 *    thừa là migration native áp sau lần cấy đầu, được phép vì
 *    runner này còn chạy cho mọi lượt migrate về sau, kể cả khi
 *    kho đã có migration native). Thiếu carrier → DỪNG lớn tiếng
 *    (lịch sử không khớp, cấy tiếp là ghi sai sự thật). Khớp →
 *    bỏ qua, không chạm gì.
 * 2. `kysely_migration` chưa có dòng: đọc toàn tập tên từ nhật ký
 *    Drizzle. Tên lạ (không thuộc bộ carrier) → DỪNG, không cấy.
 *    Tập Drizzle phải là tiền tố đúng của bộ carrier theo thứ tự
 *    tên (database đã áp migration thứ hai mà chưa áp migration
 *    đầu là lịch sử hỏng, không cấy). Đủ điều kiện thì chèn toàn
 *    tập đó vào `kysely_migration` với cùng một dấu thời gian.
 * 3. Không có nhật ký Drizzle (bảng chưa tồn tại): database trống
 *    — không cấy gì, `migrateToLatest()` sẽ áp đủ carrier từ đầu.
 *
 * Bảng `kysely_migration`/`kysely_migration_lock` giữ tên mặc định
 * của Kysely (đổi tên giữa chừng là chạy lại từ đầu, theo cảnh báo
 * của chính tài liệu Migrator).
 */
import { sql, type Kysely } from 'kysely';

/** Mã lỗi PostgreSQL khi đối tượng (bảng/schema) chưa tồn tại. */
const MISSING_OBJECT_CODES = new Set(['42P01', '3F000']);

/** Kiểm tra một lỗi có phải "bảng chưa tồn tại" không (để phân biệt với lỗi thật). */
function isMissingObjectError(error: unknown): boolean {
  return error instanceof Object && MISSING_OBJECT_CODES.has((error as { code?: string }).code ?? '');
}

/** Tạo bảng `kysely_migration` nếu chưa có — đúng DDL mà Migrator tự tạo (tên + timestamp dạng chuỗi ISO). */
async function ensureKyselyMigrationTable(db: Kysely<any>): Promise<void> {
  await sql.raw(
    'CREATE TABLE IF NOT EXISTS kysely_migration (name varchar(255) PRIMARY KEY, timestamp varchar(255) NOT NULL)',
  ).execute(db);
}

/** Đọc toàn tập tên đã ghi trong `kysely_migration` (bảng chưa có thì coi là rỗng). */
async function readKyselyNames(db: Kysely<any>): Promise<string[]> {
  try {
    const { rows } = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
    return rows.map((row) => row.name);
  } catch (error) {
    if (isMissingObjectError(error)) return [];
    throw error;
  }
}

/**
 * Đọc toàn tập tên trong nhật ký Drizzle.
 *
 * @returns Tập tên, hoặc `null` khi bảng nhật ký chưa tồn tại (database chưa từng qua bộ máy Drizzle).
 */
async function readDrizzleNames(db: Kysely<any>): Promise<string[] | null> {
  try {
    const { rows } = await sql<{ name: string }>`select name from drizzle.__drizzle_migrations`.execute(db);
    return rows.map((row) => row.name);
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

/**
 * Cấy nhật ký cho một kho theo luật ở đầu file.
 *
 * @param db - Handle Kysely trỏ tới database đích.
 * @param carrierNames - Tên các migration carrier của kho theo thứ
 *   tự áp (đã sắp theo tên); hàm tự sắp lại để thứ tự đầu vào
 *   không ảnh hưởng kiểm tra tiền tố.
 * @returns `'adopted'` khi vừa cấy, `'already-adopted'` khi nhật ký
 *   Kysely đã khớp nên không làm gì, `'fresh'` khi database trống
 *   (không có nhật ký Drizzle để cấy).
 * @throws Error khi lịch sử không khớp (thiếu carrier trong nhật ký
 *   Kysely, tên lạ trong nhật ký Drizzle, hoặc tập Drizzle không
 *   phải tiền tố của bộ carrier) — bên gọi phải dừng lượt migrate,
 *   không được bỏ qua lỗi này mà chạy tiếp.
 */
export async function adoptJournal(
  db: Kysely<any>,
  carrierNames: string[],
): Promise<'adopted' | 'already-adopted' | 'fresh'> {
  const carriers = [...carrierNames].sort();
  const carrierSet = new Set(carriers);
  await ensureKyselyMigrationTable(db);
  const kyselyNames = await readKyselyNames(db);
  if (kyselyNames.length > 0) {
    const missing = carriers.filter((name) => !kyselyNames.includes(name));
    if (missing.length > 0) {
      throw new Error(
        `Không cấy nhật ký: kysely_migration đã có dòng nhưng thiếu các carrier ${missing.join(', ')} — lịch sử migration không khớp, dừng để không ghi sai sự thật.`,
      );
    }
    return 'already-adopted';
  }
  const drizzleNames = await readDrizzleNames(db);
  if (drizzleNames === null || drizzleNames.length === 0) return 'fresh';
  const unknown = drizzleNames.filter((name) => !carrierSet.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `Không cấy nhật ký: nhật ký Drizzle chứa tên lạ ${unknown.join(', ')} không thuộc bộ carrier — dừng, không cấy.`,
    );
  }
  const expectedPrefix = carriers.slice(0, drizzleNames.length);
  const prefixMatches =
    expectedPrefix.length === drizzleNames.length &&
    expectedPrefix.every((name) => drizzleNames.includes(name));
  if (!prefixMatches) {
    throw new Error(
      `Không cấy nhật ký: tập tên trong nhật ký Drizzle (${drizzleNames.join(', ')}) không phải tiền tố của bộ carrier (${carriers.join(', ')}) — lịch sử áp không theo thứ tự, dừng.`,
    );
  }
  const timestamp = new Date().toISOString();
  await db
    .insertInto('kysely_migration' as never)
    .values(drizzleNames.map((name) => ({ name, timestamp })) as never)
    .execute();
  return 'adopted';
}

/**
 * Ghi chú về hàm đọc tương thích cho fleet/provision: hàm đó là
 * `getAppliedMigrations`/`getLatestAppliedMigration` trong
 * `journal.ts` của cùng thư mục — bản đọc qua `pg.Client` với CÙNG
 * luật chọn nguồn như hai hàm đọc nội bộ ở trên (ưu tiên nhật ký
 * Kysely khi đã có dòng, dự phòng nhật ký Drizzle). File này chỉ
 * giữ phần GHI (cấy nhật ký) phía Kysely; hai luật đọc phải khớp
 * nhau, sửa một nơi thì sửa cả hai.
 */
