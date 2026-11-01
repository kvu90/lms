/**
 * `MigrationProvider` tự viết cho bộ máy migration của `@lms/db`:
 * đọc các file carrier SQL đóng băng trong
 * `packages/db/migrations/<kho>/` và biến mỗi thư mục migration
 * thành một migration Kysely.
 *
 * Vì sao tự viết thay vì `FileMigrationProvider` có sẵn: provider
 * có sẵn đọc file `.ts` chứa mã migration; carrier của hệ là file
 * `.sql` đã áp lên production, phải giữ nguyên từng byte và được
 * thực thi đúng như SQL gốc — không dịch lại, không sinh lại, không
 * bọc thành chuỗi trong file `.ts`.
 *
 * Kỷ luật carrier (giữ nguyên từ thời Drizzle):
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
 * - `down()` của carrier NÉM LỖI tường minh: quay lui một carrier
 *   đã áp không có SQL DROP ngược chế tác sẵn — quay lui bằng
 *   khôi phục bản sao lưu tiền-migration, không tự bịa câu DROP
 *   cho hàng trăm bảng.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Migration, MigrationProvider } from 'kysely/migration';

/** Dấu phân tách câu lệnh trong file carrier — cùng dấu bộ máy Drizzle dùng. */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

/**
 * Liệt kê tên các migration carrier trong một thư mục (thư mục con
 * chứa `migration.sql`), sắp tăng dần theo tên — cùng thứ tự mà bộ
 * máy migration cũ áp dụng và cùng hàm ý với `listMigrationFolders`
 * phía fleet. Thư mục không chứa `migration.sql` bị bỏ qua (không
 * phải migration) thay vì làm hỏng cả lượt liệt kê.
 */
export function listCarrierNames(migrationsDir: string): string[] {
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

/** Tách nội dung một file carrier thành các câu lệnh thực thi được (bỏ đoạn rỗng). */
export function splitCarrierSql(content: string): string[] {
  return content
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Provider đọc carrier SQL đóng băng cho một kho.
 *
 * @param migrationsDir - Đường dẫn TUYỆT ĐỐI tới thư mục carrier
 *   của kho (vd `packages/db/migrations/centre`); đường dẫn tương
 *   đối là nguồn gốc của lớp lỗi "sai thư mục làm việc báo thành
 *   công giả" nên provider không tự suy thư mục từ cwd.
 */
export class FrozenSqlProvider implements MigrationProvider {
  constructor(private readonly migrationsDir: string) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {};
    for (const name of listCarrierNames(this.migrationsDir)) {
      const filePath = join(this.migrationsDir, name, 'migration.sql');
      const statements = splitCarrierSql(readFileSync(filePath, 'utf8'));
      migrations[name] = {
        /**
         * Áp carrier: thực thi tuần tự từng câu SQL gốc bằng
         * `sql.raw` — chuỗi SQL đi nguyên văn tới PostgreSQL, không
         * qua tham số hoá hay biến đổi nào của query builder.
         */
        up: async (db) => {
          for (const statement of statements) {
            await sql.raw(statement).execute(db);
          }
        },
        /**
         * Carrier không có đường quay lui: ném lỗi tường minh thay
         * vì im lặng thành công giả hay chế tác DROP ngược.
         */
        down: async () => {
          throw new Error(
            `Migration carrier ${name} không có down(): quay lui bằng khôi phục bản sao lưu tiền-migration, không chế tác SQL DROP ngược.`,
          );
        },
      };
    }
    return migrations;
  }
}
