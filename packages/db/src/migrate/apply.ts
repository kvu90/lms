/**
 * Trình tự áp migration của một kho — ĐIỂM VÀO DÙNG CHUNG duy nhất
 * của bộ máy migration `@lms/db` cho mọi đường ghi (issue #663):
 * CLI `run.ts` (chuỗi migrate của compose), runner đội kho
 * (`fleet-migration-runner`) và runner cấp phát trung tâm
 * (`space-provision-runner`) đều áp migration qua hàm này, không
 * phía nào tự lắp lại trình tự.
 *
 * Trình tự, theo thứ tự:
 * 1. Bước tiền-migration shim `uuidv7()` cho cụm dưới PostgreSQL 18
 *    (ngoài nội dung carrier, không ghi nhật ký — xem `stores.ts`).
 * 2. `migrateToLatest()` qua `FrozenSqlProvider` trên thư mục
 *    migration của kho (carrier đóng băng + migration native).
 *    Kysely KHÔNG BAO GIỜ ném lỗi từ `migrateToLatest()` — kết quả
 *    trả về `{ error, results }` nên hàm này tự kiểm: `error` khác
 *    rỗng hoặc bất kỳ `results[].status === 'Error'` thì NÉM lỗi
 *    (phía gọi không tự kiểm là mất cổng).
 *
 * Chính sách khe migration theo phía gọi (tuỳ chọn
 * `allowUnorderedMigrations`, mặc định tắt): runner đội kho bật —
 * kho đã có migration mới nhất mà thiếu migration cũ thì áp đúng
 * phần thiếu (hành vi vốn có của runner trước issue #663, được ghim
 * bởi spec hồi quy `fleet-ops.int-spec.ts`); CLI migrate và runner
 * cấp phát giữ mặc định tắt — nhật ký không phải tiền tố đầy đủ là
 * lỗi ồn, không tự lấp.
 *
 * Việc KHÔNG còn ở trình tự này: bước cấy nhật ký (adoption) từ
 * nhật ký của bộ máy cũ. Bước đó chỉ sống trong cửa sổ hai bộ máy
 * cùng tồn tại và đã bị gỡ ở issue #663 cùng toàn bộ mã của bộ máy
 * cũ: mọi kho đang sống đều đã qua adoption ở các pha trước của
 * chiến dịch (kho control plane đã áp migration native — điều chỉ
 * xảy ra sau adoption), và một database chưa từng qua migrator này
 * được coi là chưa áp migration nào — Migrator áp từ đầu; nếu
 * database đó thật ra đã có bảng nghiệp vụ thì câu SQL của carrier
 * lỗi ồn ào ngay (bảng đã tồn tại) thay vì hỏng lặng, và đường khôi
 * phục là khôi phục bản sao lưu như mọi lỗi migration khác.
 */
import type { Kysely } from 'kysely';
import { Migrator, type MigrationResult } from 'kysely/migration';
import { FrozenSqlProvider } from './frozen-sql-provider';
import { installUuidv7Shim, type MigrationStoreKey } from './stores';

/** Kết quả một lượt áp migration của một kho. */
export interface ApplyStoreMigrationsResult {
  /** Bước shim đã cài thật hay bỏ qua vì cụm từ PostgreSQL 18 trở lên. */
  shim: 'installed' | 'skipped-pg18';
  /** Kết quả từng migration mà Migrator đã xét trong lượt này. */
  results: MigrationResult[];
}

/**
 * Áp toàn bộ migration còn thiếu của một kho vào database đích.
 *
 * @param db - Handle Kysely trỏ tới database đích (đã tạo; có thể
 *   chưa áp migration nào).
 * @param store - Kho đang áp (chỉ dùng để thông điệp lỗi rõ kho).
 * @param migrationsDir - Đường dẫn TUYỆT ĐỐI tới thư mục migration
 *   của kho — phía gọi tự phân giải qua package, không suy từ thư
 *   mục làm việc (lớp lỗi "sai thư mục làm việc báo thành công
 *   giả").
 * @returns Kết quả shim + kết quả từng migration đã xét.
 * @throws Error khi có migration áp lỗi — Kysely không ném từ
 *   `migrateToLatest()` nên hàm này chuyển `{ error, results }`
 *   thành ngoại lệ tường minh.
 */
export async function applyStoreMigrations(
  db: Kysely<any>,
  store: MigrationStoreKey,
  migrationsDir: string,
  options?: { allowUnorderedMigrations?: boolean },
): Promise<ApplyStoreMigrationsResult> {
  const shim = await installUuidv7Shim(db);
  const migrator = new Migrator({
    db,
    provider: new FrozenSqlProvider(migrationsDir),
    allowUnorderedMigrations: options?.allowUnorderedMigrations ?? false,
  });
  const { error, results } = await migrator.migrateToLatest();
  const settled = results ?? [];
  if (error || settled.some((result) => result.status === 'Error')) {
    throw new Error(
      `Áp migration cho kho ${store} thất bại: ${error ? (error as Error).message ?? String(error) : 'có migration báo Error'}`,
    );
  }
  return { shim, results: settled };
}
