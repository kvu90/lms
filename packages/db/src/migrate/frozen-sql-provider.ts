/**
 * `MigrationProvider` tự viết cho bộ máy migration của `@lms/db`:
 * đọc các file SQL trong `packages/db/migrations/<kho>/` và biến
 * mỗi thư mục migration thành một migration Kysely. Thư mục của
 * một kho chứa hai loại migration cùng khuôn file `migration.sql`:
 * carrier đóng băng (migration thời bộ máy cũ, giữ nguyên từng byte)
 * và migration native (viết tay sau chiến dịch chuyển ORM). Provider
 * liệt kê và áp CẢ HAI loại; diện nào là carrier do danh sách đóng
 * băng trong `stores.ts` (`MigrationStore.carrierNames`) quyết
 * định — chỉ bước cấy nhật ký mới cần phân biệt, tuyệt đối không
 * suy diện carrier từ danh sách thư mục (issue #689).
 *
 * Vì sao tự viết thay vì `FileMigrationProvider` có sẵn: provider
 * có sẵn đọc file `.ts` chứa mã migration; migration của hệ là file
 * `.sql`, phải được thực thi đúng như SQL gốc — không dịch lại,
 * không sinh lại, không bọc thành chuỗi trong file `.ts`.
 *
 * Kỷ luật migration (giữ nguyên từ thời bộ máy cũ):
 * - Tên migration = tên thư mục (mở đầu bằng dấu thời gian) — tên
 *   này là khoá danh tính mà fleet/provision và sổ đăng ký đối
 *   chiếu, nên provider liệt kê thư mục theo thứ tự tên tăng dần
 *   (đúng thứ tự áp của bộ máy cũ) và Migrator tự sắp lại theo
 *   tên trước khi chạy.
 * - Nội dung `up()`: đọc file, tách theo dấu
 *   `--> statement-breakpoint`, thực thi tuần tự từng câu bằng
 *   `sql.raw(...).execute(db)` trong transaction của chính
 *   migration đó (Migrator của Kysely bọc mỗi lượt migrate trong
 *   một transaction khi dialect hỗ trợ DDL trong transaction —
 *   PostgreSQL hỗ trợ; thử nghiệm T-2 trong PR-N2 đo độ hạt thật
 *   của hành vi này thay vì suy đoán).
 * - `down()` NÉM LỖI tường minh: quay lui một migration đã áp
 *   không có SQL DROP ngược chế tác sẵn — quay lui bằng khôi phục
 *   bản sao lưu tiền-migration, không tự bịa câu DROP cho hàng
 *   trăm bảng.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/** Dấu phân tách câu lệnh trong file migration — cùng dấu bộ máy bộ máy cũ dùng. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * Liệt kê tên MỌI migration trong một thư mục (thư mục con chứa
 * `migration.sql`) — gồm cả carrier đóng băng lẫn migration native,
 * sắp tăng dần theo tên: cùng thứ tự mà bộ máy migration cũ áp dụng
 * và cùng hàm ý với `listMigrationFolders` phía fleet. Thư mục
 * không chứa `migration.sql` bị bỏ qua (không phải migration) thay
 * vì làm hỏng cả lượt liệt kê. Hàm này KHÔNG phải là diện carrier:
 * diện carrier là danh sách đóng băng trong `stores.ts`.
 */
export function listMigrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return statSync(join(migrationsDir, name, 'migration.sql')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Tách nội dung một file migration thành các câu lệnh thực thi được (bỏ đoạn rỗng). */
export function splitMigrationSql(content: string): string[] {
  return content
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Provider đọc file SQL migration cho một kho (carrier đóng băng
 * lẫn migration native — Migrator áp mọi tên chưa có trong nhật ký).
 *
 * @param migrationsDir - Đường dẫn TUYỆT ĐỐI tới thư mục migration
 *   của kho (vd `packages/db/migrations/centre`); đường dẫn tương
 *   đối là nguồn gốc của lớp lỗi "sai thư mục làm việc báo thành
 *   công giả" nên provider không tự suy thư mục từ cwd.
 */
export class FrozenSqlProvider implements MigrationProvider {
  constructor(private readonly migrationsDir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    for (const name of listMigrationNames(this.migrationsDir)) {
      const filePath = join(this.migrationsDir, name, 'migration.sql');
      const statements = splitMigrationSql(readFileSync(filePath, 'utf8'));
      migrations[name] = {
        /**
         * Áp migration: thực thi tuần tự từng câu SQL gốc bằng
         * `sql.raw` — chuỗi SQL đi nguyên văn tới PostgreSQL, không
         * qua tham số hoá hay biến đổi nào của query builder.
         */
        up: async (db) => {
          for (const statement of statements) {
            await sql.raw(statement).execute(db);
          }
        },
        /**
         * Migration không có đường quay lui: ném lỗi tường minh thay
         * vì im lặng thành công giả hay chế tác DROP ngược.
         */
        down: async () => {
          throw new Error(
            `Migration ${name} không có down(): quay lui bằng khôi phục bản sao lưu tiền-migration, không chế tác SQL DROP ngược.`,
          );
        },
      };
    }
    return migrations;
  }
}
