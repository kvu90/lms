/**
 * Hàm đọc nhật ký migration cho fleet/provision.
 *
 * Bài toán: fleet và provision đọc phiên bản thật của một database
 * từ nhật ký migration của chính nó. Nguồn sự thật duy nhất là
 * bảng `kysely_migration` do bộ máy migration của package ghi:
 *
 * - Bảng chưa tồn tại → database chưa từng được áp migration bằng
 *   bộ máy này: tập đã áp là rỗng, phiên bản là `null`.
 * - Bảng có dòng → tập đã áp là toàn bộ tên trong bảng.
 *
 * Ngữ nghĩa "phiên bản mới nhất": phía Kysely không có cột thời
 * gian áp đáng tin cậy để sắp (mọi dòng cấy mang cùng một dấu thời
 * gian), nên phiên bản mới nhất là tên LỚN NHẤT theo thứ tự tên —
 * đúng vì tên migration mở đầu bằng dấu thời gian nên thứ tự tên
 * là thứ tự áp (kỷ luật đặt tên này là bất biến của bộ carrier và
 * của migration native về sau).
 *
 * Lịch sử: trong cửa sổ chuyển đổi ORM (các PR trước của chiến
 * dịch db → Kysely), hàm này còn đọc dự phòng nhật ký của bộ máy
 * cũ và package còn bước cấy nhật ký (adoption) chép tên từ nhật
 * ký cũ sang `kysely_migration`. Cửa sổ đó đóng ở issue #663: mọi
 * kho sống đều đã qua adoption (bằng chứng: migration native đầu
 * tiên của kho control plane chỉ áp được sau adoption), nên đường
 * đọc dự phòng và bước cấy đã gỡ hẳn. Bảng nhật ký cũ TRONG các
 * database vẫn giữ nguyên (không xoá dữ kiện), chỉ không còn code
 * nào đọc nó. Hệ quả có chủ đích: một database giả định chưa từng
 * qua adoption mà đã có bảng nghiệp vụ sẽ hỏng to tiếng ở bước áp
 * carrier thay vì được cấy lặng lẽ.
 *
 * Giao diện kết nối là tối thiểu có chủ đích: chỉ cần một hàm
 * `query(text)` trả `{ rows }` — đúng hình dạng của `pg.Client`
 * mà fleet/provision đang giữ, nên hai runner dùng thẳng hàm này
 * với client sẵn có, không phải dựng handle Kysely chỉ để đọc
 * nhật ký.
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
 * Đọc toàn tập tên migration đã áp của một database từ nhật ký
 * `kysely_migration` của chính nó. Đây là căn cứ để fleet/provision
 * quyết định một kho còn thiếu migration nào (chỉ nhìn migration
 * mới nhất sẽ bỏ sót kho thiếu một migration cũ ở giữa). Database
 * chưa có bảng nhật ký thì tập đã áp là rỗng.
 */
export async function getAppliedMigrations(client: MigrationJournalClient): Promise<string[]> {
  const kyselyNames = await readKyselyNames(client);
  return kyselyNames ?? [];
}

/**
 * Đọc phiên bản schema hiện tại của một database (tên migration đã
 * áp gần nhất): tên lớn nhất trong `kysely_migration`. Database
 * chưa từng được áp migration (chưa có bảng nhật ký, hoặc bảng
 * rỗng) thì trả `null`.
 */
export async function getLatestAppliedMigration(client: MigrationJournalClient): Promise<string | null> {
  const kyselyNames = await readKyselyNames(client);
  if (kyselyNames === null || kyselyNames.length === 0) return null;
  return [...kyselyNames].sort().at(-1) ?? null;
}
