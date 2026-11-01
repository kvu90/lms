/**
 * Hàm đọc nhật ký migration TƯƠNG THÍCH cho fleet/provision trong
 * cửa sổ hai bộ máy cùng tồn tại.
 *
 * Bài toán: fleet và provision đọc phiên bản thật của một database
 * từ nhật ký migration của chính nó. Trước chiến dịch chuyển ORM,
 * nhật ký đó là `drizzle.__drizzle_migrations`; sau khi một kho qua
 * bước cấy nhật ký (adoption), sự thật nằm ở `kysely_migration` của
 * bộ máy Kysely. Hàm ở đây đọc ĐÚNG MỘT nguồn theo luật:
 *
 * 1. `kysely_migration` tồn tại VÀ có ít nhất một dòng → đọc từ đó
 *    (kho đã qua adoption; nhật ký Drizzle từ đây chỉ còn là lịch
 *    sử, không được ghi thêm).
 * 2. Ngược lại (bảng chưa có, hoặc có nhưng rỗng — trạng thái lưng
 *    chừng khi bước cấy mới tạo bảng mà chưa chèn) → dự phòng đọc
 *    `drizzle.__drizzle_migrations` như hành vi cũ.
 * 3. Cả hai đều chưa có → database chưa từng được áp migration:
 *    tập đã áp là rỗng, phiên bản là `null` — cùng ngữ nghĩa với
 *    hàm đọc cũ phía fleet.
 *
 * Ngữ nghĩa "phiên bản mới nhất": phía Kysely không có cột thời
 * gian áp đáng tin cậy để sắp (mọi dòng cấy mang cùng một dấu thời
 * gian), nên phiên bản mới nhất là tên LỚN NHẤT theo thứ tự tên —
 * đúng vì tên migration mở đầu bằng dấu thời gian nên thứ tự tên
 * là thứ tự áp (kỷ luật đặt tên này là bất biến của bộ carrier và
 * của migration native về sau). Phía Drizzle giữ NGUYÊN truy vấn
 * cũ (theo `created_at`, hoà thì theo `id`) để hành vi trong cửa
 * sổ dự phòng không đổi một ly so với trước chiến dịch.
 *
 * Giao diện kết nối là tối thiểu có chủ đích: chỉ cần một hàm
 * `query(text)` trả `{ rows }` — đúng hình dạng của `pg.Client`
 * mà fleet/provision đang giữ, nên hai runner dùng thẳng hàm này
 * với client sẵn có, không phải dựng handle Kysely chỉ để đọc
 * nhật ký. Bản Kysely của cùng luật đọc nằm trong `adopt-journal`
 * (đường nội bộ của bước cấy), hai bản phải giữ cùng luật chọn
 * nguồn ở trên.
 */
import type { Client } from 'pg';

/** Mã lỗi PostgreSQL khi đối tượng (bảng/schema) chưa tồn tại. */
const MISSING_OBJECT_CODES = new Set(['42P01', '3F000']);

/** Kiểm tra một lỗi có phải "bảng chưa tồn tại" không (để phân biệt với lỗi thật). */
function isMissingObjectError(error: unknown): boolean {
  return error instanceof Object && MISSING_OBJECT_CODES.has((error as { code?: string }).code ?? '');
}

/** Hình dạng kết nối tối thiểu mà hàm đọc nhật ký cần — `pg.Client` thoả trực tiếp. */
export type MigrationJournalClient = Pick<Client, 'query'>;

/**
 * Đọc toàn tập tên trong `kysely_migration`.
 *
 * @returns Tập tên, hoặc `null` khi bảng chưa tồn tại.
 */
async function readKyselyNames(client: MigrationJournalClient): Promise<string[] | null> {
  try {
    const result = await client.query<{ name: string }>('SELECT name FROM kysely_migration');
    return result.rows.map((row) => row.name);
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

/**
 * Đọc toàn tập tên trong nhật ký Drizzle.
 *
 * @returns Tập tên, hoặc `null` khi bảng nhật ký chưa tồn tại (database chưa từng qua bộ máy Drizzle).
 */
async function readDrizzleNames(client: MigrationJournalClient): Promise<string[] | null> {
  try {
    const result = await client.query<{ name: string | null }>('SELECT name FROM drizzle.__drizzle_migrations');
    return result.rows.map((row) => row.name).filter((name): name is string => name !== null);
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

/**
 * Đọc toàn tập tên migration đã áp của một database theo luật chọn
 * nguồn ở đầu file: ưu tiên nhật ký Kysely khi đã có dòng, dự phòng
 * nhật ký Drizzle trong cửa sổ cùng tồn tại. Đây là hàm đọc tương
 * thích mà fleet/provision chạy qua — căn cứ để runner quyết định
 * một kho còn thiếu migration nào (chỉ nhìn migration mới nhất sẽ
 * bỏ sót kho thiếu một migration cũ ở giữa).
 */
export async function getAppliedMigrations(client: MigrationJournalClient): Promise<string[]> {
  const kyselyNames = await readKyselyNames(client);
  if (kyselyNames !== null && kyselyNames.length > 0) return kyselyNames;
  const drizzleNames = await readDrizzleNames(client);
  return drizzleNames ?? [];
}

/**
 * Đọc phiên bản schema hiện tại của một database (tên migration đã
 * áp gần nhất) theo cùng luật chọn nguồn: kho đã qua adoption thì
 * lấy tên lớn nhất trong `kysely_migration`; chưa qua thì giữ
 * nguyên truy vấn cũ trên nhật ký Drizzle. Database chưa từng được
 * áp migration thì trả `null`.
 */
export async function getLatestAppliedMigration(client: MigrationJournalClient): Promise<string | null> {
  const kyselyNames = await readKyselyNames(client);
  if (kyselyNames !== null && kyselyNames.length > 0) {
    return [...kyselyNames].sort().at(-1) ?? null;
  }
  try {
    const result = await client.query<{ name: string | null }>(
      'SELECT name FROM drizzle.__drizzle_migrations ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1',
    );
    return result.rows[0]?.name ?? null;
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}
